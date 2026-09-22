// 概览页：AI 会话 hero（核心差异化放首屏）+ 快速启动 + 状态统计 + 手机连接指引

import { copyText } from '../lib/clipboard';
import { localApi } from '../lib/local';
import { usePoll } from '../lib/usePoll';
import { fetchDevices, relayHttpBase } from '../lib/target';
import QuickLaunch from './QuickLaunch';
import type { DeviceEntry, LocalInfo, SessionRow } from './types';

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

export default function OverviewPage({ local }: { local: LocalInfo }) {
  const [devices] = usePoll<DeviceEntry[]>(
    () => fetchDevices(local.relayUrl),
    5000,
    [],
    local.relayUrl,
  );
  const [data] = usePoll<{ sessions: SessionRow[] }>(
    () => fetch(localApi('/api/sessions')).then((r) => (r.ok ? r.json() : Promise.reject())),
    3000,
    { sessions: [] },
  );
  const sessions = data.sessions;

  const onlineDevices = devices.filter((d) => d.online).length || (local.relayUrl ? 0 : 1);
  const relayWeb = local.relayUrl ? `${relayHttpBase(local.relayUrl)}/` : null;
  const hero = pickHero(sessions);
  const moreAi = sessions.filter((s) => s.agent && s.id !== hero?.id).length;

  const copy = (text: string) => void copyText(text);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">概览</div>
          <div className="page-sub">设备与终端会话总览</div>
        </div>
        <button className="primary-btn" onClick={() => location.assign('?local=1')}>
          打开本机终端
        </button>
      </div>

      {/* AI 会话 hero：有 AI 在跑 → 实时状态大卡；没有 → 快速启动 */}
      {hero ? (
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
          <div className="stat-label">在线设备</div>
          <div className="stat-value">{local.relayUrl ? onlineDevices : 1}</div>
          <div className="stat-foot">{local.relayUrl ? '经中继可见' : '连接中继后可见更多'}</div>
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
          <div className="stat-foot mono">{local.relayUrl ?? '配置中继后手机可远程接入'}</div>
        </div>
      </div>

      <div className="page-cols">
        <div className="panel-card">
          <div className="panel-title">快捷操作</div>
          <div className="quick-actions">
            <button className="primary-btn" onClick={() => location.assign('?local=1')}>
              打开本机终端
            </button>
            <button className="ghost-btn" onClick={() => copy(local.deviceId)}>
              复制设备 ID
            </button>
            <button className="ghost-btn" onClick={() => copy(local.accessToken)}>
              复制访问令牌
            </button>
            <button className="ghost-btn" onClick={() => (location.hash = '#/relay')}>
              配置中继
            </button>
          </div>
        </div>

        <div className="panel-card">
          <div className="panel-title">手机如何连进来</div>
          {relayWeb ? (
            <ol className="steps">
              <li>
                手机浏览器打开 <span className="mono accent">{relayWeb}</span>
              </li>
              <li>点「查看设备」→ 选择本机（{local.deviceId.slice(0, 8)}）</li>
              <li>输入访问令牌连接 —— 令牌在「设置 → 关于」里</li>
            </ol>
          ) : (
            <div className="info-hint">
              还没有连接中继。到「中继服务」页填入你的中继地址（例如 wss://relay.example.com/ws），
              手机即可经公网访问本机终端。
            </div>
          )}
          <div className="panel-foot">🔒 全程端到端加密，中继无法读取会话内容</div>
        </div>
      </div>
    </div>
  );
}
