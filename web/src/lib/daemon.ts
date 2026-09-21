// daemon WebSocket 连接层：请求-应答关联 + 推送事件分发 + E2E 加密（中继模式）。

import { b64decode, type DaemonMsg } from './protocol';
import { E2EClient } from './e2e';

export type Status = 'connecting' | 'ready' | 'disconnected';

export interface HelloFields {
  deviceId: string;
  token?: string;
}

export interface DaemonHandlers {
  onStatus: (s: Status) => void;
  onPresence: (deviceId: string, online: boolean) => void;
  onSnapshot: (sessionId: string, data: Uint8Array) => void;
  onOutput: (sessionId: string, data: Uint8Array) => void;
  onExited: (sessionId: string, exitCode: number | null) => void;
  onError: (code: string, msg: string) => void;
}

/** 中继层明文消息（不经 E2E 封装） */
const CLEARTEXT_TYPES = new Set(['hello', 'ping', 'auth.proof']);

export class DaemonConnection {
  private ws: WebSocket | null = null;
  private reqId = 0;
  private pending = new Map<number, (m: DaemonMsg) => void>();
  private disposed = false;
  private url: string;
  private hello: HelloFields;
  private h: DaemonHandlers;
  private e2e = new E2EClient();

  constructor(url: string, hello: HelloFields, h: DaemonHandlers) {
    this.url = url;
    this.hello = hello;
    this.h = h;
  }

  connect(): void {
    if (this.disposed) return;
    this.h.onStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.send({
        t: 'hello',
        v: 1,
        role: 'client',
        deviceId: this.hello.deviceId,
        ...(this.hello.token ? { token: this.hello.token } : {}),
      });
    };
    ws.onmessage = (ev) => {
      try {
        this.dispatch(ev.data as string);
      } catch (e) {
        console.error('bad message', e);
      }
    };
    ws.onclose = () => {
      if (!this.disposed) this.h.onStatus('disconnected');
    };
    ws.onerror = () => ws.close();
  }

  private dispatch(raw: string): void {
    // 注意：不能假设 "t" 是 JSON 的第一个键（serde_json 默认按键名排序输出）
    const first: { t?: string } = JSON.parse(raw);

    // enc 信封：解密后按内部消息分发
    if (first.t === 'enc') {
      if (!this.e2e.established) {
        this.h.onError('protocol_error', 'enc frame before handshake');
        return;
      }
      try {
        this.dispatch(this.e2e.open(raw));
      } catch {
        this.h.onError('decrypt_failed', 'bad enc frame');
      }
      return;
    }

    const m = JSON.parse(raw) as DaemonMsg & { pub?: string; mac?: string };
    switch (m.t) {
      case 'hello_ack':
        if (this.hello.token) {
          // 中继模式：先完成 E2E 握手，成功后才算 ready
          this.ws?.send(this.e2e.proofMessage(this.hello.token));
        } else {
          this.h.onStatus('ready');
        }
        return;
      case 'auth.ok': {
        try {
          this.e2e.finish(this.hello.token ?? '', m.pub ?? '', m.mac ?? '');
          this.h.onStatus('ready');
        } catch (e) {
          this.h.onError('auth_failed', String(e));
          this.ws?.close();
        }
        return;
      }
      case 'presence':
        this.h.onPresence(m.deviceId, m.online);
        return;
      case 'snapshot':
        this.h.onSnapshot(m.sessionId, b64decode(m.data));
        return;
      case 'output':
        this.h.onOutput(m.sessionId, b64decode(m.data));
        return;
      case 'session.exited':
        this.h.onExited(m.sessionId, m.exitCode);
        return;
      case 'error':
        this.h.onError(m.code, m.msg);
        break;
    }
    if ('reqId' in m && m.reqId !== undefined) {
      const resolve = this.pending.get(m.reqId);
      if (resolve) {
        this.pending.delete(m.reqId);
        resolve(m);
      }
    }
  }

  send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    let wire: string;
    if (this.e2e.established && !CLEARTEXT_TYPES.has(msg.t as string)) {
      wire = this.e2e.seal(JSON.stringify(msg));
    } else {
      wire = JSON.stringify(msg);
    }
    this.ws.send(wire);
  }

  request(msg: Record<string, unknown>): Promise<DaemonMsg> {
    return new Promise((resolve) => {
      const reqId = ++this.reqId;
      this.pending.set(reqId, resolve);
      this.send({ ...msg, reqId });
    });
  }

  close(): void {
    this.disposed = true;
    this.ws?.close();
  }
}
