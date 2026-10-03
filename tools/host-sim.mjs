import WebSocket from 'ws';
const [sid, tok] = process.argv.slice(2);
const ws = new WebSocket('ws://localhost:8080/ws');
ws.on('open', () => ws.send(JSON.stringify({ type: 'HOST_JOIN', sessionId: sid, hostToken: tok })));
ws.on('message', (r) => {
  const m = JSON.parse(String(r));
  if (m.type === 'SPEAKERS_SNAPSHOT') console.log('HOST SEES speakers:', m.speakerCount, 'avgDrift', m.averageDriftMs, 'truncated', m.truncated);
  if (m.type === 'ERROR') console.log('ERR', m);
});
setTimeout(() => ws.send(JSON.stringify({ type: 'HOST_PLAY' })), 6000);
setTimeout(() => process.exit(0), 20000);
