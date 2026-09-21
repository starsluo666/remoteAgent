// M2 中继逻辑 smoke：假 daemon 注册 → 假 client 加入 → 双向透传 → daemon 断开 presence。
// 用法：node scripts/smoke-relay.mjs [relayUrl]

import WebSocket from 'ws';

const URL = process.argv[2] ?? 'ws://127.0.0.1:8080/ws';
const DEVICE = 'smoke_dev_1';
const TOKEN = 'smoke_tok_1';

const fail = (m) => {
  console.error('FAIL:', m);
  process.exit(1);
};
const timer = setTimeout(() => fail('overall timeout (10s)'), 10_000);
const done = () => {
  clearTimeout(timer);
  console.log('PASS: register/join/forward c2d/forward d2c/presence 全部通过');
  process.exit(0);
};

// 1) 假 daemon 注册
const d = new WebSocket(URL);
let dGot = null; // client → daemon 透传内容
let stage = 0;
d.on('open', () =>
  d.send(JSON.stringify({ t: 'hello', v: 1, role: 'daemon', deviceId: DEVICE, token: TOKEN })),
);
d.on('message', (raw, isBinary) => {
  if (isBinary) return;
  const s = raw.toString();
  if (stage === 0 && s.includes('hello_ack')) {
    stage = 1;
    startClient();
    return;
  }
  if (stage === 2) {
    dGot = JSON.parse(s);
    if (dGot.t === 'input' && Buffer.from(dGot.data, 'base64').toString() === 'ping-from-client') {
      stage = 3;
      // 2) daemon → client 透传
      d.send(JSON.stringify({ t: 'output', sessionId: 's_x', data: Buffer.from('pong-from-daemon').toString('base64') }));
    }
  }
});

let c;
function startClient() {
  c = new WebSocket(URL);
  c.on('open', () =>
    c.send(JSON.stringify({ t: 'hello', v: 1, role: 'client', deviceId: DEVICE, token: TOKEN })),
  );
  c.on('message', (raw, isBinary) => {
    if (isBinary) return;
    const m = JSON.parse(raw.toString());
    if (m.t === 'hello_ack') {
      // client → daemon 透传
      c.send(
        JSON.stringify({ t: 'input', sessionId: 's_x', data: Buffer.from('ping-from-client').toString('base64') }),
      );
      stage = 2;
    } else if (m.t === 'output' && Buffer.from(m.data, 'base64').toString() === 'pong-from-daemon') {
      // 3) daemon 断开 → presence offline
      d.close();
    } else if (m.t === 'presence' && m.online === false) {
      done();
    }
  });
}

// 错误 token 的 client 应被拒绝（auth_failed）
function startBadClient() {
  const bad = new WebSocket(URL);
  bad.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === 'hello_ack') fail('bad token was accepted!');
  });
  bad.on('open', () =>
    bad.send(JSON.stringify({ t: 'hello', v: 1, role: 'client', deviceId: DEVICE, token: 'WRONG' })),
  );
  bad.on('close', () => console.log('bad-token client rejected (as expected)'));
}
setTimeout(startBadClient, 300);
