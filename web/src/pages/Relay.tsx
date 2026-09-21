// 中继服务页（对齐设计稿）：连接大卡（名称+四格统计）+ 仪表图 + 测试延迟/断开
// + 多中继管理列表 + 添加中继弹窗。运行时间/活跃连接/延迟为真实数据，
// 地区与带宽需中继协议扩展，暂显示占位。

import { useState } from 'react';
import { relayHttpBase } from '../lib/target';
import type { LocalInfo } from './types';

interface Props {
  local: LocalInfo;
  refresh: () => void;
}

function uptime(from: number): string {
  if (!from) return '—';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - from));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分 ${s % 60} 秒`;
}

export default function RelayPage({ local, refresh }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addUrl, setAddUrl] = useState('');

  const connected = !!local.relayUrl;
  const name = local.relayName || '未命名中继';

  const post = (path: string, body: unknown) =>
    fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (r) => {
      if (!r.ok) throw new Error((await r.text()) || '请求失败');
      refresh();
    });

  const run = (fn: () => Promise<void>) => () => {
    setBusy(true);
    setError(null);
    fn().catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };

  // 实测延迟：对中继 HTTP /health 计时（TCP+HTTP 往返）
  const testLatency = run(async () => {
    if (!local.relayUrl) throw new Error('未连接中继');
    const base = relayHttpBase(local.relayUrl);
    const t0 = performance.now();
    const r = await fetch(`${base}/health`, { cache: 'no-store' });
    await r.text();
    if (!r.ok) throw new Error('中继无响应');
    setLatency(Math.round(performance.now() - t0));
  });

  const connect = (url: string) => run(() => post('/api/local/relay', { url }));
  const disconnect = run(() => post('/api/local/relay', { url: null }));
  const addRelay = run(async () => {
    await post('/api/local/relays', { action: 'add', name: addName, url: addUrl });
    setAddOpen(false);
    setAddName('');
    setAddUrl('');
  });
  const removeRelay = (url: string) => run(() => post('/api/local/relays', { action: 'remove', url }));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">中继服务</div>
          <div className="page-sub">连接你的自建中继，外网设备经它转发</div>
        </div>
        <button className="primary-btn" onClick={() => setAddOpen(true)}>
          + 添加中继
        </button>
      </div>

      {/* 连接大卡 */}
      <div className={`relay-hero ${local.relayOnline ? 'on' : connected ? 'wait' : 'off'}`}>
        <div className="relay-hero-main">
          <div className="relay-hero-status">
            <span className="dot big" />
            <span className="rhs-state">{local.relayOnline ? '已连接' : connected ? '重试中' : '未连接'}</span>
            <span className="rhs-name">{connected ? name : ''}</span>
          </div>
          <div className="relay-hero-url mono">
            <svg className="lock-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
              <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
            </svg>
            {local.relayUrl ?? '连接下方列表中的中继，或添加一个新的'}
          </div>
          {connected && local.relayNote && !local.relayOnline && (
            <div className="relay-note-line">{local.relayNote}</div>
          )}

          <div className="relay-stats">
            <div className="rstat">
              <div className="rstat-label">运行时间</div>
              <div className="rstat-value">{local.relayOnline ? uptime(local.relayConnectedAt) : '—'}</div>
            </div>
            <div className="rstat">
              <div className="rstat-label">地区</div>
              <div className="rstat-value dim">—</div>
              <div className="rstat-foot">需中继上报</div>
            </div>
            <div className="rstat">
              <div className="rstat-label">活跃连接</div>
              <div className="rstat-value">{local.relayOnline ? (local.relayViewers ?? '…') : '—'}</div>
            </div>
            <div className="rstat">
              <div className="rstat-label">延迟</div>
              <div className="rstat-value">
                {latency != null ? <span className={latency < 100 ? 'good' : ''}>{latency} ms</span> : '—'}
              </div>
              <div className="rstat-foot">{latency != null ? '到中继往返' : '点右侧测试'}</div>
            </div>
          </div>
        </div>

        <div className="relay-hero-side">
          <Gauge online={local.relayOnline} latency={latency} />
          <div className="relay-hero-actions">
            {connected && (
              <>
                <button className="ghost-btn" disabled={busy} onClick={testLatency}>
                  测试延迟
                </button>
                <button className="ghost-btn danger" disabled={busy} onClick={disconnect}>
                  断开
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {error && <div className="connect-error">{error}</div>}

      {/* 快速连接（未连接任何中继时显示） */}
      {!connected && (
        <div className="panel-card">
          <div className="panel-title">快速连接</div>
          <QuickConnect onConnect={connect} busy={busy} />
        </div>
      )}

      {/* 多中继列表 */}
      <div className="ra-table">
        <div className="ra-row head">
          <div className="col-name">名称</div>
          <div className="col-url">地址</div>
          <div className="col-state">状态</div>
          <div className="col-act">操作</div>
        </div>
        {local.relays.length === 0 && (
          <div className="ra-row">
            <div className="col-name" style={{ color: 'var(--text-3)' }}>
              还没有保存的中继 —— 点右上「+ 添加中继」
            </div>
            <div className="col-url" />
            <div className="col-state" />
            <div className="col-act" />
          </div>
        )}
        {local.relays.map((r) => {
          const isActive = local.activeRelay === r.url;
          return (
            <div key={r.url} className="ra-row">
              <div className="col-name">
                <div className="row-title">{r.name}</div>
              </div>
              <div className="col-url mono">{r.url}</div>
              <div className="col-state">
                {isActive ? (
                  <span className={`pill ${local.relayOnline ? 'on' : 'wait'}`}>
                    {local.relayOnline ? '已连接' : '连接中'}
                  </span>
                ) : (
                  <span className="pill off">未连接</span>
                )}
              </div>
              <div className="col-act">
                {isActive ? (
                  <button className="mini-btn" disabled={busy} onClick={disconnect}>
                    断开
                  </button>
                ) : (
                  <button className="mini-btn accent" disabled={busy} onClick={() => connect(r.url)}>
                    连接
                  </button>
                )}
                <button className="mini-btn danger" disabled={busy} onClick={() => removeRelay(r.url)}>
                  删除
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="security-bar">🔒 会话数据端到端加密，中继无法读取内容；设备身份与令牌存储于本机</div>

      {/* 添加中继弹窗 */}
      {addOpen && (
        <div className="connect-overlay" onClick={() => setAddOpen(false)}>
          <div className="connect-modal-stop" onClick={(e) => e.stopPropagation()}>
            <div className="connect-card in-modal">
              <div className="connect-title">添加中继</div>
              <div className="connect-sub">保存到列表，需要时再连接</div>
              <div className="field">
                <label>名称</label>
                <input value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="Homelab 中继" spellCheck={false} />
              </div>
              <div className="field">
                <label>地址</label>
                <input value={addUrl} onChange={(e) => setAddUrl(e.target.value)} placeholder="wss://relay.example.com/ws" spellCheck={false} />
              </div>
              {error && <div className="connect-error">{error}</div>}
              <button className="primary-btn connect-go" disabled={busy} onClick={addRelay}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function QuickConnect({ onConnect, busy }: { onConnect: (url: string) => void; busy: boolean }) {
  const [url, setUrl] = useState('');
  const go = () => {
    const t = url.trim();
    if (!t) return;
    onConnect(/^wss?:\/\//.test(t) ? t : `wss://${t}/ws`);
  };
  return (
    <div className="relay-row">
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && go()}
        placeholder="wss://relay.example.com/ws"
        spellCheck={false}
      />
      <button className="mini-btn browse-btn" disabled={busy} onClick={go}>
        连接
      </button>
    </div>
  );
}

/** 仪表图：连接状态环形指示（SVG，占位可视化） */
function Gauge({ online, latency }: { online: boolean; latency: number | null }) {
  const r = 44;
  const c = 2 * Math.PI * r;
  const ratio = latency != null ? Math.max(0.12, 1 - Math.min(latency, 400) / 400) : online ? 0.7 : 0.06;
  const color = !online ? 'var(--text-3)' : latency == null ? 'var(--accent)' : latency < 100 ? 'var(--green)' : latency < 250 ? 'var(--amber)' : 'var(--red)';
  return (
    <div className="gauge">
      <svg viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="9" />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={`${c * ratio} ${c}`}
          transform="rotate(-90 60 60)"
          style={{ transition: 'stroke-dasharray 0.4s ease, stroke 0.4s ease' }}
        />
        <text x="60" y="57" textAnchor="middle" className="gauge-num">
          {online ? (latency != null ? latency : '—') : 'off'}
        </text>
        <text x="60" y="74" textAnchor="middle" className="gauge-unit">
          {online ? 'ms' : ''}
        </text>
      </svg>
    </div>
  );
}
