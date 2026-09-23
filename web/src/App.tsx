// RemoteAgent 入口路由：
// - ?device=&token=（±?relay=）或 ?local=1 → 终端工作区
// - 无参数 + daemon 托管（/api/local 存在）→ 本机桌面应用（多页 Shell）
// - 无参数 + 中继托管 → 落地页（Hero），CTA 进入连接页

import { useEffect, useState } from 'react';
import TerminalApp from './TerminalApp';
import Shell from './Shell';
import LandingHero from './LandingHero';
import { target } from './lib/target';
import { localApi, LOCAL_BASE } from './lib/local';
import WindowCaps from './WindowCaps';
import './App.css';

/** 无参数落地：探测本机 daemon（JSON 响应判定）→ 桌面面板；中继站点 → 落地页 → 同一个面板（空态） */
function Landing() {
  const [mode, setMode] = useState<'checking' | 'local' | 'relay'>('checking');
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    let tries = 0;
    let stop = false;
    const probe = () => {
      fetch(localApi('/api/local'))
        .then((r) => {
          // 中继静态托管的未知路径会回落到 index.html（text/html），只有 JSON 才算 daemon
          const ct = r.headers.get('content-type') ?? '';
          if (!stop) setMode(r.ok && ct.includes('json') ? 'local' : 'relay');
        })
        .catch(() => {
          // exe 冷启动时 daemon 可能还没监听（宿主连接需 1s+）：重试几秒再判为远程
          if (!stop && LOCAL_BASE && tries++ < 10) setTimeout(probe, 500);
          else if (!stop) setMode('relay');
        });
    };
    probe();
    return () => {
      stop = true;
    };
  }, []);
  if (mode === 'checking') return <div className="connect-page" />;
  if (mode === 'local') return <Shell />;
  // 中继站点：落地页 → 进入面板（同一套导航，概览默认；本机数据为空态：
  // 中继未连接、会话 0 —— 远程访客经「设备 → 连接远程设备」粘贴配对链接接入）
  if (!entered && !location.hash.includes('connect')) {
    return <LandingHero onEnter={() => setEntered(true)} />;
  }
  return <Shell />;
}

export default function App() {
  // 窗口控制常驻右上角（仅桌面壳）；各页面为其让位
  if (LOCAL_BASE) document.body.classList.add('in-tauri');
  return (
    <>
      <WindowCaps />
      {target() ? <TerminalApp /> : <Landing />}
    </>
  );
}
