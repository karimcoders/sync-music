/**
 * A phone that is playing must never claim it is looking for the host.
 *
 * The bug this exists for, straight from a photo of a real phone: the song was
 * playing at 1 ms of drift and the screen said CONNECTING, with "Looking for
 * the host…" underneath. Six seconds without a PONG — normal on mobile data,
 * or when the host tab is throttled — tore down a perfectly open channel and
 * restarted discovery, over and over.
 *
 * Checks:
 *  1. a quiet-but-open channel is probed, not killed;
 *  2. while this phone is making sound it never shows "connecting" or
 *     "Looking for the host…";
 *  3. a channel that is genuinely gone still reconnects.
 *
 * Usage: node tools/steady-e2e.mjs [url]
 */
import { chromium } from 'playwright';

const APP = process.argv[2] || 'http://localhost:9090/';
let bad = 0;
const ok = (m) => console.log(`✓ ${m}`);
const fail = (m) => { bad++; console.log(`✗ ${m}`); };

async function signIn(p) {
  if (!(await p.getByTestId('host-signin').count())) return;
  await p.getByTestId('host-id').fill('admin');
  await p.getByTestId('host-pw').fill('syncmusic');
  await p.getByTestId('host-signin').click();
  await p.waitForFunction(() => !!document.querySelector('[data-testid=save-pw],[data-testid=create-session]'), null, { timeout: 30000 });
  if (await p.getByTestId('save-pw').count()) {
    await p.getByTestId('new-pw').fill('syncmusic');
    await p.getByTestId('new-pw2').fill('syncmusic');
    await p.getByTestId('save-pw').click();
  }
  await p.getByTestId('create-session').waitFor({ timeout: 30000 });
}

const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const pg = async () => (await b.newContext()).newPage();

const host = await pg();
await host.goto(`${APP}#/host?mode=direct`, { waitUntil: 'networkidle' });
await signIn(host);
await host.getByTestId('create-session').click();
await host.getByTestId('playlist').waitFor({ timeout: 90000 });
const link = await host.getByTestId('speaker-link').getAttribute('href');
await host.getByTestId('file').setInputFiles('/tmp/tone.wav');

const sp = await pg();
await sp.goto(`${link}?mode=direct`, { waitUntil: 'networkidle' });
await sp.getByTestId('enable-speaker').click({ timeout: 30000 });
await host.waitForFunction(() => (window.__syncHost?.state?.speakers ?? []).some((x) => x.ready), null, { timeout: 90000 });
await host.getByTestId('play').click();
await host.waitForTimeout(4000);

const probe = () => sp.evaluate(() => {
  const s = window.__syncClient.state; const a = window.__syncAudio;
  return { conn: s.conn, info: s.info, phase: s.phase, playing: !!a && !a.paused, t: +(a?.currentTime ?? -1).toFixed(2) };
});

const start = await probe();
if (!start.playing) fail(`the song never started (${JSON.stringify(start)})`);
else ok(`playing at ${start.t}s, state "${start.conn}"`);

/* ---- 1. a long quiet patch on a channel that is still open --------------- */
// Exactly what a throttled host tab looks like from here: no inbound traffic
// for a while, but the data channel is perfectly fine.
// Freeze the "last time we heard anything" reading. Simply assigning it is
// not enough: the host keeps talking and the next message resets it, which is
// why this scenario never showed up in the lab while real phones hit it daily.
await sp.evaluate(() => {
  const c = window.__syncClient;
  c.__frozenInbound = Date.now() - 25000;
  Object.defineProperty(c, 'lastInbound', {
    get() { return c.__frozenInbound; }, set() {}, configurable: true,
  });
});
let flapped = 0; let sawLooking = 0; let silentSamples = 0; let tornDown = 0;
for (let i = 0; i < 20; i++) {
  const r = await probe();
  if (r.conn === 'connecting') flapped++;
  if (r.conn === 'reconnecting') tornDown++;
  if (/looking for the host/i.test(r.info || '')) sawLooking++;
  if (!r.playing) silentSamples++;
  await sp.waitForTimeout(1000);
}
console.log(`  during 20 s of simulated quiet: connecting ${flapped}/20, reconnecting ${tornDown}/20, "Looking for the host" ${sawLooking}/20, silent ${silentSamples}/20`);
// The link is PHYSICALLY fine here — only the app-level traffic went quiet,
// exactly like a host phone whose screen went off. Tearing it down sent the
// phone hunting for room slots that a throttled host cannot answer, and it
// sat on RECONNECTING with the song still playing. It must simply wait.
if (tornDown === 0) ok('a quiet but physically-alive link is left alone, not torn down');
else fail(`the phone tore down a live link and went hunting (${tornDown}/20 samples on "reconnecting")`);
if (flapped === 0 && sawLooking === 0) ok('a playing phone never claimed it was looking for the host');
else fail(`the phone said it was connecting (${flapped}) / looking for the host (${sawLooking}) while the music played`);
if (silentSamples === 0) ok('the music never stopped');
else fail(`the music stopped for ${silentSamples} of 12 samples`);

// let it hear the world again
await sp.evaluate(() => {
  const c = window.__syncClient;
  delete c.lastInbound;
  c.lastInbound = Date.now();
});
await sp.waitForTimeout(1500);

const after = await probe();
if (after.conn === 'connected') ok('the channel survived the quiet patch — it was probed, not killed');
else console.log(`  (state after the quiet patch: ${after.conn} — acceptable as long as it recovers below)`);

/* ---- 2. a channel that really is gone must still reconnect -------------- */
await sp.evaluate(() => { try { window.__syncClient.conn.close(); } catch {} });
let back = null;
for (let i = 0; i < 40; i++) {
  back = await probe();
  if (back.conn === 'connected') break;
  await sp.waitForTimeout(1000);
}
console.log(`  after the channel was closed for real: ${JSON.stringify(back)}`);
if (back?.conn === 'connected') ok('a genuinely dead channel still reconnects');
else fail('the phone did not come back after the channel really closed');

const end = await probe();
if (end.playing) ok(`still playing at the end, at ${end.t}s`);
else fail('the phone is silent at the end');

await b.close();
console.log(bad ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
process.exit(bad ? 1 : 0);
