// RemoteAgent web client。
// 连接 daemon（本地或经中继）→ 侧栏设备卡片 / 顶部会话标签页管理多 session → 每 session 一个 xterm 实例。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { DaemonConnection, type HelloFields, type Status } from './lib/daemon';
import { b64encode, type SessionInfo } from './lib/protocol';
import Connect, { saveConn } from './Connect';
import './App.css';

interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  ended: boolean;
}

// 连接目标：
// - ?relay=ws%3A%2F%2Fhost%3A8080%2Fws&device=<id>&token=<t> → 中继模式（显式指定中继）
// - ?device=<id>&token=<t>（页面由中继托管时）→ 同源 /ws
// - ?local=1 → 本地模式（daemon 直连）
// - 无参数 → null，渲染连接页（粘贴配对链接 / 手动配置中继）
function target(): { url: string; hello: HelloFields; mode: string } | null {
  const q = new URLSearchParams(location.search);
  const device = q.get('device');
  const token = q.get('token') ?? undefined;
  const relay = q.get('relay');
  if (device) {
    const url = relay
      ? relay
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    return { url, hello: { deviceId: device, token }, mode: 'relay' };
  }
  if (q.get('local') === '1') {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return {
      url: `${proto}://${location.host}/ws`,
      hello: { deviceId: 'local-browser' },
      mode: 'local',
    };
  }
  return null;
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

export default function App() {
  const termsRef = useRef<Map<string, TermEntry>>(new Map());
  const connRef = useRef<DaemonConnection | null>(null);
  const activeRef = useRef<string | null>(null);
  const bootstrappedRef = useRef(false);
  const hostRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const wrapRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const t = useMemo(() => target(), []);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [deviceOnline, setDeviceOnline] = useState(true);
  const [devices, setDevices] = useState<{ deviceId: string; online: boolean }[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const savedConnRef = useRef(false);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
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
    async (conn: DaemonConnection) => {
      const entry = termsRef.current.get(activeRef.current ?? '');
      const cols = entry?.term.cols ?? 100;
      const rows = entry?.term.rows ?? 30;
      const m = await conn.request({ t: 'session.create', cols, rows });
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
    },
    [],
  );

  // 引导 / 重连恢复：列出全部 session，全部 attach（snapshot 恢复各自的终端画面）
  const bootstrap = useCallback(
    async (conn: DaemonConnection) => {
      const m = await conn.request({ t: 'session.list' });
      if (m.t !== 'session.list.result') return;
      setSessions(m.sessions);
      if (!bootstrappedRef.current) {
        bootstrappedRef.current = true;
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

  // 设备列表（中继提供；本地模式回退为单设备）
  const refetchDevices = useCallback(() => {
    if (!t || t.mode !== 'relay') return;
    fetch('/api/devices')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((list: { deviceId: string; online: boolean }[]) => setDevices(list))
      .catch(() => setDevices([{ deviceId: t.hello.deviceId, online: status === 'ready' }]));
  }, [t, status]);

  useEffect(() => {
    if (!t) return;
    if (!wrapRef.current) return;

    const conn = new DaemonConnection(t.url, t.hello, {
      onStatus: (s) => {
        setStatus(s);
        if (s === 'ready') {
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
          retryTimer = window.setTimeout(() => connRef.current?.connect(), 2000);
        }
      },
      onPresence: (_id, online) => setDeviceOnline(online),
      onSnapshot: (sid, data) => {
        const entry = termsRef.current.get(sid);
        if (!entry) return;
        entry.term.reset();
        entry.term.write(data);
      },
      onOutput: (sid, data) => {
        termsRef.current.get(sid)?.term.write(data);
      },
      onExited: (sid) => {
        const entry = termsRef.current.get(sid);
        if (entry) entry.ended = true;
        const conn = connRef.current;
        if (conn) void refetchSessions(conn);
      },
      onError: (code, msg) => {
        if (code === 'auth_failed' || code === 'device_busy' || code === 'decrypt_failed') {
          connRef.current?.close();
        }
        const entry = activeRef.current ? termsRef.current.get(activeRef.current) : null;
        entry?.term.writeln(`\r\n\x1b[31m[${code}] ${msg}\x1b[0m`);
      },
    });
    connRef.current = conn;
    conn.connect();

    let retryTimer: number | undefined;
    const deviceTimer = window.setInterval(refetchDevices, 8000);
    refetchDevices();

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

    return () => {
      window.clearTimeout(retryTimer);
      window.clearTimeout(toastTimer.current);
      window.clearInterval(deviceTimer);
      ro.disconnect();
      conn.close();
      for (const { term } of termsRef.current.values()) term.dispose();
      termsRef.current.clear();
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
          fontSize: 14,
          cursorBlink: true,
          theme: termTheme,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(el);
        const entry: TermEntry = { term, fit, ended: false };
        termsRef.current.set(sid, entry);
        term.onData((d) => {
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

  // 无连接目标：渲染连接页（选中继 / 粘贴配对链接 / 最近连接）
  if (!t) {
    return <Connect />;
  }

  const statusBadge = !deviceOnline
    ? { cls: 'off', text: '离线' }
    : status === 'ready'
      ? { cls: 'on', text: '在线' }
      : status === 'connecting'
        ? { cls: 'wait', text: '连接中…' }
        : { cls: 'wait', text: '重连中…' };
  const deviceList = devices.length > 0 ? devices : [{ deviceId: t.hello.deviceId, online: deviceOnline }];
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
                      {cur ? currentDeviceName : d.deviceId.slice(0, 8)}
                      {cur && <span className="device-badge">已连接</span>}
                    </div>
                    <div className="device-sub">
                      <span className={`dot ${d.online ? 'ok' : 'bad'}`} />
                      {d.online ? '在线' : '离线'}
                      <span className="device-mac">{d.deviceId.slice(0, 8)}</span>
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
