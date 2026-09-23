// 设置页（对齐设计稿三栏）：主侧栏之外，内容区再分「分类侧栏 + 设置内容」。
// 终端字号为真实偏好（写入 localStorage，终端工作区创建 xterm 时读取）。
// 设备 ID / 访问令牌在「概览」页展示与编辑。

import { useState } from 'react';
import { localApi } from '../lib/local';
import { setTheme, storedTheme, type Theme } from '../lib/theme';
import {
  notifyEnabled,
  notifyPermission,
  notifySupported,
  requestNotifyPermission,
  setNotifyEnabled,
} from '../lib/notify';
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

export default function SettingsPage({
  local: _local,
  onHelp,
}: {
  local: LocalInfo;
  /** 手机端帮助入口（底部导航无帮助 tab，收进设置页） */
  onHelp?: () => void;
}) {
  const [cat, setCat] = useState<Cat>('general');
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem(FONT_KEY)) || 14);
  const [autostart, setAutostart] = useState(_local.autostart ?? false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [theme, setThemeState] = useState<Theme>(() => storedTheme());
  const [notifyOn, setNotifyOn] = useState(() => notifyEnabled());
  const [notifyPerm, setNotifyPerm] = useState(() => notifyPermission());

  const pickTheme = (t: Theme) => {
    setTheme(t);
    setThemeState(t);
  };

  const toggleNotify = async () => {
    if (!notifyOn) {
      const ok = await requestNotifyPermission();
      setNotifyPerm(notifyPermission());
      if (!ok) return; // 权限没拿到：保持关闭，提示行会说明
      setNotifyEnabled(true);
      setNotifyOn(true);
    } else {
      setNotifyEnabled(false);
      setNotifyOn(false);
    }
  };

  const toggleAutostart = async () => {
    setAutostartBusy(true);
    try {
      const r = await fetch(localApi('/api/local/autostart'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !autostart }),
      });
      const v = (await r.json()) as { enabled?: boolean };
      if (v.enabled != null) setAutostart(v.enabled);
    } finally {
      setAutostartBusy(false);
    }
  };

  const applyFontSize = (v: number) => {
    setFontSize(v);
    localStorage.setItem(FONT_KEY, String(v));
  };

  return (
    <div className="page">
      <div className="page-head">
        <div data-tauri-drag-region>
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
                    <div className="set-desc">
                      登录 Windows 后自动运行 daemon 并恢复中继连接（隐藏窗口，无需管理员）
                    </div>
                  </div>
                  <button
                    className={`switch ${autostart ? 'on' : ''}`}
                    disabled={autostartBusy}
                    onClick={() => void toggleAutostart()}
                    role="switch"
                    aria-checked={autostart}
                  >
                    <span className="knob" />
                  </button>
                </div>
                <div className="set-row">
                  <div>
                    <div className="set-name">桌面通知</div>
                    <div className="set-desc">
                      {notifySupported()
                        ? notifyPerm === 'denied'
                          ? '浏览器已拒绝通知权限 —— 在浏览器站点设置里允许后重开开关'
                          : 'AI 任务完成 / 出错、会话退出时推送（应用在后台时才打扰）'
                        : '当前环境不支持系统通知'}
                    </div>
                  </div>
                  <button
                    className={`switch ${notifyOn && notifyPerm === 'granted' ? 'on' : ''}`}
                    disabled={!notifySupported() || notifyPerm === 'denied'}
                    onClick={() => void toggleNotify()}
                    role="switch"
                    aria-checked={notifyOn && notifyPerm === 'granted'}
                  >
                    <span className="knob" />
                  </button>
                </div>
                {onHelp && (
                  <div className="set-row">
                    <div>
                      <div className="set-name">帮助与排障</div>
                      <div className="set-desc">快速上手、连接流程、常见问题</div>
                    </div>
                    <button className="mini-btn" onClick={onHelp}>
                      打开
                    </button>
                  </div>
                )}
              </div>
            </>
          )}

          {cat === 'appearance' && (
            <div className="panel-card">
              <div className="panel-title">外观</div>
              <div className="set-row">
                <div>
                  <div className="set-name">主题</div>
                  <div className="set-desc">界面配色（终端画布保持深色）</div>
                </div>
                <div className="seg">
                  {(
                    [
                      ['dark', '深色'],
                      ['light', '浅色'],
                      ['system', '跟随系统'],
                    ] as [Theme, string][]
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      className={`seg-item ${theme === v ? 'active' : ''}`}
                      onClick={() => pickTheme(v)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
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
              <div className="relay-hint">
                设备 ID 与访问令牌在「概览」页展示，令牌可直接编辑。
                安全模型：中继零信任 —— 不枚举设备、不读会话内容，连接唯一入口是配对链接
                （设备 ID + 访问令牌）。
              </div>
              <div className="relay-hint">
                也可用命令行 <code>remoteagent-daemon --rotate-access-token</code> 换回随机长令牌
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
