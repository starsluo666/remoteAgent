// 令牌握手验证：node scripts/check-token.mjs <token> [relayUrl]
import WebSocket from 'ws';
import { x25519 } from '@noble/curves/ed25519.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
const token = process.argv[2];
const DEVICE = 'd7a4f1f3-b8e1-4f2e-96f4-f9c1a2def7eb';
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const ws = new WebSocket('ws://82.156.152.30:8080/ws');
ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, role: 'client', deviceId: DEVICE, token })));
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.t === 'hello_ack') {
    const priv = x25519.utils.randomSecretKey();
    const pub = x25519.getPublicKey(priv);
    const mac = hmac(sha256, new TextEncoder().encode(token), pub);
    ws.send(JSON.stringify({ t: 'auth.proof', pub: b64(pub), mac: b64(mac) }));
  } else if (m.t === 'auth.ok') { console.log('RESULT: auth.ok ✓ 令牌被接受'); process.exit(0); }
  else if (m.t === 'error') { console.log('RESULT: 拒绝 —', m.code, m.msg ?? ''); process.exit(0); }
});
ws.on('close', () => { console.log('RESULT: 连接被关闭'); process.exit(0); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 10000);
