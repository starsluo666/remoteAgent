import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
let seq = 0; const pend = new Map();
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const ev = (expression) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
const val = (m) => m?.result?.result?.value;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const setVal = (sel, v) => `(() => { const el = ${sel}; if (!el) return 'NOEL'; const s = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set; s.call(el, '${v}'); el.dispatchEvent(new Event('input', { bubbles: true })); return 'OK'; })()`;

ws.on('open', async () => {
  const log = (t, v) => console.log(t.padEnd(10), typeof v === 'string' ? v : JSON.stringify(v));

  // 全新用户：清存储重启
  await ev(`localStorage.clear(); 'ok'`);
  await ev(`location.reload(); 'ok'`).catch(() => {});
  await sleep(4000);

  // 1) 环境：Android / 底部导航 / 无窗口按钮 / 远程
  log('环境', val(await ev(`JSON.stringify({ android: navigator.userAgent.includes('Android'), origin: location.origin, bottomNav: getComputedStyle(document.querySelector('.bottom-nav')).display, winCaps: !!document.querySelector('.win-caps'), sidebar: getComputedStyle(document.querySelector('.shell-side')).display })`)));

  // 2) 进入应用 → 概览（远程版）
  await ev(`[...document.querySelectorAll('button')].find(b=>b.innerText.includes('进入应用'))?.click(); 'ok'`);
  await sleep(900);
  log('概览标题', val(await ev(`document.querySelector('.page-title')?.innerText`)));
  log('统计卡', val(await ev(`[...document.querySelectorAll('.stat-label')].map(x=>x.innerText).join(',')`)));
  log('无ID令牌', val(await ev(`!document.body.innerText.includes('设备 ID') && !document.body.innerText.includes('访问令牌')`)));
  log('主按钮', val(await ev(`document.querySelector('.page-head .primary-btn')?.innerText`)));

  // 3) 中继页添加
  await ev(`[...document.querySelectorAll('.bottom-item')].find(x=>x.innerText.includes('中继'))?.click(); 'ok'`);
  await sleep(700);
  log('我的中继页', val(await ev(`document.body.innerText.includes('我的中继')`)));
  log('填地址', val(await ev(setVal(`document.querySelectorAll('.page input')[0]`, 'ws://82.156.152.30:8080/ws'))));
  log('添加', val(await ev(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='添加')?.click(); 'ok'`)));
  await sleep(500);
  const relays = val(await ev(`JSON.parse(localStorage.getItem('ra.clientRelays')||'[]').length + ''`));
  log('中继入库', relays);

  // 4) 设备 → 连接（摘要行 + 设备号令牌）
  await ev(`[...document.querySelectorAll('.bottom-item')].find(x=>x.innerText.includes('设备'))?.click(); 'ok'`);
  await sleep(600);
  await ev(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='连接远程设备')?.click(); 'ok'`);
  await sleep(900);
  log('中继摘要', val(await ev(`document.querySelector('.relay-summary')?.innerText.split(String.fromCharCode(10))[0]`)));
  log('填设备号', val(await ev(setVal(`[...document.querySelectorAll('.connect-card input')].find(i => (i.placeholder||'').includes('9 位设备号'))`, '239965533'))));
  log('填令牌', val(await ev(setVal(`[...document.querySelectorAll('.connect-card input')].find(i => i.type==='password')`, 'Ra-2026-gz'))));
  log('连接', val(await ev(`document.querySelector('.connect-go')?.click(); 'ok'`)));
  await sleep(7000);

  // 5) 终端结果
  log('hash', val(await ev(`decodeURIComponent(location.hash).slice(0, 60)`)));
  log('在线', val(await ev(`document.body.innerText.includes('在线')`)));
  log('会话恢复', val(await ev(`document.body.innerText.includes('powershell') || document.body.innerText.includes('codex')`)));
  log('底部工具栏', val(await ev(`!!document.querySelector('.mobile-bar, .mb-mode') || document.body.innerText.includes('观察')`)));
  process.exit(0);
});
