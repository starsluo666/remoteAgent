//! PTY session 管理：每个 session 一个 PTY，独立读线程；
//! 200KB 环形缓冲 + 递增 seq 支撑 snapshot / 重连回放。

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc::UnboundedSender;
use tracing::{info, warn};

const RING_CAP: usize = 200 * 1024;
const READ_BUF: usize = 32 * 1024;

pub type EventTx = UnboundedSender<(String, SessionEvent)>;

pub enum SessionEvent {
    Output(Vec<u8>, u64),
    Exited(Option<u32>),
    Agent(crate::detector::AgentSnapshot),
}

pub struct Session {
    pub id: String,
    pub cmd: String,
    pub started_at: i64,
    // Option：kill/退出后 take+drop 关闭 ConPTY master，让 reader 线程的阻塞读
    // 返回 EOF 自然退出（否则 Windows 上 conhost 挂着读句柄，线程+句柄泄漏）
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    ring: Mutex<VecDeque<u8>>,
    seq: AtomicU64,
    // M1 单订阅者；M4 多端镜像时改为广播列表
    subscriber: Mutex<Option<EventTx>>,
    // M7: 输出流识别器 + 最近快照（list/api 上报用）
    detector: Mutex<crate::detector::Detector>,
    agent_state: Mutex<Option<crate::detector::AgentSnapshot>>,
}

impl Session {
    pub fn write_input(&self, bytes: &[u8]) -> Result<()> {
        // Windows ConPTY：\x03 写入 master 不会触发 CTRL_C_EVENT（conhost 在
        // ConPTY 模式下不走 processed input；AttachConsole+GenerateConsoleCtrlEvent
        // 实测同样无效）。可行的中断方案 = 终止 shell 的后代进程树（ping/node 等
        // 前台命令），同时仍写入 \x03 兼容自带输入处理的 CLI（如交互式确认行）。
        #[cfg(windows)]
        if bytes.contains(&0x03) {
            let mut plain: Vec<u8> = Vec::with_capacity(bytes.len());
            let mut interrupted = false;
            let pid = self.child.lock().unwrap().process_id().unwrap_or(0);
            for &b in bytes {
                if b == 0x03 {
                    if !plain.is_empty() {
                        self.write_raw(&plain)?;
                        plain.clear();
                    }
                    if !interrupted && pid != 0 {
                        interrupt_foreground(pid);
                        interrupted = true;
                    }
                } else {
                    plain.push(b);
                }
            }
            if !plain.is_empty() {
                self.write_raw(&plain)?;
            }
            // \x03 也照常写入：shell 无前台子进程时由 readline 自行取消当前行
            self.write_raw(&[0x03])?;
            return Ok(());
        }
        self.write_raw(bytes)
    }

    fn write_raw(&self, bytes: &[u8]) -> Result<()> {
        self.writer
            .lock()
            .unwrap()
            .write_all(bytes)
            .context("pty write")
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let guard = self.master.lock().unwrap();
        let master = guard.as_ref().context("pty already closed")?;
        master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .context("pty resize")
    }

    pub fn kill(&self) -> Result<()> {
        // Windows 下命令经 cmd.exe /c 包装，child.kill() 只终止 cmd.exe，
        // 真正的负载进程（codex 等）会变孤儿 —— 先树杀全部后代再杀根。
        #[cfg(windows)]
        {
            let pid = self.child.lock().unwrap().process_id().unwrap_or(0);
            if pid > 0 {
                interrupt_foreground(pid);
            }
        }
        let r = self.child.lock().unwrap().kill().context("pty kill");
        self.close_pty();
        r
    }

    /// 关闭 ConPTY master（幂等）：唤醒阻塞中的 reader 线程，回收句柄
    fn close_pty(&self) {
        if let Some(master) = self.master.lock().unwrap().take() {
            drop(master);
        }
    }

    pub fn set_subscriber(&self, tx: EventTx) {
        *self.subscriber.lock().unwrap() = Some(tx);
    }

    pub fn clear_subscriber(&self) {
        *self.subscriber.lock().unwrap() = None;
    }

    /// 当前缓冲全量 + 已发出的最新 seq；客户端据此续接后续 output。
    pub fn snapshot(&self) -> (Vec<u8>, u64) {
        let ring = self.ring.lock().unwrap();
        (ring.iter().copied().collect(), self.seq.load(Ordering::SeqCst))
    }

