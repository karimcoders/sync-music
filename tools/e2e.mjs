#!/usr/bin/env node
/**
 * End-to-end test in real Chromium: host console creates a session and uploads
 * a track, two independent "phones" open /speaker, tap CONNECT + ENABLE
 * SPEAKER, the host presses PLAY, and we assert that BOTH speakers are really
 * decoding audio and are aligned with each other.
 *
 *   node tools/e2e.mjs http://localhost:8080 [speakers]
 */
import { chromium } from 'playwright';

const base = (process.argv[2] ?? 'http://localhost:8080').replace(/\/$/, '');
const N = Number(process.argv[3] ?? 2);
const log = (...a) => console.log(...a);
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1; };

const browser = await chromium.launch({
  args: ['--autoplay-policy=user-gesture-required', '--mute-audio', '--no-sandbox'],
});

/* ------------------------------- host ---------------------------------- */
const hostCtx = await browser.newContext();
const host = await hostCtx.newPage();
host.on('console', (m) => m.type() === 'error' && log('  host console error:', m.text()));
host.on('pageerror', (e) => fail('host page error: ' + e.message));
await host.goto(`${base}/host`, { waitUntil: 'domcontentloaded' });
await host.fill('input[type=text]', 'E2E Session');
await host.click('[data-testid=create-session]');
await host.waitForSelector('[data-testid=speaker-count]', { timeout: 20000 });
log('✓ host created session');

await host.setInputFiles('[data-testid=file]', '/tmp/tone.wav');
await host.waitForFunction(
  () => document.querySelectorAll('[data-testid=playlist] .list-item').length > 0, null, { timeout: 30000 });
log('✓ track uploaded and in playlist');

/* ------------------------------ speakers -------------------------------- */
const speakers = [];
for (let i = 0; i < N; i++) {
  const ctx = await browser.newContext(); // isolated storage = a separate phone
  const p = await ctx.newPage();
  p.on('pageerror', (e) => fail(`speaker ${i} page error: ` + e.message));
  await p.goto(`${base}/speaker`, { waitUntil: 'domcontentloaded' });
  // auto-attach happens when exactly one host session exists; otherwise the
  // page lists the available hosts and we pick ours.
  await p.waitForSelector('[data-testid=connect-host], [data-testid=enable-speaker]', { timeout: 25000 });
  const connect = p.locator('[data-testid=connect-host]');
  if (await connect.count()) await connect.first().click();
  await p.waitForSelector('[data-testid=enable-speaker]', { timeout: 25000 });
  await p.click('[data-testid=enable-speaker]');
  await p.waitForFunction(() => !!window.__syncAudio, null, { timeout: 10000 });
  speakers.push(p);
  log(`✓ speaker ${i + 1} connected and audio enabled`);
}

await host.waitForFunction(
  (n) => Number(document.querySelector('[data-testid=speaker-count]')?.textContent) >= n, N, { timeout: 25000 })
  .then(() => log(`✓ host shows Connected Speakers: ${N}`))
  .catch(() => fail(`host never showed ${N} speakers`));

/* -------------------------------- play ---------------------------------- */
await host.click('[data-testid=play]');
log('→ PLAY sent, waiting for the scheduled start…');
await new Promise((r) => setTimeout(r, 3500));

const probe = (p) => p.evaluate(() => {
  const a = window.__syncAudio;
  return a ? { t: a.currentTime, paused: a.paused, src: !!a.src, rate: a.playbackRate, ready: a.readyState } : null;
});

const first = await Promise.all(speakers.map(probe));
first.forEach((s, i) => log(`  speaker ${i + 1}: currentTime=${s?.t?.toFixed(3)} paused=${s?.paused} readyState=${s?.ready}`));

if (first.some((s) => !s || s.paused)) fail('a speaker is not playing after PLAY');
if (first.some((s) => !s || s.t <= 0.05)) fail('a speaker is not advancing through the audio');

const sid = await host.evaluate(() => JSON.parse(localStorage.getItem('sync-music.host')).sessionId);
const srv = await (await fetch(`${base}/api/session/${sid}/state`)).json();
const vsServer = first.map((s) => (s.t - srv.transport.position) * 1000);
log(`✓ offset vs server timeline: ${vsServer.map((v) => v.toFixed(0) + 'ms').join(', ')}`);
// Note: this number also contains the latency of the state fetch itself, so it is
// only a coarse guard against a systematic scheduling bug (it used to be ~1400 ms).
if (vsServer.some((v) => Math.abs(v) > 600)) fail('a speaker is off the server timeline by more than 600 ms');

const spread = Math.max(...first.map((s) => s.t)) - Math.min(...first.map((s) => s.t));
log(`✓ inter-speaker spread at start: ${(spread * 1000).toFixed(1)} ms`);
if (spread > 0.25) fail(`speakers are more than 250 ms apart (${(spread * 1000).toFixed(0)} ms)`);

// let it run and re-measure: this is the drift controller doing its job
await new Promise((r) => setTimeout(r, 6000));
const later = await Promise.all(speakers.map(probe));
later.forEach((s, i) => log(`  speaker ${i + 1} after 6 s: currentTime=${s.t.toFixed(3)} rate=${s.rate}`));
const spread2 = Math.max(...later.map((s) => s.t)) - Math.min(...later.map((s) => s.t));
log(`✓ inter-speaker spread after 6 s: ${(spread2 * 1000).toFixed(1)} ms`);
if (spread2 > 0.25) fail(`drift grew beyond 250 ms (${(spread2 * 1000).toFixed(0)} ms)`);

/* ------------------------------- pause ---------------------------------- */
await host.click('[data-testid=play]'); // now PAUSE
await new Promise((r) => setTimeout(r, 1500));
const paused = await Promise.all(speakers.map(probe));
if (paused.some((s) => !s.paused)) fail('a speaker kept playing after PAUSE');
else log('✓ PAUSE stopped every speaker');

/* -------------------------- reconnect behaviour -------------------------- */
await speakers[0].reload();
await speakers[0].waitForSelector('[data-testid=enable-speaker]', { timeout: 25000 });
await speakers[0].click('[data-testid=enable-speaker]'); // re-arm audio after a reload (gesture required)
log('✓ speaker 1 survived a browser refresh and re-attached');

await host.click('[data-testid=play]');
await new Promise((r) => setTimeout(r, 3500));
const after = await probe(speakers[N - 1]);
if (!after || after.paused || after.t <= 0.05) fail('resume after pause did not play');
else log(`✓ resumed, speaker ${N} at ${after.t.toFixed(3)}s`);

await browser.close();
log(process.exitCode ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
