// RemoteAgent web client。
// 连接 daemon（本地或经中继）→ 侧栏管理多 session / 查看设备在线 → 每 session 一个 xterm 实例。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { DaemonConnection, type HelloFields, type Status } from './lib/daemon';
import { b64encode, type SessionInfo } from './lib/protocol';
import './App.css';

interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  ended: boolean;
}

// 连接目标：
// - ?relay=ws%3A%2F%2Fhost%3A8080%2Fws&device=<id>&token=<t> → 中继模式
// - ?device=<id>&token=<t>（页面由中继托管时）→ 同源 /ws
// - 无参数 → 本地模式（daemon 直连）
function target(): { url: string; hello: HelloFields; mode: string } {
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
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return {
    url: `${proto}://${location.host}/ws`,
    hello: { deviceId: 'local-browser' },
    mode: 'local',
  };
}

const termTheme = {
  background: '#0c0f14',
  foreground: '#d6dce5',
  cursor: '#10b981',
  selectionBackground: '#2f6f5e88',
};

export default function App() {
  const termsRef = useRef<Map<string, TermEntry>>(new Map());
  const connRef = useRef<DaemonConnection | null>(null);
  const activeRef = useRef<string | null>(null);
  const bootstrappedRef = useRef(false);
  const hostRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const wrapRef = useRef<HTMLDivElement>(null);

  const t = useMemo(() => target(), []);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [deviceOnline, setDeviceOnline] = useState(true);
  const [devices, setDevices] = useState<{ deviceId: string; online: boolean }[]>([]);

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
    if (t.mode !== 'relay') return;
    fetch('/api/devices')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((list: { deviceId: string; online: boolean }[]) => setDevices(list))
      .catch(() => setDevices([{ deviceId: t.hello.deviceId, online: status === 'ready' }]));
  }, [t, status]);

  useEffect(() => {
    if (!wrapRef.current) return;

    const conn = new DaemonConnection(t.url, t.hello, {
      onStatus: (s) => {
        setStatus(s);
        if (s === 'ready') bootstrapRef.current();
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
          fontFamily: '"JetBrains Mono", Consolas, "Courier New", monospace',
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

  const activeEntry = active ? termsRef.current.get(active) : null;
  const statusText = !deviceOnline
    ? 'device offline'
    : status === 'ready'
      ? 'connected'
      : status === 'connecting'
        ? 'connecting…'
        : 'reconnecting…';
  const dotClass = !deviceOnline ? 'disconnected' : status;

  return (
    <div className="layout">
      <aside className="side">
        <div className="brand">
          RemoteAgent <span className="mode">· {t.mode}</span>
        </div>
        <div className="section">
          <div className="section-title">Devices</div>
          {(devices.length > 0 ? devices : [{ deviceId: t.hello.deviceId, online: deviceOnline }]).map(
            (d) => (
              <div key={d.deviceId} className={`device ${d.online ? 'on' : 'off'}`}>
                <span className={`dot ${d.online ? 'ready' : 'disconnected'}`} />
                <span className="name">{d.deviceId === t.hello.deviceId ? 'This device' : d.deviceId.slice(0, 8)}</span>
              </div>
            ),
          )}
        </div>
        <div className="section grow">
          <div className="section-title">
            Sessions
            <button className="new-btn" onClick={() => connRef.current && void createSession(connRef.current)}>
              + 新建
            </button>
          </div>
          {sessions.map((s) => {
            const e = termsRef.current.get(s.id);
            return (
              <div
                key={s.id}
                className={`session-item ${active === s.id ? 'active' : ''} ${e?.ended ? 'ended' : ''}`}
                onClick={() => connRef.current && void attachSession(connRef.current, s.id)}
              >
                <span className="s-cmd">{s.cmd}</span>
                <span className="s-id">{s.id.slice(2, 8)}</span>
                <button
                  className="kill-btn"
                  title="关闭会话"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    void killSession(s.id);
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      </aside>
      <main className="main">
        <header className="bar">
          <span className="meta-left">
            {activeEntry && active ? `session ${active.slice(2, 8)} · ${sessions.find((s) => s.id === active)?.cmd ?? ''}` : 'no session'}
          </span>
          <span className="meta">
            <span className={`dot ${dotClass}`} />
            <span className={`status ${dotClass}`}>{statusText}</span>
          </span>
        </header>
        <div className="term-wrap" ref={wrapRef}>
          {sessions.length === 0 && <div className="empty">没有会话，点左侧「+ 新建」开始</div>}
          {sessions.map((s) => (
            <div
              key={s.id}
              ref={hostCallback(s.id)}
              className={`term-holder ${active === s.id ? 'shown' : 'hidden'}`}
            />
          ))}
          {activeEntry?.ended && (
            <div className="ended-overlay">
              <button onClick={() => connRef.current && void createSession(connRef.current)}>新建会话</button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
