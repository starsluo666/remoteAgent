import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
let seq = 0; const pend = new Map();
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const ev = (expression) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); });
const val = (m) => m?.result?.result?.value;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

ws.on('open', async () => {
  // 直连设备（配对链接）→ 终端工作区
  await ev(`location.assign(location.origin + '/#relay=ws://82.156.152.30:8080/ws&device=239965533&token=Ra-2026-gz'); 'nav'`);
  await sleep(9000);

  console.log('URL:', val(await ev(`location.href.slice(0, 50)`)));
  console.log('在线:', val(await ev(`document.body.innerText.includes('在线')`)));
  // 关键检查：触屏判定 + 移动操作栏
  console.log('isTouch判定:', val(await ev(`JSON.stringify({ ontouchstart: 'ontouchstart' in window, maxTouchPoints: navigator.maxTouchPoints })`)));
  console.log('mobile-bar:', val(await ev(`(() => { const mb = document.querySelector('.mobile-bar'); if (!mb) return '不存在'; const r = mb.getBoundingClientRect(); const cs = getComputedStyle(mb); return JSON.stringify({ h: Math.round(r.height), y: Math.round(r.top), display: cs.display, visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' }) })()`)));
  console.log('输入框:', val(await ev(`(() => { const i = document.querySelector('.mb-input'); if (!i) return '不存在'; return i.placeholder.slice(0, 12) + ' disabled=' + i.disabled })()`)));
  console.log('body尾部:', val(await ev(`document.body.innerText.slice(-140).split(String.fromCharCode(10)).filter(Boolean).slice(-5).join(' | ')`)));
  process.exit(0);
});
