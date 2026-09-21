// 连接页 / 「添加新设备」弹窗：选择要连接的中继与设备。
// 接入方式：粘贴配对链接（智能解析）/ 浏览中继设备列表 / 最近连接一键重连。

import { useEffect, useState } from 'react';

export interface SavedConn {
  url: string; // 完整配对 href（含 query），重连直接跳转
  relayHost: string; // 显示用：中继域名
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

/** 中继 ws 地址 → 对应 HTTP API 基址（浏览设备列表用） */
function relayApiBase(relay: string | null): string {
  if (!relay) return '';
  return relay.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://').replace(/\/ws$/, '');
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

interface DeviceEntry {
  deviceId: string;
  online: boolean;
}

export default function Connect({ modal = false, onClose }: { modal?: boolean; onClose?: () => void }) {
  const [paste, setPaste] = useState('');
  const [relay, setRelay] = useState('');
  const [token, setToken] = useState('');
  const [device, setDevice] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceEntry[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<SavedConn[]>([]);

  useEffect(() => {
    setRecents(loadConns());
  }, []);

  // 粘贴即解析：识别出配对链接后自动选中设备并填入令牌
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

  // 浏览中继设备列表（relay 留空 = 当前站点）
  const browse = async () => {
    setBrowsing(true);
    setBrowseError(null);
    const base = relayApiBase(normalizeRelay(relay));
    try {
      const resp = await fetch(`${base}/api/devices`);
      const ct = resp.headers.get('content-type') ?? '';
      if (!resp.ok || !ct.includes('json')) throw new Error('not relay');
      const list = (await resp.json()) as DeviceEntry[];
      setDevices(list);
      if (list.length === 0) setBrowseError('该中继上暂无在线设备');
    } catch {
      setDevices([]);
      setBrowseError('无法获取设备列表——请检查中继地址是否正确');
    } finally {
      setBrowsing(false);
    }
  };

  const connect = () => {
    if (!device || !token.trim()) {
      setError('请先选择设备（或粘贴配对链接）并输入访问令牌');
      return;
    }
    location.assign(buildHref({ relay: normalizeRelay(relay), device, token: token.trim() }));
  };

  const body = (
    <div className={`connect-card ${modal ? 'in-modal' : ''}`}>
      <div className="connect-logo">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 7.5l4 4.5-4 4.5M12 16.5h7" />
        </svg>
      </div>
      <div className="connect-title">连接到设备</div>
      <div className="connect-sub">粘贴配对链接，或浏览中继上的设备列表</div>

      <div className="field">
        <label>配对链接（最快）</label>
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
            {parsePairText(paste)
              ? '✓ 已识别，设备与令牌已自动填入'
              : '未识别出 device/token，请检查链接'}
          </div>
        )}
      </div>

      <div className="divider">
        <span>或浏览中继设备</span>
      </div>

      <div className="field">
        <label>中继地址（留空 = 当前站点）</label>
        <div className="relay-row">
          <input
            value={relay}
            onChange={(e) => {
              setRelay(e.target.value);
              setDevices(null); // 换中继后清空旧列表
              setDevice(null);
            }}
            placeholder="relay.example.com"
            spellCheck={false}
          />
          <button className="mini-btn browse-btn" onClick={() => void browse()} disabled={browsing}>
            {browsing ? '查询中…' : '查看设备'}
          </button>
        </div>
      </div>

      {devices && devices.length > 0 && (
        <div className="device-pick">
          {devices.map((d) => (
            <div
              key={d.deviceId}
              className={`pick-row ${device === d.deviceId ? 'selected' : ''} ${d.online ? '' : 'offline'}`}
              onClick={() => {
                setDevice(d.deviceId);
                setError(null);
              }}
            >
              <span className={`dot ${d.online ? 'ok' : 'bad'}`} />
              <span className="pick-id">{d.deviceId.slice(0, 8)}</span>
              <span className="pick-state">{d.online ? '在线' : '离线'}</span>
              {device === d.deviceId && <span className="pick-check">✓</span>}
            </div>
          ))}
        </div>
      )}
      {browseError && <div className="browse-error">{browseError}</div>}

      <div className="field">
        <label>访问令牌（daemon 本机面板或启动日志里查看）</label>
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          type="password"
          placeholder="连接选中设备所需的 access token"
          spellCheck={false}
        />
      </div>

      {error && <div className="connect-error">{error}</div>}

      <button className="primary-btn connect-go" onClick={connect}>
        连接
      </button>

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
