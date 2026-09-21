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
    Output(Vec<u8>),
    Exited(Option<u32>),
}

pub struct Session {
    pub id: String,
    pub cmd: String,
    pub started_at: i64,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    ring: Mutex<VecDeque<u8>>,
    seq: AtomicU64,
    // M1 单订阅者；M4 多端镜像时改为广播列表
    subscriber: Mutex<Option<EventTx>>,
}

impl Session {
    pub fn write_input(&self, bytes: &[u8]) -> Result<()> {
        self.writer
            .lock()
            .unwrap()
            .write_all(bytes)
            .context("pty write")
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .lock()
            .unwrap()
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .context("pty resize")
    }

    pub fn kill(&self) -> Result<()> {
        self.child.lock().unwrap().kill().context("pty kill")
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
        &self,
        cols: u16,
        rows: u16,
        cwd: Option<&str>,
        cmd: Option<&str>,
    ) -> Result<Arc<Session>> {
        let pty_system = portable_pty::native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .context("openpty")?;

        let mut command = match cmd {
            Some(c) => CommandBuilder::new(c),
            None => default_shell(),
        };
        if let Some(dir) = cwd {
            command.cwd(dir);
        }

        let child = pair.slave.spawn_command(command).context("spawn pty child")?;
        let mut reader = pair.master.try_clone_reader().context("clone pty reader")?;
        let writer = pair.master.take_writer().context("take pty writer")?;
        drop(pair.slave);

        let id = format!("s_{}", uuid::Uuid::new_v4().simple());
        let cmd_name = cmd.map(str::to_string).unwrap_or_else(default_shell_name);
        let session = Arc::new(Session {
            id: id.clone(),
            cmd: cmd_name,
            started_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            ring: Mutex::new(VecDeque::new()),
            seq: AtomicU64::new(0),
            subscriber: Mutex::new(None),
        });

        // 子进程退出监听线程：Windows ConPTY 下 conhost 只要读句柄还开着就不会
        // 关管道（读线程可能永远阻塞在 read 上），退出信号必须靠 wait 获得。
        // 注意：不能持锁阻塞在 wait() 里 —— kill() 也需要这把锁，会互相等死。
        // 因此用 try_wait 轮询，每轮短暂持锁。
        let sess = session.clone();
        let sid_wait = id.clone();
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
            if let Some(tx) = sess.subscriber.lock().unwrap().as_ref() {
                let _ = tx.send((sid_wait, SessionEvent::Exited(exit_code)));
            }
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
                        sess.seq.fetch_add(1, Ordering::SeqCst);
                        if let Some(tx) = sess.subscriber.lock().unwrap().as_ref() {
                            let _ = tx.send((sid.clone(), SessionEvent::Output(chunk)));
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
            .map(|s| crate::protocol::SessionInfo {
                id: s.id.clone(),
                cmd: s.cmd.clone(),
                started_at: s.started_at,
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
