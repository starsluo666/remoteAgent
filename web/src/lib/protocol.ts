// 线协议 TS 类型，与 daemon/src/protocol.rs、docs/protocol.md 对应。

export type ClientMsg =
  | { t: 'hello'; v: 1; role: 'client'; deviceId: string }
  | { t: 'ping' }
  | { t: 'session.list'; reqId: number }
  | { t: 'session.create'; reqId: number; cols: number; rows: number; cwd?: string; cmd?: string }
  | { t: 'session.attach'; reqId: number; sessionId: string }
  | { t: 'session.kill'; reqId: number; sessionId: string }
  | { t: 'input'; sessionId: string; data: string }
  | { t: 'resize'; sessionId: string; cols: number; rows: number };

export interface SessionInfo {
  id: string;
  cmd: string;
  startedAt: number;
}

export type DaemonMsg =
  | { t: 'hello_ack'; deviceId: string }
  | { t: 'pong' }
  | { t: 'presence'; deviceId: string; online: boolean }
  | { t: 'session.list.result'; reqId: number; sessions: SessionInfo[] }
  | { t: 'session.created'; reqId: number; sessionId: string }
  | { t: 'session.attached'; reqId: number; sessionId: string }
  | { t: 'output'; sessionId: string; seq: number; data: string }
  | { t: 'snapshot'; sessionId: string; seq: number; data: string }
  | { t: 'session.exited'; sessionId: string; exitCode: number | null }
  | { t: 'error'; reqId?: number; code: string; msg: string };

const textEncoder = new TextEncoder();

export function b64encode(s: string): string {
  const bytes = textEncoder.encode(s);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
