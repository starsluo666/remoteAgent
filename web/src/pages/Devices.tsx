// 设备页：本机设备卡片（当前 AI / 查看者 / 会话实时状态）。
// 全私有模型：中继不做设备枚举，连接其他设备走配对链接（Connect 弹窗）。

import { useState } from 'react';
import { localApi } from '../lib/local';
import { usePoll } from '../lib/usePoll';
import Connect from '../Connect';
import AddDeviceWizard from './AddDeviceWizard';
import type { LocalInfo, SessionRow } from './types';

const AGENT_NAME: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' };
const STATUS_LABEL: Record<string, string> = {
  starting: '启动中',
  working: '思考中',
  error: '出错',
  finished: '已完成',
};

export default function DevicesPage({ local }: { local: LocalInfo }) {
  const [data] = usePoll<{ sessions: SessionRow[] }>(
    () => fetch(localApi('/api/sessions')).then((r) => (r.ok ? r.json() : Promise.reject())),
    3000,
    { sessions: [] },
  );
  const [wizardOpen, setWizardOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);

  const sessions = data.sessions;
  // 本机"当前 AI"：进行中的优先，取最新
  const rank: Record<string, number> = { working: 0, starting: 1, error: 2, finished: 3 };
  const ai = sessions
    .filter((s) => s.agent)
    .sort(
      (a, b) =>
        (rank[a.agentStatus ?? ''] ?? 9) - (rank[b.agentStatus ?? ''] ?? 9) || b.startedAt - a.startedAt,
    )[0];

  // 远程端（本机无 daemon）：不显示本机表，只保留连接入口
  const remote = !local.deviceId;

  return (
    <div className="page">
      <div className="page-head">
        <div data-tauri-drag-region>
          <div className="page-title">设备</div>
          <div className="page-sub">
            {remote ? '连接你的电脑，查看并接管它的终端会话' : '本机设备状态；连接其他设备请使用对方发来的配对链接'}
          </div>
        </div>
        {!remote && (
          <div className="head-actions">
            <button className="primary-btn" onClick={() => setConnectOpen(true)}>
              连接远程设备
            </button>
            <button className="ghost-btn" onClick={() => setWizardOpen(true)}>
              ＋ 添加新设备
            </button>
          </div>
        )}
      </div>

      {remote ? (
        <div className="panel-card">
          <div className="panel-title">连接设备</div>
          <div className="info-hint">
            粘贴家里电脑的配对链接（家机面板概览页一键复制），连接后即可查看它的 AI 会话与终端。
          </div>
          <div className="quick-actions" style={{ marginTop: 12 }}>
            <button className="primary-btn" onClick={() => setConnectOpen(true)}>
              连接远程设备
            </button>
          </div>
        </div>
      ) : (
      <div className="ra-table">
        <div className="ra-row head">
          <div className="col-name">设备</div>
          <div className="col-ai">当前 AI</div>
          <div className="col-viewers">查看者</div>
          <div className="col-state">状态</div>
          <div className="col-act">操作</div>
        </div>

        <div className="ra-row">
          <div className="col-name">
            <span className="row-ico">🖥️</span>
            <div>
              <div className="row-title">本机设备</div>
              <div className="row-sub mono">{local.deviceId || '—'}</div>
            </div>
          </div>
          <div className="col-ai">
            {ai ? (
              <div className="ai-cell">
                <span className={`ai-pill ai-${ai.agentStatus ?? 'starting'}`}>
                  <span className="ai-dot" />
                  {STATUS_LABEL[ai.agentStatus ?? ''] ?? 'AI'}
                </span>
                <span className="row-sub">
                  {AGENT_NAME[ai.agent ?? ''] ?? ai.agent} · {sessions.length} 会话
                </span>
              </div>
            ) : (
              <span className="row-sub">{sessions.length > 0 ? `${sessions.length} 个终端会话` : '—'}</span>
            )}
          </div>
          <div className="col-viewers mono">{local.relayOnline ? (local.relayViewers ?? '…') : '—'}</div>
          <div className="col-state">
            <span className="pill on">运行中</span>
          </div>
          <div className="col-act">
            <button className="mini-btn accent" onClick={() => location.assign('?local=1')}>
              打开终端
            </button>
          </div>
        </div>
      </div>

      )}

      {wizardOpen && <AddDeviceWizard local={local} onClose={() => setWizardOpen(false)} />}
      {connectOpen && <Connect onClose={() => setConnectOpen(false)} />}
    </div>
  );
}