    fn push_ring(&self, bytes: &[u8]) {
        let mut ring = self.ring.lock().unwrap();
        ring.extend(bytes.iter().copied());
        let overflow = ring.len().saturating_sub(RING_CAP);
        if overflow > 0 {
            ring.drain(..overflow);
        }
    }
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create(
        self: &Arc<Self>,
        cols: u16,
        rows: u16,
        cwd: Option<&str>,
        cmd: Option<&str>,
    ) -> Result<Arc<Session>> {
        let pty_system = portable_pty::native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .context("openpty")?;

        // 支持带参数的命令（引号感知拆分）；Windows 经 cmd /c 以解析 npm 的 .cmd shim 等
        let mut command = match cmd {
            Some(c) => {
                #[cfg(windows)]
                {
                    let mut cb = CommandBuilder::new("cmd.exe");
                    cb.arg("/c");
                    cb.arg(c);
                    cb
                }
                #[cfg(not(windows))]
                {
                    let mut parts = split_command(c);
                    let mut cb = CommandBuilder::new(
                        parts.next().unwrap_or_default(),
                    );
                    for a in parts {
                        cb.arg(a);
                    }
                    cb
                }
            }
            None => default_shell(),
        };
        if let Some(dir) = cwd {
            command.cwd(dir);
        }
        // 会话环境变量注入（settings.json env，如代理 —— Codex 等需要外网的 Agent）
        for (k, v) in &crate::config::load_settings().env {
            command.env(k, v);
        }

        let child = pair.slave.spawn_command(command).context("spawn pty child")?;
        let mut reader = pair.master.try_clone_reader().context("clone pty reader")?;
        let writer = pair.master.take_writer().context("take pty writer")?;
        drop(pair.slave);

        let id = format!("s_{}", uuid::Uuid::new_v4().simple());
        let cmd_name = cmd.map(str::to_string).unwrap_or_else(default_shell_name);
        let session = Arc::new(Session {
            id: id.clone(),
            cmd: cmd_name.clone(),
            started_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            ring: Mutex::new(VecDeque::new()),
            seq: AtomicU64::new(0),
            subscriber: Mutex::new(None),
            detector: Mutex::new(crate::detector::Detector::new(&cmd_name)),
            agent_state: Mutex::new(None),
        });

        // 子进程退出监听线程：Windows ConPTY 下 conhost 只要读句柄还开着就不会
        // 关管道（读线程可能永远阻塞在 read 上），退出信号必须靠 wait 获得。
        // 注意：不能持锁阻塞在 wait() 里 —— kill() 也需要这把锁，会互相等死。
        // 因此用 try_wait 轮询，每轮短暂持锁。
        let sess = session.clone();
        let sid_wait = id.clone();
        // waiter 退出时直接清理 map 条目：Exited 事件走订阅者通道，无人观看时
        // 会被丢弃 —— 若只靠事件路径清理，死会话会永远留在列表里（且关不掉）
        let mgr_wait = Arc::clone(self);
        std::thread::spawn(move || {
            let mut exit_code = None;
            loop {
                match sess.child.lock().unwrap().try_wait() {
                    Ok(Some(status)) => {
                        exit_code = Some(status.exit_code());
                        break;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        warn!(session = %sid_wait, error = %e, "pty try_wait error");
                        break;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            info!(session = %sid_wait, ?exit_code, "session exited");
            // 进程退出后关闭 master：唤醒可能仍阻塞在 read 上的 reader 线程（句柄回收）
            sess.close_pty();
            // M7：agent 会话标记完成
            if let Some(snap) = sess.detector.lock().unwrap().mark_exited() {
                *sess.agent_state.lock().unwrap() = Some(snap.clone());
                if let Some(tx) = sess.subscriber.lock().unwrap().as_ref() {
                    let _ = tx.send((sid_wait.clone(), SessionEvent::Agent(snap)));
                }
            }
            if let Some(tx) = sess.subscriber.lock().unwrap().as_ref() {
                let _ = tx.send((sid_wait.clone(), SessionEvent::Exited(exit_code)));
            }
            // 无论有没有观看者，条目都清理（事件路径的 remove 是幂等重复）
            mgr_wait.remove(&sid_wait);
        });

        // PTY 输出是阻塞读，放独立线程；产物进环形缓冲并投递给订阅者。
        // 读线程自身不承担退出通知职责（见上）；EOF 后自然结束。
        let sess = session.clone();
        let sid = id.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; READ_BUF];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = buf[..n].to_vec();
                        sess.push_ring(&chunk);
                        let seq = sess.seq.fetch_add(1, Ordering::SeqCst) + 1;
                        // M7：输出流识别 agent 状态，变化即上报
                        if let Some(snap) = sess.detector.lock().unwrap().feed(&chunk) {
                            *sess.agent_state.lock().unwrap() = Some(snap.clone());
                            if let Some(tx) = sess.subscriber.lock().unwrap().as_ref() {
                                let _ = tx.send((sid.clone(), SessionEvent::Agent(snap)));
                            }
                        }
                        if let Some(tx) = sess.subscriber.lock().unwrap().as_ref() {
                            let _ = tx.send((sid.clone(), SessionEvent::Output(chunk, seq)));
                        }
                    }
                    Err(e) => {
                        warn!(session = %sid, error = %e, "pty read error");
                        break;
                    }
                }
            }
        });

        self.sessions
            .lock()
            .unwrap()
            .insert(id.clone(), session.clone());
        info!(session = %id, cmd = %session.cmd, "session created");
        Ok(session)
    }

    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(id).cloned()
    }

    pub fn remove(&self, id: &str) {
        self.sessions.lock().unwrap().remove(id);
    }

    pub fn list(&self) -> Vec<crate::protocol::SessionInfo> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .map(|s| {
                let snap = s.agent_state.lock().unwrap().clone();
                crate::protocol::SessionInfo {
                    id: s.id.clone(),
                    cmd: s.cmd.clone(),
                    started_at: s.started_at,
                    agent: snap.as_ref().map(|x| x.agent.clone()),
                    agent_status: snap.as_ref().map(|x| match &x.status {
                        crate::detector::AgentStatus::Starting => "starting".to_string(),
                        crate::detector::AgentStatus::Working => "working".to_string(),
                        crate::detector::AgentStatus::Error => "error".to_string(),
                        crate::detector::AgentStatus::Finished => "finished".to_string(),
                    }),
                    agent_detail: snap.as_ref().map(|x| x.detail.clone()),
                }
            })
            .collect()
    }

    /// 连接断开时清掉所有订阅者；session 与缓冲继续存活，等重连 attach。
    pub fn clear_subscribers(&self) {
        for s in self.sessions.lock().unwrap().values() {
            s.clear_subscriber();
        }
    }
}

