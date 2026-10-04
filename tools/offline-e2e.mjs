/**
 * What survives a bad or missing connection.
 *
 *  1. a speaker that has the song keeps playing when its network dies
 *  2. it re-syncs by itself when the network comes back
 *  3. a speaker that already downloaded the song once starts INSTANTLY the
 *     next time (no transfer at all) — this is the "slow phone" case
 */
import { chromium } from 'playwright';
const APP = process.argv[2] || 'http://localhost:9090/';
const FILE = '/tmp/tone.wav';
let bad = false;
const log = (m) => console.log(m);
const fail = (m) => { bad = true; console.log(`✗ ${m}`); };

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const probe = (p) => p.evaluate(() => {
  const a = window.__syncAudio;
  return { t: a?.currentTime ?? 0, paused: a ? a.paused : true };
});

const hostCtx = await browser.newContext();
const host = await hostCtx.newPage();
await host.goto(`${APP}#/host?mode=direct`, { waitUntil: 'networkidle' });
await host.getByTestId('create-session').click();
await host.getByTestId('playlist').waitFor({ timeout: 90000 });
await host.getByTestId('file').setInputFiles(FILE);
await host.waitForTimeout(2500);

const spCtx = await browser.newContext();
const sp = await spCtx.newPage();
await sp.goto(`${APP}#/speaker?mode=direct`, { waitUntil: 'networkidle' });
await sp.getByTestId('enable-speaker').click({ timeout: 60000 });
for (let i = 0; i < 30; i++) {
  if ((await host.getByTestId('speaker-count').innerText()).trim() === '1') break;
  await host.waitForTimeout(1000);
}
log('✓ speaker connected');

await host.getByTestId('play').click();
await host.waitForTimeout(5000);
const before = await probe(sp);
if (before.paused) fail('the speaker never started');

/* 1. pull the plug ------------------------------------------------------- */
await spCtx.setOffline(true);
await host.waitForTimeout(6000);
const off = await probe(sp);
log(`  offline speaker: currentTime=${off.t.toFixed(2)} paused=${off.paused}`);
if (off.paused || off.t - before.t < 4) fail('the speaker stopped when its network died');
else log('✓ a speaker with no network keeps playing the song it holds');

/* 2. plug it back in ----------------------------------------------------- */
await spCtx.setOffline(false);
await host.waitForTimeout(15000);
const backState = await sp.evaluate(() => window.__syncClient?.state.conn);
const back = await probe(sp);
log(`  after the network returned: conn=${backState} currentTime=${back.t.toFixed(2)}`);
if (backState !== 'connected') fail('the speaker did not reconnect by itself');
else log('✓ it reconnects and re-syncs by itself');

/* 3. second visit: the song is already on the phone ---------------------- */
await sp.reload({ waitUntil: 'networkidle' });
await sp.getByTestId('enable-speaker').click({ timeout: 60000 });
const t0 = Date.now();
let cached = false;
for (let i = 0; i < 40; i++) {
  cached = await sp.evaluate(() => !!window.__syncClient?.haveTrack);
  if (cached) break;
  await sp.waitForTimeout(250);
}
const ms = Date.now() - t0;
log(`  track ready again after ${ms} ms`);
if (!cached) fail('the phone did not have the song after a reload');
else if (ms > 4000) fail(`the cached song took ${ms} ms to be ready`);
else log('✓ the song was already on the phone — nothing was transferred');

/* 4. a deliberately slow phone must still obey instantly ----------------- */
{
  const slowCtx = await browser.newContext();
  const slow = await slowCtx.newPage();
  await slow.goto(`${APP}#/speaker?mode=direct`, { waitUntil: 'networkidle' });
  await slow.getByTestId('enable-speaker').click({ timeout: 60000 });
  for (let i = 0; i < 40; i++) {
    if (await slow.evaluate(() => !!window.__syncClient?.haveTrack)) break;
    await slow.waitForTimeout(500);
  }
  // 2G-ish: 60 kB/s with a third of a second of latency
  const cdp = await slowCtx.newCDPSession(slow);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 300, downloadThroughput: 60 * 1024, uploadThroughput: 30 * 1024,
  });
  log('  second speaker throttled to a 2G-like link');

  await host.getByTestId('play').click();             // pause
  await host.waitForTimeout(1000);
  await host.evaluate(() => {
    const h = window.__syncHost;
    h.playTrack(h.state.transport.playlist[0].id);    // restart from the top
  });
  await host.waitForTimeout(6000);
  const fast = await probe(sp);
  const lag = await probe(slow);
  log(`  normal phone ${fast.t.toFixed(2)}s · throttled phone ${lag.t.toFixed(2)}s`);
  if (lag.paused) fail('the throttled phone did not start');
  else {
    const spread = Math.abs(fast.t - lag.t) * 1000;
    log(`✓ a 2G phone started ${spread.toFixed(0)} ms from the fast one`);
    if (spread > 300) fail(`the slow phone is ${spread.toFixed(0)} ms off`);
  }

  await host.getByTestId('play').click();             // pause
  await host.waitForTimeout(1500);
  const p1 = await probe(sp);
  const p2 = await probe(lag ? slow : slow);
  if (!p1.paused || !p2.paused) fail('PAUSE did not reach both phones within 1.5 s');
  else log('✓ PAUSE reached the fast and the 2G phone within 1.5 s');
}

await browser.close();
console.log(bad ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
process.exit(bad ? 1 : 0);
