// 连接页 / 「添加新设备」弹窗：选择要连接的中继与设备。
// 三种接入方式：粘贴配对链接（智能解析）、手动填写、最近连接一键重连。

import { useEffect, useState } from 'react';

export interface SavedConn {
  url: string; // 完整配对 href（含 query），重连直接跳转
  relayHost: string; // 显示用：中继域名，本地模式为 '本机'
  deviceId: string;
  savedAt: number;
}

const LS_KEY = 'ra.connections';
const MAX_SAVED = 8;

export function loadConns(): SavedConn[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveConn(c: SavedConn): void {
  const list = loadConns().filter((x) => x.url !== c.url);
  list.unshift(c);
  localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, MAX_SAVED)));
}

export function removeConn(url: string): void {
  localStorage.setItem(LS_KEY, JSON.stringify(loadConns().filter((x) => x.url !== url)));
}

export interface PairFields {
  relay: string | null; // ws(s)://…/ws；与当前站点同源时为 null
  device: string;
  token: string;
}

/** 解析配对链接文本；识别失败返回 null */
export function parsePairText(text: string): PairFields | null {
  const t = text.trim();
  try {
    const u = new URL(t);
    const device = u.searchParams.get('device');
    const token = u.searchParams.get('token');
    if (!device || !token) return null;
    const relay =
      u.origin === location.origin
        ? null
        : `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}/ws`;
    return { relay, device, token };
  } catch {
    return null;
  }
}

/** 手动输入的中继地址归一化：host → wss://host/ws */
export function normalizeRelay(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^wss?:\/\//.test(t)) return /\/ws$/.test(t) ? t : `${t}/ws`;
  return `wss://${t}/ws`;
}

export function buildHref(f: PairFields): string {
  const q = new URLSearchParams();
  if (f.relay) q.set('relay', f.relay);
  q.set('device', f.device);
  q.set('token', f.token);
  return `${location.origin}${location.pathname}?${q.toString()}`;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export default function Connect({ modal = false, onClose }: { modal?: boolean; onClose?: () => void }) {
  const [paste, setPaste] = useState('');
  const [relay, setRelay] = useState('');
  const [device, setDevice] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<SavedConn[]>([]);
  // 本机 daemon 快捷入口：页面由 daemon 托管（本地端口）或在中继站点上时都可尝试
  const isLocalHost = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  useEffect(() => {
    setRecents(loadConns());
  }, []);

  // 粘贴即解析：识别出配对链接后自动填表
  const onPaste = (text: string) => {
    setPaste(text);
    const f = parsePairText(text);
    if (f) {
      setRelay(f.relay ?? '');
      setDevice(f.device);
      setToken(f.token);
      setError(null);
    }
  };

  const connect = () => {
    if (!device.trim() || !token.trim()) {
      setError('缺少设备 ID 或访问令牌——建议直接粘贴 daemon 打印的配对链接');
      return;
    }
    location.assign(buildHref({ relay: normalizeRelay(relay), device: device.trim(), token: token.trim() }));
  };

  const body = (
    <div className={`connect-card ${modal ? 'in-modal' : ''}`}>
      <div className="connect-logo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 7.5l4 4.5-4 4.5M12 16.5h7" />
        </svg>
      </div>
      <div className="connect-title">连接到设备</div>
      <div className="connect-sub">粘贴家里 daemon 打印的配对链接，或手动填写</div>

      <div className="field">
        <label>配对链接</label>
        <textarea
          className="paste-box"
          rows={2}
          placeholder="https://relay.example.com/?device=xxx&token=…"
          value={paste}
          onChange={(e) => onPaste(e.target.value)}
          spellCheck={false}
        />
        {paste.trim() && (
          <div className={`parse-hint ${parsePairText(paste) ? 'ok' : 'bad'}`}>
            {parsePairText(paste) ? '✓ 已识别，下方已自动填入' : '未识别出 device/token，请检查链接'}
          </div>
        )}
      </div>

      <div className="field">
        <label>中继地址（留空 = 当前站点）</label>
        <input
          value={relay}
          onChange={(e) => setRelay(e.target.value)}
          placeholder="relay.example.com"
          spellCheck={false}
        />
      </div>
      <div className="field-row">
        <div className="field grow">
          <label>设备 ID</label>
          <input value={device} onChange={(e) => setDevice(e.target.value)} spellCheck={false} />
        </div>
        <div className="field grow">
          <label>访问令牌</label>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            spellCheck={false}
          />
        </div>
      </div>

      {error && <div className="connect-error">{error}</div>}

      <button className="primary-btn connect-go" onClick={connect}>
        连接
      </button>

      {isLocalHost && (
        <button
          className="local-link"
          onClick={() => location.assign(`${location.origin}${location.pathname}?local=1`)}
        >
          直接连接本机 daemon（127.0.0.1）
        </button>
      )}

      {recents.length > 0 && (
        <div className="recents">
          <div className="recents-title">最近连接</div>
          {recents.map((c) => (
            <div key={c.url} className="recent-item" onClick={() => location.assign(c.url)}>
              <span className="dot ok" />
              <span className="recent-host">{c.relayHost}</span>
              <span className="recent-device">{c.deviceId.slice(0, 8)}</span>
              <span className="recent-time">{timeAgo(c.savedAt)}</span>
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
      )}

      <div className="connect-foot">🔒 中继无法读取会话内容 —— 数据在设备与浏览器间端到端加密</div>
    </div>
  );

  if (modal) {
    return (
      <div className="connect-overlay" onClick={onClose}>
        <div className="connect-modal-stop" onClick={(e) => e.stopPropagation()}>
          {body}
        </div>
      </div>
    );
  }
  return <div className="connect-page">{body}</div>;
}
