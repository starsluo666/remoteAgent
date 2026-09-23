// 桌面壳自绘窗口按钮（无边框窗口）：最小化 / 最大化 / 关闭。
// 挂在 App 最外层 —— 面板、终端、连接页都常驻可见。

import { LOCAL_BASE } from './lib/local';

function tauriWindow():
  | {
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<void>;
      close: () => Promise<void>;
    }
  | undefined {
  const w = window as unknown as {
    __TAURI__?: { window?: { getCurrentWindow?: () => unknown } };
  };
  return w.__TAURI__?.window?.getCurrentWindow?.() as
    | { minimize: () => Promise<void>; toggleMaximize: () => Promise<void>; close: () => Promise<void> }
    | undefined;
}

export default function WindowCaps() {
  if (!LOCAL_BASE) return null;
  const btn = (label: string, title: string, fn: 'minimize' | 'toggleMaximize' | 'close') => (
    <button
      className="win-cap"
      title={title}
      onClick={() => {
        const w = tauriWindow();
        if (w) void w[fn]();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="win-caps" data-tauri-drag-region>
      {btn('—', '最小化', 'minimize')}
      {btn('□', '最大化 / 还原', 'toggleMaximize')}
      {btn('✕', '关闭', 'close')}
    </div>
  );
}
