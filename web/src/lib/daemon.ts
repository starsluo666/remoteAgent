// daemon WebSocket 连接层：请求-应答关联 + 推送事件分发。

import { b64decode, type DaemonMsg } from './protocol';

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

export class DaemonConnection {
  private ws: WebSocket | null = null;
  private reqId = 0;
  private pending = new Map<number, (m: DaemonMsg) => void>();
  private disposed = false;
  private url: string;
  private hello: HelloFields;
  private h: DaemonHandlers;

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
        this.dispatch(JSON.parse(ev.data as string) as DaemonMsg);
      } catch (e) {
        console.error('bad message', e);
      }
    };
    ws.onclose = () => {
      if (!this.disposed) this.h.onStatus('disconnected');
    };
    ws.onerror = () => ws.close();
  }

  private dispatch(m: DaemonMsg): void {
    switch (m.t) {
      case 'hello_ack':
        this.h.onStatus('ready');
        return;
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
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
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
