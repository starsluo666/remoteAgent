// 本机桌面应用骨架：侧栏主导航（概览/设备/Sessions/中继服务/设置）+ hash 路由。
// 数据来自 daemon 本地 API（/api/local、/api/devices、/api/sessions）。

import { useEffect, useState, type ReactNode } from 'react';
import OverviewPage from './pages/Overview';
import DevicesPage from './pages/Devices';
import SessionsPage from './pages/Sessions';
import RelayPage from './pages/Relay';
import SettingsPage from './pages/Settings';
import { usePoll } from './lib/usePoll';
import type { LocalInfo } from './pages/types';

const PAGES = ['overview', 'devices', 'sessions', 'relay', 'settings'] as const;
type PageId = (typeof PAGES)[number];

function useHashRoute(): [PageId, (p: PageId) => void] {
  const parse = (): PageId => {
    const h = location.hash.replace(/^#\/?/, '').split('?')[0];
    return (PAGES as readonly string[]).includes(h) ? (h as PageId) : 'overview';
  };
  const [page, setPage] = useState<PageId>(parse);
  useEffect(() => {
    const on = () => setPage(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [page, (p) => (location.hash = `#/${p}`)];
}

const NAV: { id: PageId; label: string; icon: ReactNode }[] = [
  { id: 'overview', label: '概览', icon: <NavIconGrid /> },
  { id: 'devices', label: '设备', icon: <NavIconMonitor /> },
  { id: 'sessions', label: 'Sessions', icon: <NavIconActivity /> },
  { id: 'relay', label: '中继服务', icon: <NavIconServer /> },
  { id: 'settings', label: '设置', icon: <NavIconGear /> },
];

export default function Shell() {
  const [page, navigate] = useHashRoute();
  const [local, refreshLocal] = usePoll<LocalInfo>(
    () => fetch('/api/local').then((r) => (r.ok ? r.json() : Promise.reject())),
    5000,
    { deviceId: '', accessToken: '', relayUrl: null, relayOnline: false, relayNote: '读取中…' },
  );

  const relayOk = local.relayOnline;
  const relayLabel = local.relayUrl ? (relayOk ? '中继已连接' : '中继重试中') : '未连接中继';

  return (
    <div className="shell">
      <aside className="shell-side">
        <div className="brand">
          <div className="logo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 7.5l4 4.5-4 4.5M12 16.5h7" />
            </svg>
          </div>
          <div className="brand-text">
            <div className="brand-name">RemoteAgent</div>
            <div className="brand-ver">v0.1 · 本机</div>
          </div>
        </div>

        <div className="nav-group">
          <div className="nav-group-title">主导航</div>
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`nav-item ${page === n.id ? 'active' : ''}`}
              onClick={() => navigate(n.id)}
            >
              {n.icon}
              <span>{n.label}</span>
            </button>
          ))}
        </div>

        <div className="shell-foot">
          <span className={`dot ${relayOk ? 'ok' : local.relayUrl ? 'wait' : 'bad'}`} />
          <span className="shell-foot-text">{relayLabel}</span>
        </div>
      </aside>

      <main className="shell-main">
        {page === 'overview' && <OverviewPage local={local} />}
        {page === 'devices' && <DevicesPage local={local} />}
        {page === 'sessions' && <SessionsPage />}
        {page === 'relay' && <RelayPage local={local} refresh={refreshLocal} />}
        {page === 'settings' && <SettingsPage local={local} />}
      </main>
    </div>
  );
}

/* ── 导航图标 ─────────────────────────── */
function NavIconGrid() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  );
}
function NavIconMonitor() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="3.5" width="19" height="13" rx="2" />
      <path d="M8.5 20.5h7M12 16.5v4" />
    </svg>
  );
}
function NavIconActivity() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </svg>
  );
}
function NavIconServer() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  );
}
function NavIconGear() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
    </svg>
  );
}
