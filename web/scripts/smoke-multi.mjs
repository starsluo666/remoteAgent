// M4 多 session smoke：两个会话并行，各自输入互不串扰，单独 kill 不影响另一个。
// 用法：node scripts/smoke-multi.mjs [url deviceId accessToken]
//   本地模式：node scripts/smoke-multi.mjs
//   中继模式：node scripts/smoke-multi.mjs ws://127.0.0.1:8080/ws <id> <token>

import WebSocket from 'ws';
import crypto from 'node:crypto';

const URL = process.argv[2] ?? 'ws://127.0.0.1:9800/ws';
const DEVICE = process.argv[3] ?? 'local-smoke';
const TOKEN = process.argv[4] ?? '';
const HKDF_INFO = Buffer.from('remoteagent-payload-v1');
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');

const ws = new WebSocket(URL);
let reqId = 0;
const pending = new Map();
const out = new Map(); // sid -> Buffer
let key = null;
let kp = null;
const sids = [];
const marks = ['ra_multi_A', 'ra_multi_B'];
let phase = 'created';

const fail = (m) => {
  console.error('FAIL:', m);
  process.exit(1);
};
const timer = setTimeout(() => fail(`timeout in phase ${phase}`), 30_000);

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
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(probe.nn, 'base64'));
  d.setAuthTag(buf.subarray(-16));
  return Buffer.concat([d.update(buf.subarray(0, -16)), d.final()]).toString();
}
function request(msg) {
  return new Promise((res) => {
    const id = ++reqId;
    pending.set(id, res);
    ws.send(seal({ ...msg, reqId: id }));
  });
}
function handshake() {
  kp = crypto.generateKeyPairSync('x25519');
  const pub = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const mac = crypto.createHmac('sha256', TOKEN).update(pub).digest();
  ws.send(JSON.stringify({ t: 'auth.proof', pub: pub.toString('base64'), mac: mac.toString('base64') }));
}
function finishHandshake(m) {
  const daemonPub = Buffer.from(m.pub, 'base64');
  const expect = crypto.createHmac('sha256', TOKEN).update(daemonPub).digest();
  if (!expect.equals(Buffer.from(m.mac, 'base64'))) fail('daemon mac mismatch');
  const dk = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, daemonPub]), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey: kp.privateKey, publicKey: dk });
  const clientPub = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([daemonPub, clientPub]), HKDF_INFO, 32));
}
async function waitPrompt(sid) {
  for (let i = 0; i < 50; i++) {
    const buf = out.get(sid) ?? Buffer.alloc(0);
    if (/\$\s|#\s|>\s/.test(buf.toString('utf8'))) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  fail(`session ${sid} no prompt`);
}

ws.on('open', () =>
  ws.send(JSON.stringify({ t: 'hello', v: 1, role: 'client', deviceId: DEVICE, ...(TOKEN ? { token: TOKEN } : {}) })),
);
ws.on('message', async (raw) => {
  const s = raw.toString();
  const m = JSON.parse(unseal(s) ?? s);
  if (m.t === 'hello_ack') {
    if (TOKEN) return handshake();
    return void main();
  }
  if (m.t === 'auth.ok') {
    finishHandshake(m);
    return void main();
  }
  if (m.t === 'output' || m.t === 'snapshot') {
    const buf = out.get(m.sessionId) ?? Buffer.alloc(0);
    out.set(m.sessionId, Buffer.concat([buf, Buffer.from(m.data, 'base64')]));
    return;
  }
  if (m.t === 'error') return fail(`${m.code}: ${m.msg}`);
  if ('reqId' in m && pending.has(m.reqId)) {
    const r = pending.get(m.reqId);
    pending.delete(m.reqId);
    r(m);
  }
});

async function main() {
  // 清场：杀掉遗留 session
  const listed = await request({ t: 'session.list' });
  for (const s of listed.sessions) await request({ t: 'session.kill', sessionId: s.id });

  // 1) 建两个会话并 attach
  for (let i = 0; i < 2; i++) {
    const c = await request({ t: 'session.create', cols: 100, rows: 30 });
    if (c.t !== 'session.created') fail('create B');
    sids.push(c.sessionId);
    const a = await request({ t: 'session.attach', sessionId: c.sessionId });
    if (a.t !== 'session.attached') fail('attach');
  }
  phase = 'prompts';
  await waitPrompt(sids[0]);
  await waitPrompt(sids[1]);
  console.log('两个会话均就绪');

  // 2) 分别输入不同标记
  phase = 'input';
  ws.send(seal({ t: 'input', sessionId: sids[0], data: Buffer.from(`echo ${marks[0]}\r`).toString('base64') }));
  ws.send(seal({ t: 'input', sessionId: sids[1], data: Buffer.from(`echo ${marks[1]}\r`).toString('base64') }));
  phase = 'echo';
  for (let i = 0; i < 50; i++) {
    const a = out.get(sids[0]) ?? Buffer.alloc(0);
    const b = out.get(sids[1]) ?? Buffer.alloc(0);
    if (a.includes(marks[0]) && b.includes(marks[1])) break;
    await new Promise((r) => setTimeout(r, 200));
    if (i === 49) fail('两路回显未同时出现（输出串扰或丢失）');
  }
  console.log('两路输出互不串扰，各自回显命中');

  // 3) kill 第一个，第二个必须存活
  phase = 'kill';
  await request({ t: 'session.kill', sessionId: sids[0] });
  await new Promise((r) => setTimeout(r, 800));
  ws.send(seal({ t: 'input', sessionId: sids[1], data: Buffer.from('echo still_alive\r').toString('base64') }));
  for (let i = 0; i < 40; i++) {
    const b = out.get(sids[1]) ?? Buffer.alloc(0);
    if (b.includes('still_alive')) {
      clearTimeout(timer);
      console.log('PASS: 多 session 全链路（并行会话/独立输入输出/单独 kill 不牵连）');
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  fail('第二个会话在 kill 第一个后无响应');
}
