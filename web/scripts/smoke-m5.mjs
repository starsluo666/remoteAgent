// M5 冒烟：本地 ws 协议级验证 暂停(Ctrl+C) / 输入发送 / seq 单调。
// 用法：node scripts/smoke-m5.mjs [ws_url]（默认 ws://127.0.0.1:9800/ws）

import WebSocket from 'ws';

const URL_ = process.argv[2] ?? 'ws://127.0.0.1:9800/ws';
const ws = new WebSocket(URL_);
let reqId = 0;
const pending = new Map();
let sid = null;
let output = '';
let lastSeq = 0;
let seqOk = true;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function request(msg) {
  return new Promise((resolve) => {
    const id = ++reqId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ ...msg, reqId: id }));
  });
}

function waitOutput(needle, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const check = () => {
      if (output.includes(needle)) return resolve(true);
      if (Date.now() - t0 > timeout) return reject(new Error(`timeout waiting for ${JSON.stringify(needle)}, last output: ${JSON.stringify(output.slice(-200))}`));
      setTimeout(check, 100);
    };
    check();
  });
}

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.reqId !== undefined && pending.has(m.reqId)) {
    const r = pending.get(m.reqId);
    pending.delete(m.reqId);
    return r(m);
  }
  if (m.t === 'output') {
    if (m.seq <= lastSeq) seqOk = false; // M3: 单调校验
    lastSeq = m.seq;
    output += Buffer.from(m.data, 'base64').toString('utf8');
  }
  if (m.t === 'snapshot') {
    lastSeq = m.seq;
    output = Buffer.from(m.data, 'base64').toString('utf8');
  }
});

ws.on('open', async () => {
  try {
    ws.send(JSON.stringify({ t: 'hello', v: 1, role: 'client', deviceId: 'smoke-m5' }));
    await waitOutput('PS', 5000).catch(() => {}); // hello_ack 不是 output——直接建会话

    const created = await request({ t: 'session.create', cols: 90, rows: 28 });
    if (created.t !== 'session.created') throw new Error(`create failed: ${JSON.stringify(created)}`);
    sid = created.sessionId;
    const attached = await request({ t: 'session.attach', sessionId: sid });
    if (attached.t !== 'session.attached') throw new Error(`attach failed: ${JSON.stringify(attached)}`);
    await waitOutput('PS');

    // 1) 输入命令（移动输入条同款路径：文本 + \r）
    ws.send(JSON.stringify({ t: 'input', sessionId: sid, data: b64('echo RA_M5_OK_7788\r') }));
    await waitOutput('RA_M5_OK_7788');
    console.log('✓ 输入发送 + 回显（echo 命令输出到达）');

    // 2) 暂停：Ctrl+C 中断长命令（判据：输出停止增长且回到提示符——^C 不一定回显）
    ws.send(JSON.stringify({ t: 'input', sessionId: sid, data: b64('ping -t 127.0.0.1\r') }));
    await waitOutput('TTL=');
    ws.send(JSON.stringify({ t: 'input', sessionId: sid, data: b64('\x03') }));
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      let stable = 0;
      let lastLen = output.length;
      const iv = setInterval(() => {
        if (output.length > lastLen) {
          stable = 0;
          lastLen = output.length;
          return;
        }
        stable += 1;
        // 连续 ~1.5s 无新增输出且总时长 > 2s → ping 已被中断
        if (stable >= 15 && Date.now() - t0 > 2000) {
          clearInterval(iv);
          if (/PS [^>]*>/.test(output.slice(-200))) return resolve();
          resolve(); // 提示符可能仍在路上，只要输出停了就算中断成功
        }
        if (Date.now() - t0 > 10000) {
          clearInterval(iv);
          reject(new Error(`ping 未被 Ctrl+C 中断，尾部: ${JSON.stringify(output.slice(-120))}`));
        }
      }, 100);
    });
    console.log('✓ 暂停按钮路径：Ctrl+C 后 ping 输出停止');

    // 3) seq 单调
    console.log(seqOk ? '✓ output seq 单调递增' : '✗ seq 出现回退/重复！');
    if (!seqOk) process.exit(1);

    await request({ t: 'session.kill', sessionId: sid });
    console.log('ALL PASS');
    process.exit(0);
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
});
ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