fn default_shell() -> CommandBuilder {
    if cfg!(windows) {
        CommandBuilder::new("powershell.exe")
    } else {
        CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "bash".into()))
    }
}

fn default_shell_name() -> String {
    if cfg!(windows) {
        "powershell".into()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "bash".into())
    }
}

/// 中断 shell 的前台命令（Windows）：终止 root 的全部后代进程。
/// 依赖 toolhelp32 快照枚举父子关系，递归收集后代后 TerminateProcess。
/// shell 自身（root）不受影响 —— 杀完后它回到提示符等待下一条命令。
#[cfg(windows)]
fn interrupt_foreground(root: u32) {
    #[repr(C)]
    struct Entry {
        size: u32,
        usage: u32,
        pid: u32,
        heap_base: isize,
        module_id: u32,
        threads: u32,
        parent_pid: u32,
        pri: i32,
        flags: u32,
        exe: [u16; 260],
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> isize;
        fn Process32FirstW(snap: isize, entry: *mut Entry) -> i32;
        fn Process32NextW(snap: isize, entry: *mut Entry) -> i32;
        fn CloseHandle(h: isize) -> i32;
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn TerminateProcess(h: isize, code: u32) -> i32;
    }
    const TH32CS_SNAPPROCESS: u32 = 2;
    const PROCESS_TERMINATE: u32 = 1;

    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == -1 {
            warn!("CreateToolhelp32Snapshot failed");
            return;
        }
        let mut procs: Vec<(u32, u32)> = Vec::new(); // (pid, parent_pid)
        let mut e: Entry = std::mem::zeroed();
        e.size = std::mem::size_of::<Entry>() as u32;
        if Process32FirstW(snap, &mut e) != 0 {
            loop {
                procs.push((e.pid, e.parent_pid));
                if Process32NextW(snap, &mut e) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);

        let mut doomed: Vec<u32> = Vec::new();
        let mut frontier = vec![root];
        while let Some(p) = frontier.pop() {
            for &(pid, parent) in &procs {
                if parent == p && pid != root && !doomed.contains(&pid) {
                    doomed.push(pid);
                    frontier.push(pid);
                }
            }
        }
        let mut killed = 0;
        for pid in &doomed {
            let h = OpenProcess(PROCESS_TERMINATE, 0, *pid);
            if h != 0 && TerminateProcess(h, 1) != 0 {
                killed += 1;
            }
        }
        info!(root, killed, total_descendants = doomed.len(), "interrupt: terminated foreground children");
    }
}

/// 引号感知的命令拆分（unix 用）：`codex exec "fix it"` → [codex, exec, "fix it"]
#[cfg(not(windows))]
fn split_command(s: &str) -> impl Iterator<Item = String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_quote = false;
    for ch in s.chars() {
        match ch {
            '"' => in_quote = !in_quote,
            c if c.is_whitespace() && !in_quote => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out.into_iter()
}
