// Sessions 页：本机会话监控（运行中的终端会话列表）

import { usePoll } from '../lib/usePoll';
import type { SessionRow } from './types';

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export default function SessionsPage() {
  const [data] = usePoll<{ sessions: SessionRow[] }>(
    () => fetch('/api/sessions').then((r) => (r.ok ? r.json() : Promise.reject())),
    3000,
    { sessions: [] },
  );
  const sessions = data.sessions;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Sessions</div>
          <div className="page-sub">监控与恢复</div>
        </div>
        <button className="primary-btn" onClick={() => location.assign('?local=1')}>
          新建会话
        </button>
      </div>

      {sessions.length === 0 ? (
        <div className="empty-table">
          <div className="empty-title">没有运行中的会话</div>
          <div className="empty-sub">创建一个终端，或让 Claude Code / Aider 在家里跑着</div>
          <button className="primary-btn" onClick={() => location.assign('?local=1')}>
            新建会话
          </button>
        </div>
      ) : (
        <div className="ra-table">
          <div className="ra-row head">
            <div className="col-sid">会话</div>
            <div className="col-cmd">命令</div>
            <div className="col-time">启动时间</div>
            <div className="col-state">状态</div>
            <div className="col-act">操作</div>
          </div>
          {sessions.map((s) => (
            <div key={s.id} className="ra-row">
              <div className="col-sid mono accent">#{s.id.slice(2, 8)}</div>
              <div className="col-cmd mono">{s.cmd}</div>
              <div className="col-time">{timeAgo(s.startedAt)}</div>
              <div className="col-state">
                <span className="pill on">运行中</span>
              </div>
              <div className="col-act">
                <button className="mini-btn accent" onClick={() => location.assign('?local=1')}>
                  打开
                </button>
              </div>
            </div>
          ))}
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
