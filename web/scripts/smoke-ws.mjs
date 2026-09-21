// 端到端 smoke：hello → (E2E 握手) → list → create → attach → input → output → kill → exited。
// 本地模式：node scripts/smoke-ws.mjs
// 中继模式（含 E2E 加密）：node scripts/smoke-ws.mjs ws://127.0.0.1:8080/ws <deviceId> <accessToken>

import WebSocket from 'ws';
import crypto from 'node:crypto';

const URL = process.argv[2] ?? 'ws://127.0.0.1:9800/ws';
const DEVICE = process.argv[3] ?? 'local-smoke';
const TOKEN = process.argv[4] ?? '';
const MARK = 'ra_smoke_ok_9417';
const HKDF_INFO = Buffer.from('remoteagent-payload-v1');
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

const ws = new WebSocket(URL);
let reqId = 0;
const pending = new Map();
let sessionId = null;
let outBuf = Buffer.alloc(0);
let done = false;
let key = null; // E2E 会话密钥
let x25519Keys = null;

const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};
const timer = setTimeout(() => fail('overall timeout (25s)'), 25_000);

// —— E2E：与 daemon/src/crypto.rs、web/src/lib/e2e.ts 对应 ——
function startHandshake() {
  x25519Keys = crypto.generateKeyPairSync('x25519');
  const pubRaw = x25519Keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const mac = crypto.createHmac('sha256', TOKEN).update(pubRaw).digest();
  ws.send(
    JSON.stringify({ t: 'auth.proof', pub: pubRaw.toString('base64'), mac: mac.toString('base64') }),
  );
}
function finishHandshake(m) {
  const daemonPub = Buffer.from(m.pub, 'base64');
  const expect = crypto.createHmac('sha256', TOKEN).update(daemonPub).digest();
  if (!expect.equals(Buffer.from(m.mac, 'base64'))) fail('daemon mac mismatch');
  const daemonKeyObj = crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, daemonPub]),
    format: 'der',
    type: 'spki',
  });
  const shared = crypto.diffieHellman({ privateKey: x25519Keys.privateKey, publicKey: daemonKeyObj });
  const clientPub = x25519Keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  // 盐按角色定序：daemon_pub || client_pub（与 daemon/src/crypto.rs 一致）
  key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([daemonPub, clientPub]), HKDF_INFO, 32));
  console.log('E2E handshake OK, session key derived');
}
function seal(obj) {
  if (!key) return JSON.stringify(obj);
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(JSON.stringify(obj)), c.final(), c.getAuthTag()]);
  return JSON.stringify({ t: 'enc', nn: nonce.toString('base64'), ct: ct.toString('base64') });
}
function unseal(s) {
  const probe = JSON.parse(s);
  if (probe.t !== 'enc' || !key) return null;
  const buf = Buffer.from(probe.ct, 'base64');
  const ct = buf.subarray(0, -16);
  const tag = buf.subarray(-16);
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(probe.nn, 'base64'));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString();
}

function request(msg) {
  return new Promise((resolve) => {
    const id = ++reqId;
    pending.set(id, resolve);
    ws.send(seal({ ...msg, reqId: id }));
  });
}

function accumulate(data) {
  outBuf = Buffer.concat([outBuf, Buffer.from(data)]);
  if (outBuf.includes(MARK) && !done) {
    done = true;
    finish();
  }
}
async function finish() {
  await request({ t: 'session.kill', sessionId });
}

ws.on('open', () =>
  ws.send(JSON.stringify({ t: 'hello', v: 1, role: 'client', deviceId: DEVICE, ...(TOKEN ? { token: TOKEN } : {}) })),
);

ws.on('message', (raw) => {
  const s = raw.toString();
  const unsealed = unseal(s);
  const m = JSON.parse(unsealed ?? s);
  switch (m.t) {
    case 'hello_ack':
      if (TOKEN) startHandshake();
      else void main();
      break;
    case 'auth.ok':
      finishHandshake(m);
      void main();
      break;
    case 'snapshot':
      if (m.sessionId === sessionId) accumulate(Buffer.from(m.data, 'base64'));
      break;
    case 'output':
      if (m.sessionId === sessionId) accumulate(Buffer.from(m.data, 'base64'));
      break;
    case 'session.exited':
      if (done && m.sessionId === sessionId) {
        clearTimeout(timer);
        console.log(`PASS: ${TOKEN ? 'E2E 加密' : '本地'}全链路通过（hello${TOKEN ? '/auth.proof' : ''}/list/create/attach/input/output/kill/exited）`);
        console.log(`（捕获输出 ${outBuf.length} 字节，含标记 ${MARK}）`);
        process.exit(0);
      }
      break;
    case 'error':
      fail(`daemon error: ${m.code} ${m.msg}`);
      break;
    default:
      if ('reqId' in m && pending.has(m.reqId)) {
        const r = pending.get(m.reqId);
        pending.delete(m.reqId);
        r(m);
      }
  }
});

async function main() {
  const listed = await request({ t: 'session.list' });
  if (listed.t !== 'session.list.result') fail('list 响应异常');
  console.log(`现有 session: ${listed.sessions.length} 个`);

  const created = await request({ t: 'session.create', cols: 100, rows: 30 });
  if (created.t !== 'session.created') fail(`create 失败: ${JSON.stringify(created)}`);
  sessionId = created.sessionId;
  console.log(`created: ${sessionId}`);

  const attached = await request({ t: 'session.attach', sessionId });
  if (attached.t !== 'session.attached') fail(`attach 失败: ${JSON.stringify(attached)}`);
  console.log('attached, snapshot 已接收');

  // 等 shell 提示符出现再输入（ConPTY 对过早输入可能丢弃）
  const promptReady = Date.now() + 10_000;
  while (!/\$\s|#\s|>\s/.test(outBuf.toString('utf8')) && Date.now() < promptReady) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (done) return;
  ws.send(seal({ t: 'input', sessionId, data: Buffer.from(`echo ${MARK}\r`).toString('base64') }));
}
