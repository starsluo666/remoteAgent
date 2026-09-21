// RemoteAgent 入口路由：
// - ?device=&token=（±?relay=）或 ?local=1 → 终端工作区
// - 无参数 + daemon 托管（/api/local 存在）→ 本机桌面应用（多页 Shell）
// - 无参数 + 中继托管 → 连接页

import { useEffect, useState } from 'react';
import TerminalApp from './TerminalApp';
import Connect from './Connect';
import Shell from './Shell';
import { target } from './lib/target';
import './App.css';

/** 无参数落地：探测本机 daemon（JSON 响应判定）→ 桌面应用；否则连接页 */
function Landing() {
  const [mode, setMode] = useState<'checking' | 'local' | 'connect'>('checking');
  useEffect(() => {
    fetch('/api/local')
      .then((r) => {
        // 中继静态托管的未知路径会回落到 index.html（text/html），只有 JSON 才算 daemon
        const ct = r.headers.get('content-type') ?? '';
        setMode(r.ok && ct.includes('json') ? 'local' : 'connect');
      })
      .catch(() => setMode('connect'));
  }, []);
  if (mode === 'checking') return <div className="connect-page" />;
  return mode === 'local' ? <Shell /> : <Connect />;
}

export default function App() {
  if (target()) return <TerminalApp />;
  return <Landing />;
}
