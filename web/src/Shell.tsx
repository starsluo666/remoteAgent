// 本机桌面应用骨架（严格对齐设计稿）：
// 居中圆角应用窗口 + 侧栏「主导航/次要导航」分组 + hash 路由。

import { useEffect, useState, type ReactNode } from 'react';
import OverviewPage from './pages/Overview';
import DevicesPage from './pages/Devices';
import SessionsPage from './pages/Sessions';
import RelayPage from './pages/Relay';
import SettingsPage from './pages/Settings';
import HelpPage from './pages/Help';
import { usePoll } from './lib/usePoll';
import { localApi, LOCAL_BASE } from './lib/local';
import type { LocalInfo } from './pages/types';

const PAGES = ['overview', 'devices', 'sessions', 'relay', 'settings', 'help'] as const;
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

interface NavItem {
  id: PageId;
  label: string;
  icon: ReactNode;
}

const MAIN_NAV: NavItem[] = [
  { id: 'overview', label: '概览', icon: <NavIconGrid /> },
  { id: 'devices', label: '设备', icon: <NavIconMonitor /> },
  { id: 'sessions', label: 'Sessions', icon: <NavIconActivity /> },
  { id: 'relay', label: '中继服务', icon: <NavIconServer /> },
];

const SUB_NAV: NavItem[] = [
  { id: 'settings', label: '设置', icon: <NavIconGear /> },
  { id: 'help', label: '帮助', icon: <NavIconHelp /> },
];

function NavGroup({ title, items, page, navigate }: {
  title: string;
  items: NavItem[];
  page: PageId;
  navigate: (p: PageId) => void;
}) {
  return (
    <div className="nav-group">
      <div className="nav-group-title">{title}</div>
      {items.map((n) => (
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
  );
}

export default function Shell() {
  const [page, navigate] = useHashRoute();
  const [local, refreshLocal] = usePoll<LocalInfo>(
    () => fetch(localApi('/api/local')).then((r) => (r.ok ? r.json() : Promise.reject())),
    5000,
    {
      deviceId: '',
      accessToken: '',
      relayUrl: null,
      relayName: '',
      relayOnline: false,
      relayNote: '读取中…',
      relayConnectedAt: 0,
      relayViewers: null,
      relays: [],
      activeRelay: null,
    },
  );

  const relayOk = local.relayOnline;

  // 手机端底部导航（≤760px 显示）：5 tab，帮助收进设置页
  const bottomTabs: { id: PageId; label: string; icon: ReactNode }[] = [
    { id: 'overview', label: '概览', icon: <NavIconGrid /> },
    { id: 'devices', label: '设备', icon: <NavIconMonitor /> },
    { id: 'sessions', label: '会话', icon: <NavIconActivity /> },
    { id: 'relay', label: '中继', icon: <NavIconServer /> },
    { id: 'settings', label: '设置', icon: <NavIconGear /> },
  ];

  return (
    <div className="shell">
      <div className={`app-window${LOCAL_BASE ? ' in-tauri' : ''}`}>
        <aside className="shell-side">
          <div className="brand" data-tauri-drag-region>
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

          <NavGroup title="主导航" items={MAIN_NAV} page={page} navigate={navigate} />

          <div className="nav-spacer" />

          <NavGroup title="次要导航" items={SUB_NAV} page={page} navigate={navigate} />

          <div className="shell-foot">
            <span className={`dot ${relayOk ? 'ok' : local.relayUrl ? 'wait' : 'bad'}`} />
            <span className="shell-foot-text">{relayOk ? '当前主机在线' : '中继未连接'}</span>
          </div>
        </aside>

        <main className="shell-main" key={page}>
          {page === 'overview' && <OverviewPage local={local} refresh={refreshLocal} />}
          {page === 'devices' && <DevicesPage local={local} />}
          {page === 'sessions' && <SessionsPage remote={!local.deviceId} />}
          {page === 'relay' && <RelayPage local={local} refresh={refreshLocal} />}
          {page === 'settings' && <SettingsPage local={local} onHelp={() => navigate('help')} />}
          {page === 'help' && <HelpPage />}
        </main>

        <nav className="bottom-nav">
          {bottomTabs.map((t) => (
            <button
              key={t.id}
              className={`bottom-item ${page === t.id ? 'active' : ''}`}
              onClick={() => navigate(t.id)}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
      </div>
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
function NavIconHelp() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.33c-.6.23-.9.62-.9 1.17v.5" />
      <path d="M12 17h.01" />
    </svg>
  );
}
