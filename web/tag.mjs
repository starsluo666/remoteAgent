import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
let seq = 0; const pend = new Map();
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const ev = (expression) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
const val = (m) => m?.result?.result?.value;
ws.on('open', async () => {
  const r = await val(await ev(`fetch('http://82.156.152.30:8080/api/presence?device=239965533&key=f93b6f854df143119eb7eb056d6ae32ca3a82e53cafb4b18aeb8fefe47dd4b80').then(r => r.json()).then(j => JSON.stringify(j))`));
  console.log('presence:', r);
  process.exit(0);
});
