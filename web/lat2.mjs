import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
let seq = 0; const pend = new Map();
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const ev = (expression) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
ws.on('open', async () => {
  // 模拟器内走 app 的测延迟逻辑（和我的中继页一致）
  const r = await ev(`(async () => {
    const u = 'ws://82.156.152.30:8080/ws';
    const base = u.replace('wss://','https://').replace('ws://','http://').replace('/ws','');
    const t0 = performance.now();
    try {
      const r = await fetch(base + '/health', { cache: 'no-store' });
      return (r.ok ? 'OK ' + Math.round(performance.now() - t0) + 'ms' : 'HTTP ' + r.status);
    } catch (e) { return 'ERR ' + String(e).slice(0, 80); }
  })()`);
  console.log('模拟器 latency:', r?.result?.result?.value);
  // 手机 APK 场景：明文 http —— 检查 cleartext
  const r2 = await ev(`navigator.onLine + ' | ' + (/Android/.test(navigator.userAgent) ? 'android' : 'not-android')`);
  console.log('env:', r2?.result?.result?.value);
  process.exit(0);
});
