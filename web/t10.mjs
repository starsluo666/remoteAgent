import WebSocket from 'ws';
import fs from 'fs';
const ws = new WebSocket('ws://127.0.0.1:9800/ws');
let reqId = 1;
const send = (o) => ws.send(JSON.stringify(o));
ws.on('open', () => send({ t: 'hello', v: 1, role: 'client', deviceId: 'probe' }));
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.t === 'error') { console.log('ERROR:', JSON.stringify(m)); process.exit(1); }
  if (m.t === 'hello_ack') send({ t: 'session.create', reqId: ++reqId, cols: 100, rows: 30, cmd: 'powershell' });
  else if (m.t === 'session.created') {
    console.log('CREATED', m.sessionId.slice(2, 8));
    fs.writeFileSync('/tmp/ra-sid.txt', m.sessionId);
    send({ t: 'session.attach', reqId: ++reqId, sessionId: m.sessionId });
    setTimeout(() => send({ t: 'input', sessionId: m.sessionId, data: Buffer.from('echo RA-PERSIST-MARK\r').toString('base64') }), 2000);
    setTimeout(() => process.exit(0), 4500);
  }
});
setTimeout(() => process.exit(0), 12000);
