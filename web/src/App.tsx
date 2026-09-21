// RemoteAgent web client — M1 本地模式。
// 连接 daemon → 列出/新建 session → attach → xterm.js 全屏终端。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { DaemonConnection, type HelloFields, type Status } from './lib/daemon';
import { b64encode, type SessionInfo } from './lib/protocol';
import './App.css';

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

export default function App() {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const connRef = useRef<DaemonConnection | null>(null);
  const sessionRef = useRef<string | null>(null);
  const bootstrappedRef = useRef(false);

  const [status, setStatus] = useState<Status>('connecting');
  const [ended, setEnded] = useState(false);
  const [sessionShort, setSessionShort] = useState('');
  const [deviceOnline, setDeviceOnline] = useState(true);
  const mode = useMemo(() => target().mode, []);

  const attachSession = useCallback(async (conn: DaemonConnection, sessionId: string) => {
    const m = await conn.request({ t: 'session.attach', sessionId });
    if (m.t !== 'session.attached') {
      termRef.current?.writeln(`\r\n[attach failed: ${JSON.stringify(m)}]`);
      return;
    }
    sessionRef.current = sessionId;
    setSessionShort(sessionId.slice(2, 8));
    setEnded(false);
    termRef.current?.focus();
  }, []);

  const createSession = useCallback(
    async (conn: DaemonConnection, cols: number, rows: number) => {
      const m = await conn.request({ t: 'session.create', cols, rows });
      if (m.t === 'session.created') {
        await attachSession(conn, m.sessionId);
      } else {
        termRef.current?.writeln(`\r\n[create failed: ${JSON.stringify(m)}]`);
      }
    },
    [attachSession],
  );

  // 连接就绪后的引导：优先接管现存 session（重连场景），否则新建。
  const bootstrap = useCallback(
    async (conn: DaemonConnection) => {
      const term = termRef.current;
      if (!term) return;
      const m = await conn.request({ t: 'session.list' });
      if (m.t !== 'session.list.result') return;
      const live = (m as { sessions: SessionInfo[] }).sessions;
      if (bootstrappedRef.current) {
        // 重连：重新 attach 当前 session，靠 snapshot 恢复画面
        const cur = sessionRef.current;
        if (cur && live.some((s) => s.id === cur)) {
          await attachSession(conn, cur);
          term.writeln('\r\n\x1b[32m[reconnected]\x1b[0m ');
          return;
        }
        sessionRef.current = null;
        setEnded(true);
        return;
      }
      bootstrappedRef.current = true;
      if (live.length > 0) {
        await attachSession(conn, live[0].id);
      } else {
        await createSession(conn, term.cols, term.rows);
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

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", Consolas, "Courier New", monospace',
      fontSize: 14,
      cursorBlink: true,
      theme: {
        background: '#0c0f14',
        foreground: '#d6dce5',
        cursor: '#10b981',
        selectionBackground: '#2f6f5e88',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;

    let retryTimer: number | undefined;

    const t = target();
    const conn = new DaemonConnection(t.url, t.hello, {
      onStatus: (s) => {
        setStatus(s);
        if (s === 'ready') bootstrapRef.current();
        if (s === 'disconnected') {
          setDeviceOnline(true); // 连接层状态优先，等待重连
          retryTimer = window.setTimeout(() => connRef.current?.connect(), 2000);
        }
      },
      onPresence: (_deviceId, online) => {
        setDeviceOnline(online);
      },
      onSnapshot: (sid, data) => {
        if (sid !== sessionRef.current) return;
        term.reset();
        term.write(data);
      },
      onOutput: (sid, data) => {
        if (sid !== sessionRef.current) return;
        term.write(data);
      },
      onExited: (sid) => {
        if (sid !== sessionRef.current) return;
        setEnded(true);
        term.writeln('\r\n\x1b[33m[session ended]\x1b[0m');
      },
      onError: (code, msg) => {
        term.writeln(`\r\n\x1b[31m[${code}] ${msg}\x1b[0m`);
      },
    });
    connRef.current = conn;
    conn.connect();

    term.onData((d) => {
      const sid = sessionRef.current;
      if (sid) conn.send({ t: 'input', sessionId: sid, data: b64encode(d) });
    });

    const ro = new ResizeObserver(() => {
      if (!hostRef.current) return;
      const before = `${term.cols}x${term.rows}`;
      fit.fit();
      if (`${term.cols}x${term.rows}` === before) return;
      const sid = sessionRef.current;
      if (sid) conn.send({ t: 'resize', sessionId: sid, cols: term.cols, rows: term.rows });
    });
    ro.observe(hostRef.current);

    return () => {
      window.clearTimeout(retryTimer);
      ro.disconnect();
      conn.close();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  const onNewSession = () => {
    const conn = connRef.current;
    const term = termRef.current;
    if (!conn || !term) return;
    term.reset();
    void createSession(conn, term.cols, term.rows);
  };

  const statusText = !deviceOnline
    ? 'device offline'
    : status === 'ready'
      ? 'connected'
      : status === 'connecting'
        ? 'connecting…'
        : 'reconnecting…';
  const dotClass = !deviceOnline ? 'disconnected' : status;

  return (
    <div className="app">
      <header className="bar">
        <span className="brand">
          RemoteAgent <span className="mode">· {mode}</span>
        </span>
        <span className="meta">
          {sessionShort && <span className="sid">session {sessionShort}</span>}
          <span className={`dot ${dotClass}`} />
          <span className={`status ${dotClass}`}>{statusText}</span>
        </span>
      </header>
      <div className="term-wrap">
        <div ref={hostRef} className="term" />
        {ended && (
          <div className="ended-overlay">
            <button onClick={onNewSession}>新建会话</button>
          </div>
        )}
      </div>
    </div>
  );
}
