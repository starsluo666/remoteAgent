// Sessions 页：会话监控表（ID / Agent / 状态 / 时长 / 操作）

import { localApi } from '../lib/local';
import { usePoll } from '../lib/usePoll';
import QuickLaunch from './QuickLaunch';
import type { SessionRow } from './types';

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts * 1000) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function duration(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts * 1000) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

/** 按启动命令推导 Agent 类型（M7 会升级为输出流识别） */
function agentOf(cmd: string): { label: string; cls: string } {
  const c = cmd.toLowerCase();
  if (c.includes('claude')) return { label: 'Claude Code', cls: 'agent-cc' };
  if (c.includes('aider')) return { label: 'Aider', cls: 'agent-aider' };
  if (c.includes('codex')) return { label: 'Codex', cls: 'agent-codex' };
  return { label: '终端', cls: 'agent-term' };
}

export default function SessionsPage() {
  const [data] = usePoll<{ sessions: SessionRow[] }>(
    () => fetch(localApi('/api/sessions')).then((r) => (r.ok ? r.json() : Promise.reject())),
    3000,
    { sessions: [] },
  );
  const sessions = data.sessions;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Sessions</div>
          <div className="page-sub">监控与恢复 · {sessions.length} 个运行中</div>
        </div>
        <button className="primary-btn" onClick={() => location.assign('?local=1')}>
          新建会话
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="empty-table">
          <div className="empty-title">没有运行中的会话</div>
          <div className="empty-sub">选择一个工作台启动 —— 会话在家里跑着，手机/浏览器随时接管</div>
          <QuickLaunch hint="需要对应 CLI 已安装并登录（codex / claude）" />
        </div>
      ) : (
        <div className="ra-table">
          <div className="ra-row head">
            <div className="col-sid">会话</div>
            <div className="col-agent">Agent</div>
            <div className="col-time">启动时间</div>
            <div className="col-dur">时长</div>
            <div className="col-state">状态</div>
            <div className="col-act">操作</div>
          </div>
          {sessions.map((s) => {
            const agent = agentOf(s.cmd);
            return (
              <div key={s.id} className="ra-row">
                <div className="col-sid mono accent">#{s.id.slice(2, 8)}</div>
                <div className="col-agent">
                  <span className={`agent-pill ${agent.cls}`}>{agent.label}</span>
                </div>
                <div className="col-time">{timeAgo(s.startedAt)}</div>
                <div className="col-dur mono">{duration(s.startedAt)}</div>
                <div className="col-state">
                  {s.agentStatus ? (
                    <span className={`ai-pill ai-${s.agentStatus}`} title={s.agentDetail ?? ''}>
                      <span className="ai-dot" />
                      {{ starting: '启动中', working: '处理中', error: '出错', finished: '已完成' }[s.agentStatus] ?? s.agentStatus}
                    </span>
                  ) : (
                    <span className="pill on">运行中</span>
                  )}
                </div>
                <div className="col-act">
                  <button className="mini-btn accent" onClick={() => location.assign('?local=1')}>
                    打开
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="todo-card">
        <div className="todo-title">会话时间线与回放</div>
        <div className="todo-sub">
          按时间线回看 AI 的消息流、工具调用与代码改动 —— 即将支持（v0.1 后续里程碑）
        </div>
      </div>
    </div>
  );
}
