#!/usr/bin/env node
/**
 * Headless speaker swarm — proves the system has no fixed speaker limit and
 * measures real scheduling accuracy.
 *
 *   node tools/loadtest.mjs --url http://localhost:8080 --speakers 50
 *
 * Each virtual speaker performs the full protocol: discovery, join, NTP clock
 * sync, telemetry, and it reports how far its *scheduled* start time would have
 * been from the commanded server timestamp. It does NOT decode audio, so it
 * measures the control plane, not a phone's audio pipeline.
 */
import WebSocket from 'ws';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const base = arg('url', 'http://localhost:8080').replace(/\/$/, '');
const n = Number(arg('speakers', '25'));
const wsUrl = base.replace(/^http/, 'ws') + '/ws';

const { sessions } = await (await fetch(`${base}/api/session/active`)).json();
if (!sessions.length) {
  console.error('No active host session. Create one first:\n  curl -XPOST %s/api/session/create -H "content-type: application/json" -d \'{"name":"Load test"}\'', base);
  process.exit(1);
}
const sessionId = sessions[0].sessionId;
console.log(`attaching ${n} virtual speakers to "${sessions[0].name}"`);

const stats = { joined: 0, errors: 0, startDeviations: [], latencies: [] };

for (let i = 0; i < n; i++) {
  setTimeout(() => spawn(i), i * 25); // ramp, don't thundering-herd
}

function spawn(i) {
  const ws = new WebSocket(wsUrl);
  let offset = 0, bestRtt = Infinity;
  const serverNow = () => Date.now() + offset;

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'SPEAKER_JOIN', sessionId, deviceId: `loadtest-${i}-${Date.now()}` }));
    for (let k = 0; k < 5; k++) {
      setTimeout(() => ws.send(JSON.stringify({ type: 'CLOCK_SYNC', clientTime: Date.now() })), k * 120);
    }
    setInterval(() => ws.send(JSON.stringify({ type: 'CLOCK_SYNC', clientTime: Date.now() })), 15000).unref();
    setInterval(() => ws.send(JSON.stringify({
      type: 'PLAYBACK_STATUS', position: 0, state: 'playing', buffered: 5,
    })), 5000).unref();
  });

  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'SESSION_STATE') stats.joined++;
    if (m.type === 'CLOCK_SYNC_REPLY') {
      const t4 = Date.now();
      const rtt = t4 - m.clientTime - (m.serverSendTime - m.serverReceiveTime);
      if (rtt < bestRtt) {
        bestRtt = rtt;
        offset = (m.serverReceiveTime - m.clientTime + (m.serverSendTime - t4)) / 2;
        stats.latencies.push(rtt / 2);
      }
    }
    if (m.type === 'SYNC_PLAY') {
      const lead = m.startAt - serverNow();
      setTimeout(() => stats.startDeviations.push(serverNow() - m.startAt), Math.max(0, lead));
    }
    if (m.type === 'ERROR') { stats.errors++; console.error(`speaker ${i}: ${m.code} ${m.message}`); }
  });
  ws.on('error', () => stats.errors++);
}

const pct = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] : 0);
setInterval(() => {
  const d = stats.startDeviations.map(Math.abs);
  console.log(
    `joined=${stats.joined}/${n} errors=${stats.errors} ` +
    `latency p50=${pct(stats.latencies, 0.5).toFixed(1)}ms p95=${pct(stats.latencies, 0.95).toFixed(1)}ms ` +
    `start-deviation p50=${pct(d, 0.5).toFixed(1)}ms p95=${pct(d, 0.95).toFixed(1)}ms (n=${d.length})`,
  );
}, 5000);
