// 概览页：AI 会话 hero + 设备身份卡（ID/令牌，令牌可编辑）+ 状态统计 + 配对链接指引

import { useEffect, useRef, useState } from 'react';
import { copyText } from '../lib/clipboard';
import { localApi } from '../lib/local';
import { usePoll } from '../lib/usePoll';
import { relayHttpBase } from '../lib/target';
import QuickLaunch from './QuickLaunch';
import type { LocalInfo, SessionRow } from './types';

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts * 1000) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function duration(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m${s % 60}s`;
}

const AGENT_NAME: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' };
const STATUS_LABEL: Record<string, string> = {
  starting: '启动中',
  working: '思考中',
  error: '出错',
  finished: '已完成',
};

/** 挑 hero 会话：进行中的 AI 优先（working > starting > error > finished），无 AI 返回 null */
function pickHero(sessions: SessionRow[]): SessionRow | null {
  const ais = sessions.filter((s) => s.agent);
  if (ais.length === 0) return null;
  const rank: Record<string, number> = { working: 0, starting: 1, error: 2, finished: 3 };
  return [...ais].sort(
    (a, b) => (rank[a.agentStatus ?? ''] ?? 9) - (rank[b.agentStatus ?? ''] ?? 9) || b.startedAt - a.startedAt,
  )[0];
}

export default function OverviewPage({ local, refresh }: { local: LocalInfo; refresh: () => void }) {
  const [data] = usePoll<{ sessions: SessionRow[] }>(
    () => fetch(localApi('/api/sessions')).then((r) => (r.ok ? r.json() : Promise.reject())),
    3000,
    { sessions: [] },
  );
  const sessions = data.sessions;

  const relayWeb = local.relayUrl ? `${relayHttpBase(local.relayUrl)}/` : null;
  const hero = pickHero(sessions);
  const moreAi = sessions.filter((s) => s.agent && s.id !== hero?.id).length;

  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string, label: string) => {
    void copyText(text).then((ok) => {
      setCopied(ok ? `${label}已复制` : `${label}复制失败`);
      window.setTimeout(() => setCopied(null), 2000);
    });
  };

  // 令牌编辑（原设置页能力移到概览）
  const [editingToken, setEditingToken] = useState(false);
  const [newToken, setNewToken] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenMsg, setTokenMsg] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const saveToken = async () => {
    const t = newToken.trim();
    if (t.length < 8 || /\s/.test(t)) {
      setTokenMsg('令牌需至少 8 位且不含空格');
      return;
    }
    setTokenBusy(true);
    setTokenMsg(null);
    try {
      const r = await fetch(localApi('/api/local/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t }),
      });
      if (!r.ok) throw new Error((await r.text()) || '保存失败');
      setEditingToken(false);
      setNewToken('');
      setTokenMsg('✓ 已生效 —— 旧配对链接立即失效，请用新令牌重新配对');
      refresh();
    } catch (e) {
      setTokenMsg(`保存失败：${String(e).slice(0, 80)}`);
    } finally {
      setTokenBusy(false);
    }
  };

  const pairingLink = relayWeb
    ? `${relayWeb}#device=${local.deviceId}&token=${local.accessToken}`
    : null;

  // 下拉刷新（移动端）：页面顶界下拉 → 松手触发 refresh
  const pageRef = useRef<HTMLDivElement>(null);
  const [pull, setPull] = useState(0); // 0=静止 -1=刷新中 >0=拉动距离
  useEffect(() => {
    const el = pageRef.current;
    if (!el || matchMedia('(min-width: 761px)').matches) return;
    let startY = 0;
    let active = false;
    let dist = 0;
    const ts = (e: TouchEvent) => {
      if (window.scrollY <= 0 && el.getBoundingClientRect().top >= -1) {
        startY = e.touches[0].clientY;
        active = true;
      }
    };
    const tm = (e: TouchEvent) => {
      if (!active) return;
      dist = e.touches[0].clientY - startY;
      if (dist > 0 && dist < 110) setPull(dist);
    };
    const te = () => {
      if (!active) return;
      active = false;
      if (dist > 70) {
        setPull(-1);
        refresh();
        window.setTimeout(() => setPull(0), 700);
      } else {
        setPull(0);
      }
      dist = 0;
    };
    el.addEventListener('touchstart', ts, { passive: true });
    el.addEventListener('touchmove', tm, { passive: true });
    el.addEventListener('touchend', te);
    return () => {
      el.removeEventListener('touchstart', ts);
      el.removeEventListener('touchmove', tm);
      el.removeEventListener('touchend', te);
    };
  }, [refresh]);

  return (
    <div className="page" ref={pageRef}>
      {pull !== 0 && (
        <div className={`ptr-indicator ${pull === -1 ? 'pulling' : pull > 70 ? 'pulling' : ''}`}>
          {pull === -1 ? (
            <>
              <span className="spin">⟳</span> 刷新中…
            </>
          ) : pull > 70 ? (
            '↑ 松手刷新'
          ) : (
            '↓ 下拉刷新'
          )}
        </div>
      )}
      <div className="page-head" data-tauri-drag-region>
        <div>
          <div className="page-title">概览</div>
          <div className="page-sub">设备身份与终端会话总览</div>
        </div>
        <button className="primary-btn" onClick={() => location.assign('?local=1')}>
          打开本机终端
        </button>
      </div>

      {/* AI 会话 hero：有 AI 在跑 → 实时状态大卡；远程端 → 连接指引；本机无会话 → 快速启动 */}
      {!local.deviceId && !hero ? (
        <div className="ai-hero launch">
          <div className="ai-hero-head">
            <span className="ai-hero-ico dim">🤖</span>
            <div className="ai-hero-main">
              <div className="ai-hero-title">连接你的电脑</div>
              <div className="ai-hero-meta">
                远程端 · 到「设备 → 连接远程设备」粘贴家里电脑的配对链接，即可查看与接管它的 AI 会话
              </div>
            </div>
          </div>
        </div>
      ) : hero ? (
        <div className="ai-hero">
          <div className="ai-hero-head">
            <span className="ai-hero-ico">🤖</span>
            <div className="ai-hero-main">
              <div className="ai-hero-title">
                {AGENT_NAME[hero.agent ?? ''] ?? hero.agent} ·{' '}
                {STATUS_LABEL[hero.agentStatus ?? ''] ?? '运行中'}
                <span className="ai-hero-dur mono">· {duration(hero.startedAt)}</span>
              </div>
              <div className="ai-hero-meta mono" title={hero.agentDetail ?? ''}>
                #{hero.id.slice(2, 8)} · {hero.cmd.slice(0, 60)}
                {hero.agentDetail ? ` · ${hero.agentDetail.slice(0, 60)}` : ''}
              </div>
            </div>
            <span className={`ai-pill ai-${hero.agentStatus ?? 'starting'}`}>
              <span className="ai-dot" />
              {STATUS_LABEL[hero.agentStatus ?? ''] ?? 'AI'}
            </span>
          </div>
          <div className="ai-hero-actions">
            <button className="primary-btn" onClick={() => location.assign('?local=1')}>
              查看终端
            </button>
            <button className="ghost-btn" onClick={() => location.assign('?local=1&takeover=1')}>
              ⌨ 接管输入
            </button>
            {moreAi > 0 && <span className="ai-hero-more">另有 {moreAi} 个 AI 会话</span>}
          </div>
        </div>
      ) : (
        <div className="ai-hero launch">
          <div className="ai-hero-head">
            <span className="ai-hero-ico dim">🤖</span>
            <div className="ai-hero-main">
              <div className="ai-hero-title">启动一个 AI 会话</div>
              <div className="ai-hero-meta">在 home 机上跑 Codex / Claude Code，手机随时接管</div>
            </div>
          </div>
          <QuickLaunch />
        </div>
      )}

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">设备 ID</div>
          <div className="stat-value mono" style={{ fontSize: 15, wordBreak: 'break-all' }}>
            {local.deviceId || '—'}
          </div>
          <button className="mini-btn" style={{ marginTop: 6 }} onClick={() => copy(local.deviceId, '设备 ID')}>
            复制
          </button>
        </div>
        <div className="stat-card">
          <div className="stat-label">访问令牌</div>
          <div className="stat-value mono" style={{ fontSize: 15, wordBreak: 'break-all' }}>
            {showToken ? local.accessToken : '•'.repeat(12)}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button className="mini-btn" onClick={() => setShowToken(!showToken)}>
              {showToken ? '隐藏' : '显示'}
            </button>
            <button className="mini-btn accent" onClick={() => setEditingToken(!editingToken)}>
              编辑
            </button>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label">活跃会话</div>
          <div className="stat-value">{sessions.length}</div>
          <div className="stat-foot">
            {sessions.length > 0
              ? `最近启动 ${timeAgo(Math.max(...sessions.map((s) => s.startedAt)) || Date.now())}`
              : '点上方卡片一键启动'}
          </div>
        </div>
        <div className={`stat-card ${local.relayOnline ? 'good' : local.relayUrl ? 'warn' : ''}`}>
          <div className="stat-label">中继服务</div>
          <div className="stat-value">{local.relayOnline ? '已连接' : local.relayUrl ? '重试中' : '未连接'}</div>
          <div className="stat-foot mono">
            {local.relayUrl
              ? `${local.relayUrl.replace(/^wss?:\/\//, '')} · ${local.relayViewers ?? 0} 查看者`
              : '配置中继后手机可远程接入'}
          </div>
        </div>
      </div>

      {editingToken && (
        <div className="token-edit">
          <input
            className="token-input mono"
            value={newToken}
            onChange={(e) => {
              setNewToken(e.target.value);
              setTokenMsg(null);
            }}
            placeholder="新令牌（至少 8 位，建议大小写 + 数字混合）"
            spellCheck={false}
            autoFocus
          />
          <div className="token-edit-actions">
            <button className="primary-btn" disabled={tokenBusy} onClick={() => void saveToken()}>
              {tokenBusy ? '保存中…' : '保存'}
            </button>
            <button
              className="mini-btn"
              onClick={() => {
                setEditingToken(false);
                setNewToken('');
                setTokenMsg(null);
              }}
            >
              取消
            </button>
            <span className="stat-foot">修改后所有已配对设备需用新令牌重新配对；弱口令有被离线爆破的风险</span>
          </div>
        </div>
      )}
      {tokenMsg && <div className="relay-hint">{tokenMsg}</div>}
      {copied && <div className="relay-hint accent">{copied}</div>}

      {/* 远程端：连接指引替代家机配对/快捷操作 */}
      {!local.deviceId ? (
        <div className="panel-card">
          <div className="panel-title">如何连接你的电脑</div>
          <div className="info-hint">
            家里电脑的 RemoteAgent 面板（概览页）有配对链接，复制发到这里；到
            「设备」页粘贴即可连接，之后可查看它的 AI 会话与终端。
          </div>
          <div className="quick-actions" style={{ marginTop: 12 }}>
            <button className="primary-btn" onClick={() => (location.hash = '#/devices')}>
              去设备页连接
            </button>
          </div>
        </div>
      ) : (
        <div className="page-cols">
          <div className="panel-card">
            <div className="panel-title">手机如何连进来</div>
            {pairingLink ? (
              <>
                <div className="info-hint">
                  复制下方配对链接发到手机（微信/短信），手机浏览器打开即连 —— 中继上不展示任何设备列表，连接只认此链接。
                </div>
                <div className="pairing-box mono" onClick={() => copy(pairingLink, '配对链接')} title="点击复制">
                  {pairingLink.length > 72 ? pairingLink.slice(0, 72) + '…' : pairingLink}
                </div>
                <div className="panel-foot">🔒 全程端到端加密，中继无法读取会话内容</div>
              </>
            ) : (
              <div className="info-hint">
                还没有连接中继。到「中继服务」页填入你的中继地址（例如 wss://relay.example.com/ws），
                手机即可经公网访问本机终端。
              </div>
            )}
          </div>

          <div className="panel-card">
            <div className="panel-title">快捷操作</div>
            <div className="quick-actions">
              <button className="primary-btn" onClick={() => location.assign('?local=1')}>
                打开本机终端
              </button>
              <button className="ghost-btn" onClick={() => (location.hash = '#/relay')}>
                配置中继
              </button>
              <button className="ghost-btn" onClick={() => (location.hash = '#/devices')}>
                添加新设备（配对码）
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
