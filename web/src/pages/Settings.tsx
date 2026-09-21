// 设置页（对齐设计稿三栏）：主侧栏之外，内容区再分「分类侧栏 + 设置内容」。
// 终端字号为真实偏好（写入 localStorage，终端工作区创建 xterm 时读取）。

import { useState } from 'react';
import { copyText } from '../lib/clipboard';
import type { LocalInfo } from './types';

type Cat = 'general' | 'appearance' | 'ai' | 'terminal' | 'about';

const CATS: { id: Cat; label: string; icon: string }[] = [
  { id: 'general', label: '常规', icon: '⚙️' },
  { id: 'appearance', label: '外观', icon: '🎨' },
  { id: 'ai', label: 'AI 助手', icon: '🤖' },
  { id: 'terminal', label: '终端', icon: '⌨️' },
  { id: 'about', label: '关于', icon: 'ℹ️' },
];

const FONT_KEY = 'ra.termFontSize';

export default function SettingsPage({ local }: { local: LocalInfo }) {
  const [cat, setCat] = useState<Cat>('general');
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem(FONT_KEY)) || 14);

  const copy = (text: string, label: string) => {
    void copyText(text).then((ok) => {
      setCopied(ok ? `${label}已复制` : `${label}复制失败`);
      window.setTimeout(() => setCopied(null), 2000);
    });
  };

  const applyFontSize = (v: number) => {
    setFontSize(v);
    localStorage.setItem(FONT_KEY, String(v));
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">设置</div>
          <div className="page-sub">本机 daemon 的身份与偏好</div>
        </div>
      </div>

      <div className="settings-layout">
        <aside className="settings-cats">
          {CATS.map((c) => (
            <button key={c.id} className={`cat-item ${cat === c.id ? 'active' : ''}`} onClick={() => setCat(c.id)}>
              <span className="cat-ico">{c.icon}</span>
              {c.label}
            </button>
          ))}
        </aside>

        <div className="settings-content">
          {cat === 'general' && (
            <>
              <div className="panel-card">
                <div className="panel-title">常规</div>
                <div className="set-row">
                  <div>
                    <div className="set-name">开机自启</div>
                    <div className="set-desc">系统启动时自动运行 daemon 并恢复中继连接</div>
                  </div>
                  <span className="soon-pill">即将支持</span>
                </div>
                <div className="set-row">
                  <div>
                    <div className="set-name">桌面通知</div>
                    <div className="set-desc">会话退出 / 接管请求时推送系统通知</div>
                  </div>
                  <span className="soon-pill">即将支持</span>
                </div>
              </div>
            </>
          )}

          {cat === 'appearance' && (
            <div className="panel-card">
              <div className="panel-title">外观</div>
              <div className="set-row">
                <div>
                  <div className="set-name">主题</div>
                  <div className="set-desc">深色（内置）</div>
                </div>
                <span className="pill on">深色</span>
              </div>
              <div className="set-row">
                <div>
                  <div className="set-name">浅色主题</div>
                  <div className="set-desc">规划中</div>
                </div>
                <span className="soon-pill">即将支持</span>
              </div>
            </div>
          )}

          {cat === 'ai' && (
            <>
              <div className="panel-card">
                <div className="panel-title">AI 助手</div>
                <div className="set-row">
                  <div>
                    <div className="set-name">会话识别</div>
                    <div className="set-desc">从终端输出识别 Claude Code / Aider / Codex 的运行状态</div>
                  </div>
                  <span className="soon-pill">M7 里程碑</span>
                </div>
              </div>
              <div className="ai-profiles">
                <div className="ai-card">
                  <div className="ai-head">
                    <span className="agent-pill agent-cc">Claude Code</span>
                    <span className="pill off">未检测</span>
                  </div>
                  <div className="set-desc">状态条显示 · Token 统计 · 快捷接管 —— M7 提供</div>
                </div>
                <div className="ai-card">
                  <div className="ai-head">
                    <span className="agent-pill agent-aider">Aider</span>
                    <span className="pill off">未检测</span>
                  </div>
                  <div className="set-desc">同上，基于输出流规则识别</div>
                </div>
                <div className="ai-card">
                  <div className="ai-head">
                    <span className="agent-pill agent-codex">Codex</span>
                    <span className="pill off">未检测</span>
                  </div>
                  <div className="set-desc">同上</div>
                </div>
              </div>
            </>
          )}

          {cat === 'terminal' && (
            <div className="panel-card">
              <div className="panel-title">终端</div>
              <div className="set-row">
                <div>
                  <div className="set-name">字号</div>
                  <div className="set-desc">当前 {fontSize}px —— 新开的终端标签生效</div>
                </div>
                <input
                  type="range"
                  min={12}
                  max={18}
                  step={1}
                  value={fontSize}
                  onChange={(e) => applyFontSize(Number(e.target.value))}
                  className="font-slider"
                />
              </div>
              <div className="set-row">
                <div>
                  <div className="set-name">字体</div>
                  <div className="set-desc mono">JetBrains Mono / Cascadia Mono / Consolas</div>
                </div>
                <span className="pill on">内置</span>
              </div>
              <div className="set-row">
                <div>
                  <div className="set-name">回滚行数</div>
                  <div className="set-desc">每会话保留的历史输出行数 —— 新开的终端标签生效</div>
                </div>
                <select
                  className="set-select"
                  value={localStorage.getItem('ra.termScrollback') ?? '5000'}
                  onChange={(e) => localStorage.setItem('ra.termScrollback', e.target.value)}
                >
                  <option value="1000">1000 行</option>
                  <option value="5000">5000 行</option>
                  <option value="10000">10000 行</option>
                </select>
              </div>
            </div>
          )}

          {cat === 'about' && (
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
          )}
        </div>
      </div>
    </div>
  );
}
