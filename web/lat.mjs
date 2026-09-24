import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
let seq = 0; const pend = new Map();
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const ev = (expression) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
ws.on('open', async () => {
  // 模拟器 WebView 里直测 health 与延迟
  const r = await ev(`fetch('http://82.156.152.30:8080/health', { cache: 'no-store' }).then(async x => x.status + ' ' + (await x.text()).slice(0, 40)).catch(e => 'ERR ' + String(e).slice(0, 60))`);
  console.log('health:', r?.result?.result?.value ?? JSON.stringify(r?.result).slice(0, 120));
  process.exit(0);
});
