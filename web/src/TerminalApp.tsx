// 终端工作区：连接 daemon（本地或经中继）→ 侧栏设备卡片 / 顶部会话标签页 → 每 session 一个 xterm。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { DaemonConnection, type Status } from './lib/daemon';
import { b64encode, type SessionInfo } from './lib/protocol';
import Connect, { saveConn } from './Connect';
import { target, mergedParams } from './lib/target';
import { LOCAL_BASE } from './lib/local';
import { notify } from './lib/notify';
import './App.css';

interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  ended: boolean;
}

const termTheme = {
  background: '#0a0c10',
  foreground: '#d6dce5',
  cursor: '#10b981',
  selectionBackground: '#2f6f5e88',
};

function IconMonitor() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="3.5" width="19" height="13" rx="2" />
      <path d="M8.5 20.5h7M12 16.5v4" />
    </svg>
  );
}
function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function IconX() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
function IconLink() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11.5 4.4" />
      <path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07l1.3-1.29" />
    </svg>
  );
}
function IconRefresh() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}
function IconLock() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
function IconTerminal() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 7.5l4 4.5-4 4.5M12 16.5h7" />
    </svg>
  );
}

/** 无参数落地页逻辑已移至 App.tsx（Shell / Connect） */

export default function TerminalApp() {
  const termsRef = useRef<Map<string, TermEntry>>(new Map());
  const connRef = useRef<DaemonConnection | null>(null);
  const activeRef = useRef<string | null>(null);
  const bootstrappedRef = useRef(false);
  const hostRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const wrapRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  // 终端 DOM 挂载前到达的快照/输出缓冲：attach 回执往往快于 React 渲染，
  // 丢弃会导致本地直连（低延迟）下终端空白
  const pendingRef = useRef<Map<string, Uint8Array[]>>(new Map());
  // 按 session 的输出序号（防中继重放/乱序注入；快照重置基线）
  const lastSeqRef = useRef<Map<string, number>>(new Map());
  // M7: agent 状态（识别 Codex 等会话的运行状态）
  const [agentSnap, setAgentSnap] = useState<{ sid: string; agent: string; status: string; detail: string } | null>(null);

  const t = useMemo(() => target(), []);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [deviceOnline, setDeviceOnline] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const savedConnRef = useRef(false);
  // 断线重连：尝试计数（横幅显示 + 指数退避）
  const attemptsRef = useRef(0);
  const [attempts, setAttempts] = useState(0);
  // 观察/接管：观察模式拦截键盘输入（防误触打断 AI）；触屏设备默认观察。
  // 面板入口带 takeover=1 时强制接管（如概览页「接管输入」按钮）
  const isTouch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  const forceTakeover = mergedParams().get('takeover') === '1';
  const [takeover, setTakeover] = useState(!isTouch || forceTakeover);
  const takeoverRef = useRef(!isTouch || forceTakeover);
  const setMode = (v: boolean) => {
    takeoverRef.current = v;
    setTakeover(v);
  };
  const [mobileInput, setMobileInput] = useState('');
  // 观察模式吞键盘的提示节流（可打印字符才提示）
  const lastObserveHintRef = useRef(0);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  // 向当前会话发送原始字节（暂停 Ctrl+C / Esc / 移动输入条等）
  const sendRaw = useCallback((bytes: string) => {
    const conn = connRef.current;
    const sid = activeRef.current;
    if (!conn || !sid) return;
    conn.send({ t: 'input', sessionId: sid, data: b64encode(bytes) });
  }, []);

  const sendMobileLine = useCallback(() => {
    const line = mobileInput;
    if (!line) return;
    sendRaw(line + '\r');
    setMobileInput('');
  }, [mobileInput, sendRaw]);

  /** 字号实时调节（移动栏 A-/A+）：写入偏好并对全部已开终端即时生效 + 重算尺寸 */
  const adjustFont = useCallback((delta: number) => {
    const next = Math.min(22, Math.max(10, (Number(localStorage.getItem('ra.termFontSize')) || 14) + delta));
    localStorage.setItem('ra.termFontSize', String(next));
    for (const { term, fit } of termsRef.current.values()) {
      term.options.fontSize = next;
      fit.fit();
    }
    const sid = activeRef.current;
    const conn = connRef.current;
    const entry = sid ? termsRef.current.get(sid) : null;
    if (conn && sid && entry) {
      conn.send({ t: 'resize', sessionId: sid, cols: entry.term.cols, rows: entry.term.rows });
    }
  }, []);

  const refetchSessions = useCallback(async (conn: DaemonConnection) => {
    const m = await conn.request({ t: 'session.list' });
    if (m.t === 'session.list.result') {
      setSessions(m.sessions);
    }
  }, []);

  // 给 session 创建（或复用）xterm 实例并 attach
  const attachSession = useCallback(async (conn: DaemonConnection, sessionId: string) => {
    const m = await conn.request({ t: 'session.attach', sessionId });
    if (m.t === 'session.attached') {
      const entry = termsRef.current.get(sessionId);
      if (entry) entry.ended = false;
      setActive(sessionId);
      activeRef.current = sessionId;
    }
  }, []);

  const createSession = useCallback(
    async (conn: DaemonConnection, cmd?: string) => {
      const entry = termsRef.current.get(activeRef.current ?? '');
      const cols = entry?.term.cols ?? 100;
      const rows = entry?.term.rows ?? 30;
      const m = await conn.request({ t: 'session.create', cols, rows, ...(cmd ? { cmd } : {}) });
      if (m.t === 'session.created') {
        await refetchSessions(conn);
        await attachSession(conn, m.sessionId);
      }
    },
    [attachSession, refetchSessions],
  );

  const killSession = useCallback(
    async (sid: string) => {
      const conn = connRef.current;
      if (!conn) return;
      await conn.request({ t: 'session.kill', sessionId: sid });
      // 已死会话不会再有 exited 事件驱动刷新 —— kill 后主动拉列表清 tab
      await refetchSessions(conn);
    },
    [refetchSessions],
  );

  // 引导 / 重连恢复：列出全部 session，全部 attach（snapshot 恢复各自的终端画面）。
  // ?new=<cmd>（快速启动卡片带入）在首次连接时消费一次：拉起指定命令的会话
  const pendingNewRef = useRef<string | null>(mergedParams().get('new'));
  const bootstrap = useCallback(
    async (conn: DaemonConnection) => {
      const m = await conn.request({ t: 'session.list' });
      if (m.t !== 'session.list.result') return;
      setSessions(m.sessions);
      if (!bootstrappedRef.current) {
        bootstrappedRef.current = true;
        const pending = pendingNewRef.current;
        pendingNewRef.current = null;
        if (pending) {
          await createSession(conn, pending);
          return;
        }
        if (m.sessions.length === 0) {
          await createSession(conn);
          return;
        }
      }
      // 重连或已有 session：全部 attach 恢复；激活记忆中的或第一个
      for (const s of m.sessions) await attachSession(conn, s.id);
      const cur = activeRef.current;
      const alive = m.sessions.some((s) => s.id === cur);
      const pick = alive ? (cur as string) : m.sessions[0]?.id;
      if (pick) {
        setActive(pick);
        activeRef.current = pick;
      } else {
        setSessions([]);
      }
    },
    [attachSession, createSession],
  );

  const bootstrapRef = useRef<() => void>(() => {});
  useEffect(() => {
    bootstrapRef.current = () => {
      const conn = connRef.current;
      if (conn) void bootstrap(conn);
    };
  }, [bootstrap]);

  // 全私有模型：中继不提供设备列表，侧栏只显示当前连接的设备

  useEffect(() => {
    if (!t) return;
    if (!wrapRef.current) return;

    const conn = new DaemonConnection(t.url, t.hello, {
      onStatus: (s) => {
        setStatus((prev) => {
          // 断→通转换时提示恢复（首次连接不打扰）
          if (prev === 'disconnected' && s === 'ready') showToast('连接已恢复，会话画面自动同步');
          return s;
        });
        if (s === 'ready') {
          attemptsRef.current = 0;
          setAttempts(0);
          bootstrapRef.current();
          // 连接成功后记住这次配对，连接页可一键重连
          if (!savedConnRef.current) {
            savedConnRef.current = true;
            let relayHost = location.host;
            try {
              if (t.mode === 'relay') relayHost = new URL(t.url).host;
            } catch {
              /* 保底用当前站点 */
            }
            saveConn({
              url: location.href,
              relayHost,
              deviceId: t.hello.deviceId,
              savedAt: Date.now(),
            });
          }
        }
        if (s === 'disconnected') {
          setDeviceOnline(true);
          // 指数退避 1s→10s；手机后台冻结计时器，靠 visibilitychange 兜底立即重试
          attemptsRef.current += 1;
          setAttempts(attemptsRef.current);
          const delay = Math.min(1000 * 2 ** (attemptsRef.current - 1), 10000);
          retryTimer = window.setTimeout(() => connRef.current?.connect(), delay);
        }
      },
      onPresence: (_id, online) => setDeviceOnline(online),
      onSnapshot: (sid, data, seq) => {
        lastSeqRef.current.set(sid, seq); // 快照即基线，之后的 output 必须严格大于
        const entry = termsRef.current.get(sid);
        if (!entry) {
          pendingRef.current.set(sid, [data]); // 快照整块替换语义，覆盖旧缓冲
          return;
        }
        entry.term.reset();
        entry.term.write(data);
      },
      onOutput: (sid, data, seq) => {
        // 重放/乱序防护：seq 不大于已见最大值即丢弃
        const last = lastSeqRef.current.get(sid);
        if (last !== undefined && seq <= last) return;
        lastSeqRef.current.set(sid, seq);
        const entry = termsRef.current.get(sid);
        if (!entry) {
          const buf = pendingRef.current.get(sid) ?? [];
          buf.push(data);
          pendingRef.current.set(sid, buf);
          return;
        }
        entry.term.write(data);
      },
      onAgentStatus: (sid, agent, status, detail) => {
        setAgentSnap({ sid, agent, status, detail });
        // 桌面通知：任务完成/出错且应用不可见时提醒（长任务挂机场景）
        const name = agent === 'codex' ? 'Codex' : agent === 'claude' ? 'Claude Code' : agent;
        if (status === 'finished') {
          notify(`✅ ${name} 已完成`, detail ? detail.slice(0, 80) : '任务结束', `ai-${sid}`);
        } else if (status === 'error') {
          notify(`⚠️ ${name} 出错`, detail ? detail.slice(0, 80) : '请查看终端', `ai-${sid}`);
        }
      },
      onExited: (sid) => {
        setAgentSnap((cur) => (cur?.sid === sid ? { ...cur, status: 'finished', detail: 'process exited' } : cur));
        pendingRef.current.delete(sid);
        const entry = termsRef.current.get(sid);
        if (entry) entry.ended = true;
        notify('RemoteAgent 会话已退出', `会话 #${sid.slice(2, 8)} 的进程已结束`, `exit-${sid}`);
        const conn = connRef.current;
        if (conn) void refetchSessions(conn);
      },
      onError: (code, msg) => {
        if (
          code === 'auth_failed' ||
          code === 'device_busy' ||
          code === 'local_busy' ||
          code === 'decrypt_failed'
        ) {
          connRef.current?.close();
        }
        const entry = activeRef.current ? termsRef.current.get(activeRef.current) : null;
        entry?.term.writeln(`\r\n\x1b[31m[${code}] ${msg}\x1b[0m`);
      },
    });
    connRef.current = conn;
    conn.connect();

    let retryTimer: number | undefined;

    const ro = new ResizeObserver(() => {
      const sid = activeRef.current;
      const entry = sid ? termsRef.current.get(sid) : null;
      if (!entry) return;
      const before = `${entry.term.cols}x${entry.term.rows}`;
      entry.fit.fit();
      if (`${entry.term.cols}x${entry.term.rows}` === before) return;
      conn.send({ t: 'resize', sessionId: sid!, cols: entry.term.cols, rows: entry.term.rows });
    });
    ro.observe(wrapRef.current);

    // 手机后台会冻结重连计时器：回到前台立即补一次连接尝试
    const onVisible = () => {
      if (document.visibilityState === 'visible') connRef.current?.connect();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.clearTimeout(retryTimer);
      window.clearTimeout(toastTimer.current);
      ro.disconnect();
      conn.close();
      for (const { term } of termsRef.current.values()) term.dispose();
      termsRef.current.clear();
      pendingRef.current.clear();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 切换 session：fit + resize + 聚焦
  useEffect(() => {
    const entry = active ? termsRef.current.get(active) : null;
    if (!entry || !wrapRef.current) return;
    const sid = active;
    requestAnimationFrame(() => {
      entry.fit.fit();
      entry.term.focus();
      const conn = connRef.current;
      if (conn && !entry.ended) {
        conn.send({ t: 'resize', sessionId: sid, cols: entry.term.cols, rows: entry.term.rows });
      }
    });
  }, [active, sessions]);

  // 激活的会话被关闭/从列表消失 → 自动切到剩余的第一个（关闭死会话场景）
  useEffect(() => {
    if (active && sessions.length > 0 && !sessions.some((s) => s.id === active)) {
      const next = sessions[0].id;
      setActive(next);
      activeRef.current = next;
    }
  }, [sessions, active]);

  // host div 挂载回调：为 session 创建 xterm（首次渲染该 div 时）
  const hostCallback = useCallback(
    (sid: string) => (el: HTMLDivElement | null) => {
      if (!el) {
        hostRefs.current.delete(sid);
        return;
      }
      hostRefs.current.set(sid, el);
      if (!termsRef.current.has(sid)) {
        const term = new Terminal({
          fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, "Courier New", monospace',
          fontSize: Number(localStorage.getItem('ra.termFontSize')) || 14,
          scrollback: Number(localStorage.getItem('ra.termScrollback')) || 5000,
          cursorBlink: true,
          theme: termTheme,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(el);
        const entry: TermEntry = { term, fit, ended: false };
        termsRef.current.set(sid, entry);
        // 回放挂载前缓冲的快照/输出（顺序即到达顺序；新终端本为空白，直接写即正确）
        const pending = pendingRef.current.get(sid);
        if (pending) {
          pendingRef.current.delete(sid);
          for (const chunk of pending) term.write(chunk);
        }
        term.onData((d) => {
          // 观察模式：只看不发（防误触打断 AI；接管由模式开关显式开启）。
          // 可打印按键给一次提示 —— 静默吞键盘会让用户以为"按啥都不管用"
          if (!takeoverRef.current) {
            if (/^[\x20-\x7e\u4e00-\u9fa5]$/.test(d)) {
              const now = Date.now();
              if (now - lastObserveHintRef.current > 4000) {
                lastObserveHintRef.current = now;
                showToast('👁 观察模式：输入已拦截，点「⌨ 接管」后可输入');
              }
            }
            return;
          }
          const conn = connRef.current;
          if (conn && activeRef.current === sid && !entry.ended) {
            conn.send({ t: 'input', sessionId: sid, data: b64encode(d) });
          }
        });
        if (activeRef.current === sid) {
          requestAnimationFrame(() => {
            fit.fit();
            term.focus();
          });
        }
      }
    },
    [],
  );

  const copyPairLink = useCallback(() => {
    const text = location.href;
    const fallbackCopy = () => {
      // clipboard API 不可用时（部分移动浏览器 / 嵌入式 webview）的传统兜底
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
      return ok;
    };
    const ok = "配对链接已复制，发给新设备即可接入";
    navigator.clipboard
      .writeText(text)
      .then(() => showToast(ok))
      .catch(async () => {
        if (fallbackCopy()) {
          showToast(ok);
          return;
        }
        // 手机浏览器剪贴板受限时走系统分享面板
        if (navigator.share) {
          try {
            await navigator.share({ title: "RemoteAgent 配对链接", url: text });
            return;
          } catch {
            /* 用户取消或分享失败，落到手动提示 */
          }
        }
        showToast("复制失败，请手动复制地址栏链接");
      });
  }, [showToast]);

  const manualReconnect = useCallback(() => {
    connRef.current?.reconnect();
  }, []);

  const activeEntry = active ? termsRef.current.get(active) : null;
  const online = deviceOnline && status === 'ready';

  // 路由保证 t 非空（App.tsx 已分流）；防御性兜底
  if (!t) return null;

  const statusBadge = !deviceOnline
    ? { cls: 'off', text: '离线' }
    : status === 'ready'
      ? { cls: 'on', text: '在线' }
      : status === 'connecting'
        ? { cls: 'wait', text: '连接中…' }
        : { cls: 'wait', text: '重连中…' };
  const deviceList = [{ deviceId: t.hello.deviceId, online: deviceOnline }];
  const currentDeviceName = '本机设备';

  return (
    <div className="layout">
      <aside className="side">
        <div className="brand">
          <div className="logo">
            <IconTerminal />
          </div>
          <div className="brand-text">
            <div className="brand-name">RemoteAgent</div>
            <div className="brand-ver">v0.1 · AI 终端遥控</div>
          </div>
        </div>

        {/* 桌面壳没有浏览器后退键，终端里提供显式的回面板入口 */}
        {LOCAL_BASE && (
          <button className="back-panel" onClick={() => location.assign(location.pathname)}>
            ← 返回面板
          </button>
        )}

        <div className="side-section">
          <div className="section-title">我的设备</div>
          <div className="device-list">
            {deviceList.map((d) => {
              const cur = d.deviceId === t.hello.deviceId;
              return (
                <div key={d.deviceId} className={`device-card ${cur ? 'current' : ''} ${d.online ? 'on' : 'off'}`}>
                  <div className="device-ico">
                    <IconMonitor />
                  </div>
                  <div className="device-info">
                    <div className="device-name">
                      {cur ? currentDeviceName : d.deviceId.length > 12 ? d.deviceId.slice(0, 8) : d.deviceId}
                      {cur && <span className="device-badge">已连接</span>}
                    </div>
                    <div className="device-sub">
                      <span className={`dot ${d.online ? 'ok' : 'bad'}`} />
                      {d.online ? '在线' : '离线'}
                      <span className="device-mac">{d.deviceId.length > 12 ? d.deviceId.slice(0, 8) : d.deviceId}</span>
                    </div>
                  </div>
                </div>
              );
            })}
            <button
              className="add-device"
              onClick={() => setConnectOpen(true)}
              title="粘贴另一台设备的配对链接，连接后在此切换"
            >
              <IconPlus />
              添加新设备
            </button>
          </div>
        </div>

        <div className="side-foot">
          <IconLock />
          <span>{t.mode === 'relay' ? '中继转发 · 端到端加密' : '本地直连 · 环回地址'}</span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="tb-left">
            <div className="tb-ico">
              <IconMonitor />
            </div>
            <div className="tb-title">
              <div className="tb-name">
                {currentDeviceName}
                <span className={`badge ${statusBadge.cls}`}>
                  <span className="dot" />
                  {statusBadge.text}
                </span>
              </div>
              <div className="tb-sub">
                {t.mode === 'relay' ? '中继连接 · 端到端加密 · 中继不可读' : '本地直连 · 127.0.0.1'}
              </div>
            </div>
          </div>
          <div className="tb-actions">
            {t.mode === 'relay' && (
              <button className="icon-btn" title="复制配对链接" onClick={copyPairLink}>
                <IconLink />
              </button>
            )}
            <button
              className="icon-btn"
              title="重新连接"
              onClick={manualReconnect}
              disabled={status === 'connecting'}
            >
              <IconRefresh />
            </button>
          </div>
        </header>

        {/* 断线横幅：明确告知输出已暂停，并提供手动重连（自动退避仍在进行） */}
        {status === 'disconnected' && (
          <div className="conn-banner">
            <span className={`dot ${statusBadge.cls}`} />
            <span>
              连接已断开，正在重连…
              {attempts > 1 && <span className="cb-attempts">（第 {attempts} 次尝试）</span>}
            </span>
            <button className="cb-retry" onClick={() => connRef.current?.reconnect()}>
              立即重连
            </button>
          </div>
        )}

        <nav className="tabs">
          {sessions.map((s) => {
            const e = termsRef.current.get(s.id);
            return (
              <div
                key={s.id}
                className={`tab ${active === s.id ? 'active' : ''} ${e?.ended ? 'ended' : ''}`}
                onClick={() => connRef.current && void attachSession(connRef.current, s.id)}
                title={s.id}
              >
                <span className="tab-label">
                  {s.cmd}
                  <span className="tab-id">#{s.id.slice(2, 8)}</span>
                </span>
                <button
                  className="tab-close"
                  title="关闭会话"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    void killSession(s.id);
                  }}
                >
                  <IconX />
                </button>
              </div>
            );
          })}
          <button
            className="tab-new"
            title="新建会话"
            onClick={() => connRef.current && void createSession(connRef.current)}
            disabled={!online}
          >
            <IconPlus />
          </button>

          <div className="tabs-actions">
            {agentSnap && agentSnap.sid === active && (
              <span className={`ai-pill ai-${agentSnap.status}`} title={agentSnap.detail}>
                <span className="ai-dot" />
                {agentSnap.agent === 'codex' ? 'Codex' : agentSnap.agent}
                {' · '}
                {{ starting: '启动中', working: '处理中', error: '出错', finished: '已完成' }[agentSnap.status] ?? agentSnap.status}
              </span>
            )}
            <button
              className={`mode-pill ${takeover ? 'take' : 'obs'}`}
              title={takeover ? '接管中：键盘输入直接进入终端' : '观察中：输入被拦截，点击切换为接管'}
              onClick={() => setMode(!takeover)}
            >
              {takeover ? '⌨ 接管中' : '👁 观察中'}
            </button>
            <button
              className="pause-btn"
              title="暂停 AI / 中断当前命令（发送 Ctrl+C）"
              onClick={() => {
                sendRaw('\x03');
                showToast('已发送 Ctrl+C');
              }}
              disabled={!online}
            >
              ⏸ 暂停
            </button>
          </div>
        </nav>

        <div className="term-wrap" ref={wrapRef}>
          {sessions.map((s) => (
            <div
              key={s.id}
              ref={hostCallback(s.id)}
              className={`term-holder ${active === s.id ? 'shown' : 'hidden'}`}
            />
          ))}
          {sessions.length === 0 && (
            <div className="empty">
              <div className="empty-ico">
                <IconTerminal />
              </div>
              <div className="empty-title">还没有会话</div>
              <div className="empty-sub">创建一个终端，或回家接着跑 Claude Code</div>
              <button
                className="primary-btn"
                onClick={() => connRef.current && void createSession(connRef.current)}
                disabled={!online}
              >
                <IconPlus />
                新建会话
              </button>
            </div>
          )}
          {activeEntry?.ended && (
            <div className="ended-overlay">
              <div className="ended-card">
                <div className="ended-title">会话已结束</div>
                <div className="ended-sub">进程退出，画面保留供回看</div>
                <button
                  className="primary-btn"
                  onClick={() => connRef.current && void createSession(connRef.current)}
                >
                  <IconPlus />
                  新建会话
                </button>
              </div>
            </div>
          )}

          {/* 移动端操作栏：模式切换 / 暂停 / 特殊键 / 输入条（触屏设备显示） */}
          {isTouch && (
            <div className="mobile-bar">
              <button
                className={`mb-mode ${takeover ? 'take' : 'obs'}`}
                onClick={() => setMode(!takeover)}
              >
                {takeover ? '⌨ 接管' : '👁 观察'}
              </button>
              <button className="mb-key danger" title="Ctrl+C" onClick={() => sendRaw('\x03')}>
                ⏸
              </button>
              <button className="mb-key" title="Esc" onClick={() => sendRaw('\x1b')}>
                ⎋
              </button>
              <button className="mb-key" title="Tab" onClick={() => sendRaw('\t')}>
                ⇥
              </button>
              <button className="mb-key" title="↑" onClick={() => sendRaw('\x1b[A')}>
                ↑
              </button>
              <button className="mb-key" title="↓" onClick={() => sendRaw('\x1b[B')}>
                ↓
              </button>
              <button className="mb-key font" title="减小字号" onClick={() => adjustFont(-1)}>
                A－
              </button>
              <button className="mb-key font" title="增大字号" onClick={() => adjustFont(1)}>
                A＋
              </button>
              <input
                className="mb-input"
                value={mobileInput}
                onChange={(e) => setMobileInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    sendMobileLine();
                  }
                }}
                placeholder={takeover ? '输入命令，回车发送' : '观察模式：先点左侧切换接管'}
                disabled={!takeover}
                enterKeyHint="send"
              />
            </div>
          )}
        </div>
      </main>

      {connectOpen && <Connect modal onClose={() => setConnectOpen(false)} />}

      {toast && (
        <div className="toast">
          <span className="toast-bar" />
          {toast}
        </div>
      )}
    </div>
  );
}
