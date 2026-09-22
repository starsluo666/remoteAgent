//! AI Agent 输出识别器（M7）：从 PTY 输出流推断 Codex 等会话的运行状态。
//! 规则来源：本机真实采集（Codex CLI v0.155.0 exec 模式，经代理完整生命周期）。
//! 匹配采用单调游标：只认"新出现"的特征，历史特征不会把状态打回去。

use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Starting,
    Working,
    Error,
    Finished,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentSnapshot {
    pub agent: String,
    pub status: AgentStatus,
    pub detail: String,
}

/// Codex CLI 特征表（v0.155 实测）：
/// - banner "OpenAI Codex"  → Starting（同时确认 agent；exec 模式打印
///   "OpenAI Codex v0.155.0"，交互式 TUI 画框打印 ">_ OpenAI Codex (v0.155.0)"，
///   故不带版本号前缀匹配）
/// - 行 "user"              → Working（任务已提交）
/// - 行 "codex"             → Working（回答输出中，detail 区分）
/// - "tokens used"          → Finished（exec 完成统计）
/// - "ERROR"                → Error（内部日志 / Reconnecting）
const CODEX_MARKERS: &[(&str, AgentStatus)] = &[
    ("OpenAI Codex", AgentStatus::Starting),
    ("\nuser\n", AgentStatus::Working),
    ("\ncodex\n", AgentStatus::Working),
    ("tokens used", AgentStatus::Finished),
    ("ERROR", AgentStatus::Error),
];

/// ANSI 剥离状态机阶段
const PLAIN: u8 = 0;
const ESC: u8 = 1;
const CSI: u8 = 2;
const OSC: u8 = 3;

pub struct Detector {
    agent: Option<String>,
    status: Option<AgentStatus>,
    detail: String,
    tail: String,
    phase: AtomicU8,
    osc_depth: usize,
    /// 每个特征的单调游标（只向后匹配，防止历史特征重复触发）
    cursors: Vec<usize>,
}

const TAIL_CAP: usize = 16 * 1024;

impl Detector {
    /// cmd 用于预判 agent（如 "codex ..."）；真正确认靠输出特征
    pub fn new(cmd: &str) -> Self {
        let agent = cmd
            .split_whitespace()
            .next()
            .filter(|p| p.contains("codex"))
            .map(|_| "codex".to_string());
        Self {
            agent,
            status: None,
            detail: String::new(),
            tail: String::new(),
            phase: AtomicU8::new(PLAIN),
            osc_depth: 0,
            cursors: Vec::new(),
        }
    }

