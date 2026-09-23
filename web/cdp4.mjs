import WebSocket from 'ws';
const ws = new WebSocket(process.argv[2]);
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  console.log('RAW:', JSON.stringify(m).slice(0, 500));
  if (m.id === 1) {
    ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: 'document.title + " | " + location.hash + " | " + innerWidth + "x" + innerHeight', returnByValue: true } }));
  }
  if (m.id === 2) process.exit(0);
});
ws.on('open', () => {
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } }));
});
