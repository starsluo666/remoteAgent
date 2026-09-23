import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
let id = 0;
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id;
  ws.on('message', function h(d) {
    const m = JSON.parse(d);
    if (m.id === i) { ws.off('message', h); res(m.result); }
  });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return r?.result?.value;
};
ws.on('open', async () => {
  const info = await evalJs(`JSON.stringify({
    vw: innerWidth + 'x' + innerHeight,
    dpr: devicePixelRatio,
    ua: navigator.userAgent.slice(0, 60),
    page: document.body.innerText.slice(0, 60).replace(/\n/g, ' '),
    shellMainPe: getComputedStyle(document.querySelector('.shell-main') || document.body).pointerEvents,
    boot: !!document.getElementById('boot'),
  })`);
  console.log('INFO', info);
  // 物理坐标 720,1042 → CSS：scale = innerWidth/1440
  const probe = await evalJs(`(() => {
    const sx = innerWidth / 1440, sy = innerHeight / 2560;
    const x = 720 * sx, y = 1042 * sy;
    const el = document.elementFromPoint(x, y);
    return JSON.stringify({ css: [Math.round(x), Math.round(y)], tag: el ? el.tagName + '.' + (el.className || '').toString().slice(0, 40) : 'NULL', text: el ? (el.innerText || '').slice(0, 24) : '' });
  })()`);
  console.log('HIT', probe);
  process.exit(0);
});
