// 连接目标解析：终端模式（远程中继 / 本地直连）的判定。
// - #relay=…&device=<id>&token=<t>（或旧式 ?query，token 不发给服务器，推荐 fragment）
// - ?local=1 / #local=1 → 本地模式（daemon 直连）
// - 无参数 → null（本机桌面应用 / 连接页）

import type { HelloFields } from './daemon';
import { LOCAL_WS } from './local';

export interface Target {
  url: string;
  hello: HelloFields;
  mode: string;
}

/** 合并 query 与 hash 参数（query 优先，兼容旧链接；fragment 按 HTTP 规范不上行，token 走这里） */
export function mergedParams(): URLSearchParams {
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  for (const [k, v] of h) {
    if (!q.has(k)) q.set(k, v);
  }
  return q;
}

/** 从 URL 文本提取合并参数（解析配对链接用，同样兼容 query/hash 两种格式） */
export function paramsOf(u: URL): URLSearchParams {
  const merged = new URLSearchParams(u.search);
  const h = new URLSearchParams(u.hash.replace(/^#/, ''));
  for (const [k, v] of h) {
    if (!merged.has(k)) merged.set(k, v);
  }
  return merged;
}

export function target(): Target | null {
  const q = mergedParams();
  const device = q.get('device');
  const token = q.get('token') ?? undefined;
  const relay = q.get('relay');
  if (device) {
    const url = relay
      ? relay
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    return { url, hello: { deviceId: device, token }, mode: 'relay' };
  }
  if (q.get('local') === '1') {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return {
      // 桌面壳（tauri.localhost）下用绝对地址连本机 daemon
      url: LOCAL_WS || `${proto}://${location.host}/ws`,
      hello: { deviceId: 'local-browser' },
      mode: 'local',
    };
  }
  return null;
}

/** 中继 ws 地址 → HTTP 基址（daemon 托管页面跨源访问中继 API 用） */
export function relayHttpBase(relayUrl: string | null): string {
  if (!relayUrl) return '';
  return relayUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://').replace(/\/ws$/, '');
}

/** 拉取中继设备列表（中继未连接时返回空） */
export async function fetchDevices(relayUrl: string | null): Promise<{ deviceId: string; online: boolean; viewers?: number }[]> {
  const base = relayHttpBase(relayUrl);
  const r = await fetch(`${base}/api/devices`);
  if (!r.ok) throw new Error(`devices ${r.status}`);
  const ct = r.headers.get('content-type') ?? '';
  if (!ct.includes('json')) throw new Error('not a relay');
  return r.json();
}
