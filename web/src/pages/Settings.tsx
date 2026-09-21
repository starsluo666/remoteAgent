// 设置页：关于/身份 + 功能占位分组

import { useState } from 'react';
import { copyText } from '../lib/clipboard';
import type { LocalInfo } from './types';

export default function SettingsPage({ local }: { local: LocalInfo }) {
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string, label: string) => {
    void copyText(text).then((ok) => {
      setCopied(ok ? `${label}已复制` : `${label}复制失败`);
      window.setTimeout(() => setCopied(null), 2000);
    });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">设置</div>
          <div className="page-sub">本机 daemon 的身份与偏好</div>
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-title">关于</div>
        <div className="info-row">
          <div className="info-label">版本</div>
          <div className="info-value mono">RemoteAgent v0.1</div>
        </div>
        <div className="info-row">
          <div className="info-label">设备 ID</div>
          <div className="info-value mono">{local.deviceId || '—'}</div>
          <button className="mini-btn" onClick={() => copy(local.deviceId, '设备 ID')}>
            复制
          </button>
        </div>
        <div className="info-row">
          <div className="info-label">访问令牌</div>
          <div className="info-value mono">{showToken ? local.accessToken : '•'.repeat(24)}</div>
          <button className="mini-btn" onClick={() => setShowToken(!showToken)}>
            {showToken ? '隐藏' : '显示'}
          </button>
          <button className="mini-btn" onClick={() => copy(local.accessToken, '访问令牌')}>
            复制
          </button>
        </div>
        <div className="relay-hint">
          令牌用于其他设备连接本机。轮换令牌：命令行运行{' '}
          <code>remoteagent-daemon --rotate-access-token</code>（旧令牌立即失效，重启后生效）
        </div>
        {copied && <div className="relay-hint accent">{copied}</div>}
      </div>

      <div className="settings-grid">
        <div className="todo-card">
          <div className="todo-title">常规</div>
          <div className="todo-sub">开机自启、桌面通知 —— 即将支持</div>
        </div>
        <div className="todo-card">
          <div className="todo-title">外观</div>
          <div className="todo-sub">当前为深色主题，浅色主题规划中</div>
        </div>
        <div className="todo-card">
          <div className="todo-title">AI 助手</div>
          <div className="todo-sub">检测规则、状态条、自动接管 —— M7 里程碑</div>
        </div>
        <div className="todo-card">
          <div className="todo-title">终端</div>
          <div className="todo-sub">字体/字号/滚动行数 —— 即将支持</div>
        </div>
      </div>
    </div>
  );
}
