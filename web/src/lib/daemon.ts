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
  onSnapshot: (sessionId: string, data: Uint8Array, seq: number) => void;
  onOutput: (sessionId: string, data: Uint8Array, seq: number) => void;
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
  private keepalive: number | undefined;
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
    // 已有活动连接时跳过，防止重连风暴下开出双 socket
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
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
      // 应用层保活：维持 NAT 映射，同时让半开连接尽早暴露（onclose 触发重连）
      window.clearInterval(this.keepalive);
      this.keepalive = window.setInterval(() => {
        if (this.ws?.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({ t: 'ping' }));
      }, 25000);
    };
    ws.onmessage = (ev) => {
      try {
        this.dispatch(ev.data as string);
      } catch (e) {
        console.error('bad message', e);
      }
    };
    ws.onclose = () => {
      window.clearInterval(this.keepalive);
      // 只在该 socket 仍是当前 socket 时通知（reconnect() 换新后旧 socket 的关闭不算掉线）
      if (this.ws !== ws) return;
      this.pending.clear(); // 悬挂的请求不再有应答，调用方等待被新连接的 bootstrap 取代
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
        this.h.onSnapshot(m.sessionId, b64decode(m.data), m.seq);
        return;
      case 'output':
        this.h.onOutput(m.sessionId, b64decode(m.data), m.seq);
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

  /** 手动重连：静默关闭当前 socket（不触发 disconnected 状态）并立即重连 */
  reconnect(): void {
    if (this.disposed) return;
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.connect();
  }

  close(): void {
    this.disposed = true;
    window.clearInterval(this.keepalive);
    this.ws?.close();
  }
}
