import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
let id = 0;
const pending = new Map();
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const evalJs = (expr) => new Promise((res) => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', expression: expr, returnByValue: true }));
});
ws.on('open', async () => {
  // 1) 进入面板 → 设备页
  await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.innerText.includes('进入应用')); if (b) b.click(); return 1; })()`);
  await new Promise(r => setTimeout(r, 800));
  await evalJs(`location.hash = '#/devices'`);
  await new Promise(r => setTimeout(r, 800));
  // 2) 取证：连接远程设备按钮的 rect + elementFromPoint
  const out = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '连接远程设备');
    if (!btn) return 'BTN NOT FOUND: ' + location.hash + ' | ' + document.body.innerText.slice(0, 80).replace(/\n/g, ' ');
    const r = btn.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const el = document.elementFromPoint(cx, cy);
    const pe = getComputedStyle(btn).pointerEvents;
    return JSON.stringify({
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      center: [Math.round(cx), Math.round(cy)],
      hit: el ? el.tagName + '.' + (el.className || '').toString().slice(0, 30) : 'NULL',
      hitIsBtn: el === btn || (btn.contains && btn.contains(el)),
      btnPointerEvents: pe,
      viewport: innerWidth + 'x' + innerHeight,
    });
  })()`);
  console.log('EVIDENCE', out);
  process.exit(0);
});
