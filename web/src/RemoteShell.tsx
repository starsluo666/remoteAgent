// 远程端应用外壳（中继站点）：与桌面面板同构的主导航体验。
// 用户决策：进入应用 → 主导航页，默认概览；连接表单并入概览。
// 页面：概览（已配对设备 + 添加）/ 设置（主题/通知/字号）/ 帮助。
// 约束：全私有中继，连接前无在线状态 —— 概览主体是本机保存的配对记录。

import { useEffect, useState, type ReactNode } from 'react';
import { loadConns, removeConn, parsePairText, buildHref } from './Connect';
import { LOCAL_BASE } from './lib/local';
import { setTheme, storedTheme, type Theme } from './lib/theme';
import {
  notifyEnabled,
  notifyPermission,
  notifySupported,
  requestNotifyPermission,
  setNotifyEnabled,
} from './lib/notify';
import HelpPage from './pages/Help';
import WindowCaps from './WindowCaps';

type Page = 'overview' | 'settings' | 'help';

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/* ── 概览：已配对设备 + 添加 ─────────────────────── */
function OverviewPage() {
  const [recents, setRecents] = useState(loadConns());
  const [paste, setPaste] = useState('');
  const [device, setDevice] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const connect = () => {
    if (!device || !token.trim()) {
      setError('请先粘贴配对链接，或输入设备号与访问令牌');
      return;
    }
    location.assign(buildHref({ relay: null, device, token: token.trim() }));
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">概览</div>
          <div className="page-sub">已配对的设备；点卡片一键连接</div>
        </div>
      </div>

      {recents.length > 0 ? (
        <div className="recents">
          <div className="recents-title">已配对设备</div>
          {recents.map((c) => (
            <div key={c.url} className="recent-item" onClick={() => location.assign(c.url)}>
              <span className="dot ok" />
              <div className="recent-main">
                <span className="recent-device">
                  {c.deviceId.length > 12 ? c.deviceId.slice(0, 8) : c.deviceId}
                </span>
                <span className="recent-host">{c.relayHost}</span>
              </div>
              <span className="recent-time">{timeAgo(c.savedAt)}</span>
              <button className="mini-btn accent recent-go">连接</button>
              <button
                className="recent-del"
                title="移除记录"
                onClick={(e) => {
                  e.stopPropagation();
                  removeConn(c.url);
                  setRecents(loadConns());
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="info-hint">
          还没有配对过设备 —— 让家里电脑打开 RemoteAgent 面板（概览页有配对链接），把链接粘贴到下方。
        </div>
      )}

      <div className="panel-card" style={{ marginTop: 14 }}>
        <div className="panel-title">添加新设备</div>
        <div className="field">
          <label>配对链接（最快）</label>
          <textarea
            className="paste-box"
            rows={2}
            placeholder="https://relay.example.com/#device=xxx&token=…"
            value={paste}
            onChange={(e) => {
              setPaste(e.target.value);
              const f = parsePairText(e.target.value);
              if (f) {
                setDevice(f.device);
                setToken(f.token);
                setError(null);
              }
            }}
            spellCheck={false}
          />
          {paste.trim() && (
            <div className={`parse-hint ${parsePairText(paste) ? 'ok' : 'bad'}`}>
              {parsePairText(paste)
                ? '✓ 已识别，设备与令牌已自动填入'
                : '未识别出 device/token，请检查链接'}
            </div>
          )}
        </div>
        <div className="field">
          <label>设备号</label>
          <input
            value={device ?? ''}
            onChange={(e) => {
              setDevice(e.target.value.trim() || null);
              setError(null);
            }}
            placeholder="9 位设备号（设备面板 → 概览里查看）"
            spellCheck={false}
          />
        </div>
        <div className="field">
          <label>访问令牌</label>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            placeholder="连接该设备所需的访问令牌"
            spellCheck={false}
          />
        </div>
        {error && <div className="connect-error">{error}</div>}
        <button className="primary-btn connect-go" onClick={connect}>
          连接
        </button>
        <div className="connect-foot">🔒 中继无法读取会话内容 —— 数据在设备与浏览器间端到端加密</div>
      </div>
    </div>
  );
}

/* ── 设置：客户端偏好（主题/通知/字号） ───────────────── */
function SettingsPage() {
  const [theme, setThemeState] = useState<Theme>(() => storedTheme());
  const [notifyOn, setNotifyOn] = useState(() => notifyEnabled());
  const [notifyPerm, setNotifyPerm] = useState(() => notifyPermission());
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem('ra.termFontSize')) || 14);

  const toggleNotify = async () => {
    if (!notifyOn) {
      const ok = await requestNotifyPermission();
      setNotifyPerm(notifyPermission());
      if (!ok) return;
      setNotifyEnabled(true);
      setNotifyOn(true);
    } else {
      setNotifyEnabled(false);
      setNotifyOn(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">设置</div>
          <div className="page-sub">浏览器端偏好，保存在本机</div>
        </div>
      </div>
      <div className="panel-card">
        <div className="panel-title">外观</div>
        <div className="set-row">
          <div>
            <div className="set-name">主题</div>
            <div className="set-desc">界面配色（终端画布保持深色）</div>
          </div>
          <div className="seg">
            {(
              [
                ['dark', '深色'],
                ['light', '浅色'],
                ['system', '跟随系统'],
              ] as [Theme, string][]
            ).map(([v, label]) => (
              <button
                key={v}
                className={`seg-item ${theme === v ? 'active' : ''}`}
                onClick={() => {
                  setTheme(v);
                  setThemeState(v);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="set-name">终端字号</div>
            <div className="set-desc">当前 {fontSize}px —— 新开的终端生效</div>
          </div>
          <input
            type="range"
            min={12}
            max={18}
            step={1}
            value={fontSize}
            onChange={(e) => {
              const v = Number(e.target.value);
              setFontSize(v);
              localStorage.setItem('ra.termFontSize', String(v));
            }}
            className="font-slider"
          />
        </div>
      </div>
      <div className="panel-card" style={{ marginTop: 14 }}>
        <div className="panel-title">通知</div>
        <div className="set-row">
          <div>
            <div className="set-name">桌面通知</div>
            <div className="set-desc">
              {notifySupported()
                ? notifyPerm === 'denied'
                  ? '浏览器已拒绝通知权限 —— 在站点设置里允许后重开'
                  : 'AI 任务完成 / 出错、会话退出时推送（应用在后台时）'
                : '当前环境不支持系统通知'}
            </div>
          </div>
          <button
            className={`switch ${notifyOn && notifyPerm === 'granted' ? 'on' : ''}`}
            disabled={!notifySupported() || notifyPerm === 'denied'}
            onClick={() => void toggleNotify()}
            role="switch"
            aria-checked={notifyOn && notifyPerm === 'granted'}
          >
            <span className="knob" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── 外壳 ─────────────────────────────────────── */
export default function RemoteShell() {
  const [page, setPage] = useState<Page>('overview');

  useEffect(() => {
    document.title = 'RemoteAgent';
  }, []);

  const nav = (id: Page, label: string, icon: ReactNode) => (
    <button className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => setPage(id)}>
      {icon}
      <span>{label}</span>
    </button>
  );

  return (
    <div className="shell">
      <div className={`app-window${LOCAL_BASE ? ' in-tauri' : ''}`}>
        <WindowCaps />
        <aside className="shell-side">
          <div className="brand" data-tauri-drag-region>
            <div className="logo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 7.5l4 4.5-4 4.5M12 16.5h7" />
              </svg>
            </div>
            <div className="brand-text">
              <div className="brand-name">RemoteAgent</div>
              <div className="brand-ver">v0.1 · 远程</div>
            </div>
          </div>

          <div className="nav-group">
            <div className="nav-group-title">主导航</div>
            {nav('overview', '概览', (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
                <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
                <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
                <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
              </svg>
            ))}
            {nav('settings', '设置', (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h0a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h0a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
              </svg>
            ))}
            {nav('help', '帮助', (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.33c-.6.23-.9.62-.9 1.17v.5" />
                <path d="M12 17h.01" />
              </svg>
            ))}
          </div>

          <div className="shell-foot">
            <span className="dot ok" />
            <span className="shell-foot-text">🔒 端到端加密</span>
          </div>
        </aside>

        <main className="shell-main">
          {page === 'overview' && <OverviewPage />}
          {page === 'settings' && <SettingsPage />}
          {page === 'help' && <HelpPage />}
        </main>
      </div>
    </div>
  );
}
