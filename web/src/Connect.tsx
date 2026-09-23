// 连接页 / 「添加新设备」弹窗：选择要连接的中继与设备。
// 接入方式：粘贴配对链接（智能解析）/ 浏览中继设备列表 / 最近连接一键重连。

import { useEffect, useState } from 'react';
import { paramsOf } from './lib/target';

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

/** 解析配对链接文本（query 或 fragment 格式）；识别失败返回 null */
export function parsePairText(text: string): PairFields | null {
  const t = text.trim();
  try {
    const u = new URL(t);
    const p = paramsOf(u);
    const device = p.get('device');
    const token = p.get('token');
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
  // fragment 格式：凭据不随 HTTP 请求发给服务器（不进中继/反代访问日志）
  return `${location.origin}${location.pathname}#${q.toString()}`;
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
  const [token, setToken] = useState('');
  const [device, setDevice] = useState<string | null>(null);
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

  const connect = () => {
    if (!device || !token.trim()) {
      setError('请先粘贴配对链接，或手动输入设备 ID 与访问令牌');
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
      <div className="connect-title">{modal ? '连接远程设备' : '我的设备'}</div>
      <div className="connect-sub">
        {modal
          ? '粘贴对方发来的配对链接，或输入设备号 + 访问令牌'
          : '选择设备一键连接；没有配对过？粘贴配对链接添加'}
      </div>

      {recents.length > 0 && (
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
      )}

      <div className="divider">
        <span>添加新设备</span>
      </div>

      <div className="field">
        <label>配对链接（最快）</label>
        <textarea
          className="paste-box"
          rows={2}
          placeholder="https://relay.example.com/#device=xxx&token=…"
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
        <label>访问令牌（设备面板 → 概览里查看/编辑）</label>
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
