import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
let seq = 0; const pend = new Map();
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const ev = (expression) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const setVal = (sel, v) => `(() => { const el = ${sel}; if (!el) return 'NOEL'; const s = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set; s.call(el, '${v}'); el.dispatchEvent(new Event('input', { bubbles: true })); return 'OK'; })()`;

ws.on('open', async () => {
  // 1) 清存储 → 全新首开体验
  await ev(`localStorage.clear(); 'ok'`);
  await ev(`location.reload(); 'ok'`).catch(() => {});
  await sleep(3500);

  // 2) 进入应用 → 中继 tab
  console.log('进入:', await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('进入应用')); if(!b) return 'NOBTN:' + document.body.innerText.slice(0,40); b.click(); return 'OK' })()`));
  await sleep(1000);
  console.log('中继tab:', await ev(`(() => { const b=[...document.querySelectorAll('.bottom-item')].find(x=>x.innerText.includes('中继')); if(!b) return 'NOTAB'; b.click(); return 'OK' })()`));
  await sleep(800);
  console.log('我的中继页:', await ev(`document.body.innerText.includes('我的中继') ? 'OK' : document.body.innerText.slice(0, 60)`));

  // 3) 填中继地址并添加
  console.log('填地址:', await ev(setVal(`document.querySelectorAll('.page input')[0]`, 'ws://82.156.152.30:8080/ws')));
  await sleep(200);
  console.log('点添加:', await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='添加'); if(!b) return 'NOBTN'; b.click(); return 'OK' })()`));
  await sleep(600);
  console.log('列表含中继:', await ev(`JSON.parse(localStorage.getItem('ra.clientRelays')||'[]').map(r=>r.url).join(',') || 'EMPTY'`));

  // 4) 设备 tab → 连接远程设备 → 设备号 + 令牌
  console.log('设备tab:', await ev(`(() => { const b=[...document.querySelectorAll('.bottom-item')].find(x=>x.innerText.includes('设备')); b.click(); return 'OK' })()`));
  await sleep(700);
  console.log('开弹窗:', await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='连接远程设备'); if(!b) return 'NOBTN'; b.click(); return 'OK' })()`));
  await sleep(900);
  console.log('中继摘要:', await ev(`(() => { const s=document.querySelector('.relay-summary'); return s ? s.innerText : (document.querySelector('.relay-pick select') ? 'SELECTOR' : 'INPUT_MODE') })()`));
  const inputs = await ev(`[...document.querySelectorAll('.connect-card input')].map(i => i.placeholder.slice(0, 14))`);
  console.log('输入框:', JSON.stringify(inputs));
  console.log('填设备号:', await ev(setVal(`[...document.querySelectorAll('.connect-card input')].find(i => (i.placeholder||'').includes('9 位设备号'))`, '239965533')));
  await sleep(150);
  console.log('填令牌:', await ev(setVal(`[...document.querySelectorAll('.connect-card input')].find(i => i.type==='password')`, 'Ra-2026-gz')));
  await sleep(200);
  console.log('点连接:', await ev(`(() => { const b=document.querySelector('.connect-go'); if(!b) return 'NOBTN'; b.click(); return 'OK' })()`));
  await sleep(6000);
  const state = await ev(`document.body.innerText.slice(0, 150)`);
  console.log('最终页面:', JSON.stringify(String(state).split('\n').filter(Boolean).slice(0, 8)));
  process.exit(0);
});
