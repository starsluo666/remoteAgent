// 采集 Codex CLI 真实终端输出（经 daemon PTY 链路，用于识别规则开发）。
// 用法：node scripts/capture-codex.mjs [cmd...]  → 输出写入 codex-capture.txt

import WebSocket from 'ws';
import fs from 'node:fs';

const URL_ = 'ws://127.0.0.1:9800/ws';
const cmd = process.argv[2] ?? 'codex exec --skip-git-repo-check "只回复两个字：好的"';
const ws = new WebSocket(URL_);
let reqId = 0;
let sid = null;
let buf = [];

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function request(msg) {
  return new Promise((resolve) => {
    const id = ++reqId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ ...msg, reqId: id }));
  });
}
const pending = new Map();

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.reqId !== undefined && pending.has(m.reqId)) {
    const r = pending.get(m.reqId);
    pending.delete(m.reqId);
    return r(m);
  }
  if (m.t === 'output') {
    const chunk = Buffer.from(m.data, 'base64');
    buf.push(chunk);
    process.stdout.write(chunk);
  }
  if (m.t === 'session.exited') {
    fs.writeFileSync('codex-capture.txt', Buffer.concat(buf));
    console.error(`\n=== captured ${Buffer.concat(buf).length} bytes → codex-capture.txt ===`);
    process.exit(0);
  }
});

ws.on('open', async () => {
  ws.send(JSON.stringify({ t: 'hello', v: 1, role: 'client', deviceId: 'capture' }));
  await new Promise((r) => setTimeout(r, 300));
  const c = await request({ t: 'session.create', cols: 100, rows: 30, cmd });
  if (c.t !== 'session.created') {
    console.error('create failed', c);
    process.exit(1);
  }
  sid = c.sessionId;
  await request({ t: 'session.attach', sessionId: sid });
  setTimeout(() => {
    fs.writeFileSync('codex-capture.txt', Buffer.concat(buf));
    console.error(`\n=== timeout, captured ${Buffer.concat(buf).length} bytes ===`);
    process.exit(0);
  }, 90000);
});
ws.on('error', (e) => { console.error('ws:', e.message); process.exit(1); });
