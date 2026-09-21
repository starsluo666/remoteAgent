// M7 冒烟：Codex 会话端到端 —— 识别事件流 starting→working→finished + env 注入生效。
// 用法：node scripts/smoke-codex.mjs（依赖 settings.json 的 env 代理注入）

import WebSocket from 'ws';

const URL_ = 'ws://127.0.0.1:9800/ws';
const ws = new WebSocket(URL_);
let reqId = 0;
const pending = new Map();
const events = [];

function request(msg) {
  return new Promise((resolve) => {
    const id = ++reqId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ ...msg, reqId: id }));
  });
}

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.reqId !== undefined && pending.has(m.reqId)) {
    const r = pending.get(m.reqId);
    pending.delete(m.reqId);
    return r(m);
  }
  if (m.t === 'agent.status') {
    events.push(`${m.agent}:${m.status}`);
    console.log(`  [agent.status] ${m.agent} → ${m.status} (${(m.detail || '').slice(0, 40)})`);
  }
});

const timeout = setTimeout(() => {
  console.error('FAIL: 超时（90s）事件序列:', events.join(','));
  process.exit(1);
}, 90000);

ws.on('open', async () => {
  try {
    ws.send(JSON.stringify({ t: 'hello', v: 1, role: 'client', deviceId: 'smoke-codex' }));
    await new Promise((r) => setTimeout(r, 300));
    // 代理来自 settings.json env 注入 —— 命令里不再手写 set
    const c = await request({ t: 'session.create', cols: 100, rows: 30, cmd: 'codex exec --skip-git-repo-check "只回复两个字：好的"' });
    if (c.t !== 'session.created') throw new Error(`create: ${JSON.stringify(c)}`);
    await request({ t: 'session.attach', sessionId: c.sessionId });
    console.log('会话已创建，等待识别事件（真实调用 Codex，含网络耗时）…');
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
});

// 由 daemon 侧 session.exited / 足够事件后收尾
let exitTimer = null;
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.t === 'session.exited') {
    clearTimeout(exitTimer);
    setTimeout(() => finish(), 800);
  }
  if (m.t === 'agent.status' && m.status === 'finished') {
    // finished 后再等 2s 收进程退出
    exitTimer = setTimeout(() => finish(), 15000);
  }
});

function finish() {
  clearTimeout(timeout);
  const seq = events.join(',');
  const okStart = events.some((e) => e.endsWith(':starting'));
  const okWork = events.some((e) => e.endsWith(':working'));
  const okFin = events.some((e) => e.endsWith(':finished'));
  console.log(`事件序列: ${seq}`);
  if (okStart && okWork && okFin) {
    console.log('✓ starting → working → finished 全链路识别');
    console.log('ALL PASS');
    process.exit(0);
  }
  console.error(`FAIL: 序列不完整 (starting=${okStart} working=${okWork} finished=${okFin})`);
  process.exit(1);
}
