import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
let seq = 0; const pend = new Map();
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const ev = (expression) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); });
ws.on('open', async () => {
  // React 受控组件赋值：native setter + input 事件
  const fill = `(() => {
    const inputs = [...document.querySelectorAll('.connect-card input')];
    const dev = inputs.find(i => (i.placeholder||'').includes('9 位设备号'));
    const tok = inputs.find(i => i.type === 'password');
    if (!dev || !tok) return 'NOINPUTS ' + inputs.length;
    const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    set(dev, '239965533');
    set(tok, 'Ra-2026-gz');
    return 'FILLED';
  })()`;
  console.log('FILL =>', await ev(fill));
  await new Promise(r => setTimeout(r, 500));
  // 连接按钮中心 CSS 坐标（供 adb 换算点按）
  const rect = await ev(`(() => { const b = document.querySelector('.connect-go'); if (!b) return 'NOGO'; const r = b.getBoundingClientRect(); return Math.round(r.x + r.width/2) + ',' + Math.round(r.y + r.height/2); })()`);
  console.log('GO_CENTER_CSS =>', rect);
  process.exit(0);
});
