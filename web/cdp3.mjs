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
  const step1 = await evalJs(`(() => { try { const b = [...document.querySelectorAll('button')].find(x => x.innerText.includes('进入应用')); if (b) { b.click(); return 'ENTER OK'; } return 'NO ENTER BTN | hash=' + location.hash; } catch (e) { return 'ERR ' + e.message; } })()`);
  console.log('STEP1:', JSON.stringify(step1));
  await new Promise(r => setTimeout(r, 900));
  const step2 = await evalJs(`(() => { try { location.hash = '#/devices'; return 'HASH SET'; } catch (e) { return 'ERR ' + e.message; } })()`);
  console.log('STEP2:', JSON.stringify(step2));
  await new Promise(r => setTimeout(r, 900));
  const step3 = await evalJs(`(() => { try {
    const btns = [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean);
    const btn = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '连接远程设备');
    if (!btn) return 'NOBTN. buttons=' + JSON.stringify(btns.slice(0, 10));
    const r = btn.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const el = document.elementFromPoint(cx, cy);
    return JSON.stringify({ rect: [r.x, r.y, r.width, r.height].map(Math.round), hit: el ? el.tagName : 'NULL', hitCls: el ? String(el.className).slice(0, 30) : '', isBtn: el === btn, pe: getComputedStyle(btn).pointerEvents });
  } catch (e) { return 'ERR ' + e.message; } })()`);
  console.log('STEP3:', JSON.stringify(step3));
  process.exit(0);
});
