import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
let seq = 0;
const pend = new Map();
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
  }
});
const ev = (expression) => new Promise((res) => {
  const i = ++seq; pend.set(i, res);
  ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
});
const show = async (tag, expression) => {
  const m = await ev(expression);
  const v = m.result?.result?.value ?? JSON.stringify(m.result?.exceptionDetails?.exception?.description || m.result).slice(0, 200);
  console.log(tag, '=>', v);
  return v;
};
ws.on('open', async () => {
  await show('ENTER', `var b=[...document.querySelectorAll('button')].find(x=>x.innerText.includes('进入应用')); b?b.click():'none'`);
  await new Promise(r => setTimeout(r, 900));
  await show('HASH', `location.hash='#/devices'; 'set'`);
  await new Promise(r => setTimeout(r, 900));
  await show('BTNS', `JSON.stringify([...document.querySelectorAll('button')].map(b=>b.innerText.trim()).filter(Boolean).slice(0,12))`);
  await show('HIT', `var b=[...document.querySelectorAll('button')].find(x=>x.innerText.trim()==='连接远程设备'); b? (function(){var r=b.getBoundingClientRect();var el=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2); return JSON.stringify({rect:[r.x,r.y,r.width,r.height].map(Math.round),hit:el?el.tagName+'.'+String(el.className).slice(0,25):'NULL',isBtn:el===b,pe:getComputedStyle(b).pointerEvents})})() : 'NOBTN'`);
  process.exit(0);
});
