// 主题管理：深色 / 浅色 / 跟随系统。存 localStorage，入口尽早应用避免闪色。

export type Theme = 'dark' | 'light' | 'system';

const KEY = 'ra.theme';

export function storedTheme(): Theme {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'system' ? v : 'dark';
}

function resolve(t: Theme): 'dark' | 'light' {
  if (t !== 'system') return t;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = resolve(t);
}

export function setTheme(t: Theme): void {
  localStorage.setItem(KEY, t);
  applyTheme(t);
}

/** 入口调用：应用存储的主题并监听系统偏好变化（跟随系统模式） */
export function initTheme(): void {
  applyTheme(storedTheme());
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (storedTheme() === 'system') applyTheme('system');
  });
}
