// 连接目标解析：终端模式（远程中继 / 本地直连）的判定。
// - ?relay=ws%3A%2F%2Fhost%3A8080%2Fws&device=<id>&token=<t> → 中继模式（显式指定中继）
// - ?device=<id>&token=<t>（页面由中继托管时）→ 同源 /ws
// - ?local=1 → 本地模式（daemon 直连）
// - 无参数 → null（本机桌面应用 / 连接页）

import type { HelloFields } from './daemon';

export interface Target {
  url: string;
  hello: HelloFields;
  mode: string;
}

export function target(): Target | null {
  const q = new URLSearchParams(location.search);
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
      url: `${proto}://${location.host}/ws`,
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
