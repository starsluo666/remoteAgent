// 桌面通知（Web Notification API）：浏览器 / 手机 PWA 可用。
// 触发原则：仅应用不可见时打扰（可见时界面本身就在展示状态）。

const KEY = 'ra.notify';

export function notifySupported(): boolean {
  return typeof Notification !== 'undefined';
}

export function notifyPermission(): NotificationPermission | 'unsupported' {
  return notifySupported() ? Notification.permission : 'unsupported';
}

export function notifyEnabled(): boolean {
  return localStorage.getItem(KEY) === '1';
}

export function setNotifyEnabled(v: boolean): void {
  localStorage.setItem(KEY, v ? '1' : '0');
}

/** 开启开关时的权限请求；返回是否最终可用 */
export async function requestNotifyPermission(): Promise<boolean> {
  if (!notifySupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  return (await Notification.requestPermission()) === 'granted';
}

/** 发通知（应用可见时静默跳过） */
export function notify(title: string, body: string, tag?: string): void {
  if (!notifyEnabled() || !notifySupported()) return;
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  try {
    new Notification(title, { body, tag, icon: 'favicon.svg' });
  } catch {
    // 某些环境（WebView2）不支持构造式通知 —— 静默
  }
}