    fn markers(&self) -> &'static [(&'static str, AgentStatus)] {
        match self.agent.as_deref() {
            Some("codex") => CODEX_MARKERS,
            _ => &[],
        }
    }

    pub fn snapshot(&self) -> Option<AgentSnapshot> {
        self.agent.as_ref().map(|a| AgentSnapshot {
            agent: a.clone(),
            status: self.status.clone().unwrap_or(AgentStatus::Starting),
            detail: self.detail.clone(),
        })
    }

    /// 进程退出：agent 会话标记完成
    pub fn mark_exited(&mut self) -> Option<AgentSnapshot> {
        if self.agent.is_none() || self.status.as_ref() == Some(&AgentStatus::Finished) {
            return None;
        }
        self.status = Some(AgentStatus::Finished);
        self.detail = "process exited".into();
        self.snapshot()
    }

    /// 喂入输出块；状态变化时返回新快照
    pub fn feed(&mut self, chunk: &[u8]) -> Option<AgentSnapshot> {
        let stripped = self.strip_ansi(chunk);
        self.tail.push_str(&stripped);
        if self.tail.len() > TAIL_CAP {
            let cut = self.tail.len() - TAIL_CAP;
            self.tail.replace_range(..cut, "");
            // 窗口左移，游标同步回退（饱和到 0）
            for c in &mut self.cursors {
                *c = c.saturating_sub(cut);
            }
        }

        if self.agent.is_none() {
            return None;
        }
        let markers = self.markers();
        if self.cursors.len() != markers.len() {
            self.cursors = vec![0; markers.len()];
        }

        // 收集本轮新命中的特征（游标单调推进）
        let mut hits: Vec<(usize, usize)> = Vec::new(); // (绝对位置, marker 下标)
        for (i, (needle, _)) in markers.iter().enumerate() {
            let from = self.cursors[i];
            if let Some(rel) = self.tail[from..].find(needle) {
                let abs = from + rel;
                hits.push((abs, i));
                self.cursors[i] = abs + needle.len();
            }
        }
        if hits.is_empty() {
            return None;
        }

        // 按出现顺序应用，终态即最后一个
        hits.sort_unstable();
        let mut changed = false;
        for (abs, i) in hits {
            let (_, st) = &markers[i];
            let same = self.status.as_ref() == Some(st);
            if same && st != &AgentStatus::Working {
                continue;
            }
            self.status = Some(st.clone());
            let needle_len = markers[i].0.len();
            // 截断偏移回退到字符边界：detail 尾部落进多字节字符（中文/制表框线）中间会 panic
            let mut end = (abs + needle_len + 60).min(self.tail.len());
            while end > abs && !self.tail.is_char_boundary(end) {
                end -= 1;
            }
            self.detail = self.tail[abs..end].replace('\n', " ");
            changed = true;
        }
        if changed {
            self.snapshot()
        } else {
            None
        }
    }

    /// ANSI/OSC 剥离 + CR 丢弃（统一 \n 行尾）；跨 chunk 状态保持
    fn strip_ansi(&mut self, chunk: &[u8]) -> String {
        let mut out = Vec::with_capacity(chunk.len());
        for &b in chunk {
            let phase = self.phase.load(Ordering::Relaxed);
            match phase {
                PLAIN => {
                    if b == 0x1b {
                        self.phase.store(ESC, Ordering::Relaxed);
                    } else if b != b'\r' {
                        out.push(b);
                    }
                }
                ESC => {
                    if b == b'[' {
                        self.phase.store(CSI, Ordering::Relaxed);
                    } else if b == b']' {
                        self.phase.store(OSC, Ordering::Relaxed);
                        self.osc_depth = 0;
                    } else {
                        self.phase.store(PLAIN, Ordering::Relaxed);
                    }
                }
                CSI => {
                    if (0x40..=0x7e).contains(&b) {
                        self.phase.store(PLAIN, Ordering::Relaxed);
                    }
                }
                OSC => {
                    if b == 0x07 {
                        self.phase.store(PLAIN, Ordering::Relaxed);
                    } else if b == 0x1b {
                        self.osc_depth += 1;
                    } else if b == b'\\' && self.osc_depth > 0 {
                        self.phase.store(PLAIN, Ordering::Relaxed);
                    }
                }
                _ => unreachable!(),
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实采集的 Codex v0.155 输出（带 ANSI）驱动完整状态机
    #[test]
    fn codex_lifecycle() {
        let mut d = Detector::new("codex exec ...");
        let banner = concat!(
            "\u{1b}[?25l\u{1b}[2JOpenAI Codex v0.155.0\r\n",
            "--------\r\nworkdir: C:/x\r\n",
        );
        let snap = d.feed(banner.as_bytes()).expect("banner → Starting");
        assert_eq!(snap.agent, "codex");
        assert_eq!(snap.status, AgentStatus::Starting);

        let b = d.feed(b"--------\r\nuser\r\n\"task\"\r\n").expect("user → Working");
        assert_eq!(b.status, AgentStatus::Working);

        // 回答段：同为 Working，但 detail 更新（视为变化上报）
        assert!(d.feed(b"codex\r\n\xe5\xa5\xbd\xe7\x9a\x84\r\n").is_some());

        let fin = d.feed(b"tokens used\r\n3,647\r\n").expect("tokens used → Finished");
        assert_eq!(fin.status, AgentStatus::Finished);
        assert!(fin.detail.contains("tokens used"));
    }

    /// 交互式 TUI 的画框 banner（实测：>_ OpenAI Codex (v0.155.0)）也要识别
    #[test]
    fn codex_tui_banner() {
        let mut d = Detector::new("codex");
        let tui = concat!(
            "\u{1b}[?1049h\u{1b}[2J╭────────────╮\r\n",
            "│ >_ OpenAI Codex (v0.155.0)   │\r\n",
            "│ model: loading               │\r\n",
            "╰────────────╯\r\n",
        );
        let snap = d.feed(tui.as_bytes()).expect("TUI banner → Starting");
        assert_eq!(snap.agent, "codex");
        assert_eq!(snap.status, AgentStatus::Starting);
    }

    /// 历史 banner 不会把已推进的状态打回去
    #[test]
    fn no_backward_transition() {
        let mut d = Detector::new("codex exec");
        d.feed(b"OpenAI Codex v0.155.0\r\nuser\r\n");
        let e = d.feed(b"ERROR: Reconnecting... 2/5\r\n").expect("ERROR → Error");
        assert_eq!(e.status, AgentStatus::Error);
    }

    /// 普通 shell 不识别
    #[test]
    fn plain_shell_no_agent() {
        let mut d = Detector::new("powershell");
        assert!(d.feed(b"PS C:/Users> echo hi\r\n").is_none());
        assert!(d.snapshot().is_none());
    }
}
