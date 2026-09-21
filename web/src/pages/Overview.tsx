// 概览页：状态统计 + 快捷操作 + 手机连接指引

import { copyText } from '../lib/clipboard';
import { usePoll } from '../lib/usePoll';
import { fetchDevices, relayHttpBase } from '../lib/target';
import type { DeviceEntry, LocalInfo, SessionRow } from './types';

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts * 1000) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 86400)} 天前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export default function OverviewPage({ local }: { local: LocalInfo }) {
  const [devices] = usePoll<DeviceEntry[]>(
    () => fetchDevices(local.relayUrl),
    5000,
    [],
    local.relayUrl,
  );
  const [sessions] = usePoll<{ sessions: SessionRow[] }>(
    () => fetch('/api/sessions').then((r) => (r.ok ? r.json() : Promise.reject())),
    5000,
    { sessions: [] },
  );

  const onlineDevices = devices.filter((d) => d.online).length || (local.relayUrl ? 0 : 1);
  const relayWeb = local.relayUrl ? `${relayHttpBase(local.relayUrl)}/` : null;

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

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">在线设备</div>
          <div className="stat-value">{local.relayUrl ? onlineDevices : 1}</div>
          <div className="stat-foot">{local.relayUrl ? '经中继可见' : '连接中继后可见更多'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">活跃会话</div>
          <div className="stat-value">{sessions.sessions.length}</div>
          <div className="stat-foot">
            {sessions.sessions.length > 0
              ? `最近启动 ${timeAgo(
                  Math.max(...sessions.sessions.map((s) => s.startedAt)) || Date.now(),
                )}`
              : '暂无运行中的会话'}
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

      <div className="todo-card">
        <div className="todo-title">AI 会话感知</div>
        <div className="todo-sub">
          识别 Claude Code / Aider 等会话状态、Token 统计与快捷接管 —— 即将支持（v0.1 后续里程碑）
        </div>
      </div>
    </div>
  );
}
