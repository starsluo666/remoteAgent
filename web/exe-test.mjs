import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
let seq = 0; const pend = new Map();
ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const ev = (expression) => new Promise((res) => { const i = ++seq; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

ws.on('open', async () => {
  const log = (tag, v) => console.log(tag, '=>', typeof v === 'string' ? v : JSON.stringify(v).slice(0, 160));

  // 0) 桌面端身份与布局
  log('环境', await ev(`JSON.stringify({ origin: location.origin, ua: navigator.userAgent.includes('Android'), titlebar: !!document.querySelector('.titlebar'), sidebar: !!document.querySelector('.shell-side'), bottomNav: !!document.querySelector('.bottom-nav'), winCaps: !!document.querySelector('.win-caps'), boot: !!document.getElementById('boot') })`));

  // 1) 概览页（本机）
  log('概览标题', await ev(`document.querySelector('.page-title')?.innerText`));
  log('设备ID卡', await ev(`[...document.querySelectorAll('.stat-label')].map(x=>x.innerText).join(',')`));
  log('主按钮', await ev(`document.querySelector('.page-head .primary-btn')?.innerText`));

  // 2) 顶栏拖拽区
  log('拖拽区', await ev(`[...document.querySelectorAll('[data-tauri-drag-region]')].length + ' 处'`));

  // 3) 设备页 → 连接弹窗（中继摘要）
  await ev(`location.hash = '#/devices'; 'ok'`); await sleep(700);
  log('设备页', await ev(`document.querySelector('.page-title')?.innerText`));
  log('本机行', await ev(`!!document.querySelector('.ra-row .row-title') && document.querySelector('.ra-row .row-title').innerText`));
  await ev(`[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='连接远程设备')?.click(); 'ok'`); await sleep(900);
  log('弹窗中继摘要', await ev(`document.querySelector('.relay-summary')?.innerText || document.querySelector('.relay-pick select') ? (document.querySelector('.relay-summary')?.innerText || '选择器模式') : '输入模式'`));
  log('弹窗输入框', await ev(`[...document.querySelectorAll('.connect-card input')].map(i=>i.placeholder.slice(0,10)).join(',')`));

  // 4) 快速启动 codex（真会话，AI hero 应实时识别）
  await ev(`document.querySelector('.connect-overlay')?.click(); 'close'`); await sleep(400);
  await ev(`location.hash = '#/sessions'; 'ok'`); await sleep(600);
  log('Sessions 空态', await ev(`document.querySelector('.empty-title')?.innerText`));
  await ev(`[...document.querySelectorAll('.ql-card')].find(c=>c.innerText.includes('Codex'))?.click(); 'ok'`);
  await sleep(4000);
  log('URL', await ev(`location.href.slice(0, 60)`));
  log('终端状态', await ev(`document.body.innerText.includes('在线') ? '在线' : (document.body.innerText.includes('重连') ? '重连中' : '其他')`));
  await sleep(12000);
  log('AI识别', await ev(`document.querySelector('.ai-pill')?.innerText || '尚未识别'`));
  process.exit(0);
});
