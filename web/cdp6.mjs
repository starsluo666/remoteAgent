import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
let seq = 0; const pend = new Map();
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const ev = (expression) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); });
ws.on('open', async () => {
  await ev(`window.__ev = []; ['touchstart','touchend','click'].forEach(t => document.addEventListener(t, e => window.__ev.push(t + '@' + Math.round(e.touches[0]?.clientY ?? e.clientY) + ':' + (e.target.tagName || '') + '.' + String(e.target.className||'').slice(0,15)), { passive: true, capture: true })); 'armed'`);
  console.log('ARMED — now adb tap');
  process.exit(0);
});
