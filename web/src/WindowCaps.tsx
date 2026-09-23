// 桌面壳自绘窗口按钮（无边框窗口）：最小化 / 最大化 / 关闭。
// 挂在 App 最外层 —— 面板、终端、连接页都常驻可见。

import type { ReactNode } from 'react';
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
  const btn = (
    title: string,
    fn: 'minimize' | 'toggleMaximize' | 'close',
    icon: ReactNode,
  ) => (
    <button
      className={`win-cap ${fn === 'close' ? 'is-close' : ''}`}
      title={title}
      onClick={() => {
        const w = tauriWindow();
        if (w) void w[fn]();
      }}
    >
      {icon}
    </button>
  );
  return (
    <div className="win-caps" data-tauri-drag-region>
      {btn(
        '最小化',
        'minimize',
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M2.5 6h7" />
        </svg>,
      )}
      {btn(
        '最大化 / 还原',
        'toggleMaximize',
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2.5" y="2.5" width="7" height="7" rx="1.6" />
        </svg>,
      )}
      {btn(
        '关闭',
        'close',
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6" />
        </svg>,
      )}
    </div>
  );
}
