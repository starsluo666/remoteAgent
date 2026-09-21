// M1 协议层 smoke 测试：hello → list → create → attach → input → output → kill → exited。
// 用法：先启动 daemon（cargo run），再 node scripts/smoke-ws.mjs

import WebSocket from 'ws';

const URL = 'ws://127.0.0.1:9800/ws';
const MARK = 'ra_smoke_ok_9417';

const ws = new WebSocket(URL);
let reqId = 0;
const pending = new Map();
let sessionId = null;
let outBuf = Buffer.alloc(0);
let done = false;

const fail = (msg) => {
  console.error('FAIL:', msg);
  process.exit(1);
};
const timer = setTimeout(() => fail('overall timeout (25s)'), 25_000);

function request(msg) {
  return new Promise((resolve) => {
    const id = ++reqId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ ...msg, reqId: id }));
  });
}

function accumulate(data) {
  outBuf = Buffer.concat([outBuf, Buffer.from(data)]);
  if (outBuf.includes(MARK)) {
    done = true;
    finish();
  }
}

async function finish() {
  await request({ t: 'session.kill', sessionId });
  // 等 exited 事件
}

ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', v: 1, role: 'client', deviceId: 'smoke' })));

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  switch (m.t) {
    case 'hello_ack':
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
        console.log('PASS: hello/list/create/attach/input/output/kill/exited 全链路通过');
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
  const cmd = `echo ${MARK}\r`;
  ws.send(JSON.stringify({ t: 'input', sessionId, data: Buffer.from(cmd, 'utf8').toString('base64') }));
}
