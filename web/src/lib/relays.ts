// 客户端中继列表（连接发起方视角，localStorage）：
// 中继是用户自己的基础设施，加一次即可；此后连接新设备只需设备号 + 令牌。

export interface ClientRelay {
  url: string; // ws(s)://…/ws
  name?: string;
}

const KEY = 'ra.clientRelays';
const LAST = 'ra.lastRelay';

export function loadClientRelays(): ClientRelay[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.url === 'string') : [];
  } catch {
    return [];
  }
}

function persist(list: ClientRelay[]) {
  localStorage.setItem(KEY, JSON.stringify(list.slice(0, 8)));
}

export function addClientRelay(url: string, name?: string): ClientRelay[] {
  const u = url.trim();
  if (!u) return loadClientRelays();
  const list = loadClientRelays().filter((x) => x.url !== u);
  list.unshift({ url: u, name: name?.trim() || undefined });
  persist(list);
  setLastRelay(u);
  return list;
}

export function removeClientRelay(url: string): ClientRelay[] {
  const list = loadClientRelays().filter((x) => x.url !== url);
  persist(list);
  return list;
}

export function getLastRelay(): string | null {
  return localStorage.getItem(LAST);
}

export function setLastRelay(url: string) {
  localStorage.setItem(LAST, url);
}

/** 手输中继地址归一化：host → wss://host/ws */
export function normalizeClientRelay(input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (/^wss?:\/\//.test(t)) return /\/ws$/.test(t) ? t : `${t}/ws`;
  return `wss://${t}/ws`;
}
