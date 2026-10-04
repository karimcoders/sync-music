/**
 * End-to-end test for DIRECT (serverless) mode.
 *
 *   node tools/p2p-e2e.mjs <app-url> <speakers>
 *
 * It opens a real host tab and N real speaker tabs in Chromium, lets them find
 * each other through the public PeerJS broker (no backend is running at all),
 * plays a real file and measures how far apart the phones actually are.
 */
import { chromium } from 'playwright';

/** The controller is behind an id + password; first run also sets one. */
async function signIn(page) {
  if (!(await page.getByTestId('host-signin').count())) return;
  await page.getByTestId('host-id').fill('admin');
  await page.getByTestId('host-pw').fill('syncmusic');
  await page.getByTestId('host-signin').click();
  // first run on a fresh profile: choose the real password straight away
  await page.waitForFunction(() =>
    !!document.querySelector('[data-testid=save-pw],[data-testid=create-session]'), null, { timeout: 30000 });
  if (await page.getByTestId('save-pw').count()) {
    await page.getByTestId('new-pw').fill('syncmusic');
    await page.getByTestId('new-pw2').fill('syncmusic');
    await page.getByTestId('save-pw').click();
  }
  await page.getByTestId('create-session').waitFor({ timeout: 30000 });
}

const APP = process.argv[2] ?? 'http://localhost:9090/';
const N = Number(process.argv[3] ?? 2);
const FILE = '/tmp/tone.wav';

let bad = 0;
const log = (m) => console.log(m);
const fail = (m) => { bad++; console.log(`✗ ${m}`); };

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = async () => (await browser.newContext()).newPage();

const host = await page();
host.on('pageerror', (e) => console.log('  host error:', e.message));
await host.goto(`${APP}#/host?mode=direct`, { waitUntil: 'networkidle' });
await signIn(host);
await host.getByTestId('create-session').click();
// the single permanent room can still be held by the previous run's host
await host.getByTestId('playlist').waitFor({ timeout: 90000 });
const link = await host.getByTestId('speaker-link').getAttribute('href');
if (!link) fail('host did not publish a speaker link');
if (/[?&]h=/.test(link)) fail(`the speaker link is still session-specific: ${link}`);
log(`✓ one permanent room open — ${link}`);

await host.getByTestId('file').setInputFiles(FILE);
await host.waitForTimeout(2500);

const speakers = [];
for (let i = 0; i < N; i++) {
  const p = await page();
  p.on('pageerror', (e) => console.log(`  speaker ${i + 1} error:`, e.message));
  await p.goto(`${link}?mode=direct`, { waitUntil: 'networkidle' });
  await p.getByTestId('enable-speaker').click({ timeout: 30000 });
  speakers.push(p);
  log(`✓ speaker ${i + 1} connected over WebRTC and audio enabled`);
}

// a phone needs a moment to negotiate WebRTC and receive the track
let count = '0';
for (let i = 0; i < 30; i++) {
  count = (await host.getByTestId('speaker-count').innerText()).trim();
  if (Number(count) === N) break;
  await host.waitForTimeout(1000);
}
log(`✓ host shows Connected Speakers: ${count}`);
if (Number(count) !== N) fail(`host should see ${N} speakers, shows ${count}`);

await host.getByTestId('play').click();
log('→ PLAY sent, waiting for the scheduled start…');
await host.waitForTimeout(6000);

const probe = (p) => p.evaluate(() => {
  const a = window.__syncAudio;
  return a ? { t: a.currentTime, paused: a.paused, rate: a.playbackRate } : null;
});

{
  const engines = await Promise.all(speakers.map((p) => p.evaluate(() => window.__syncAudio?.engine)));
  console.log(`  playback engine: ${engines.join(', ')}`);
  if (engines.every((e) => e === 'webaudio')) console.log('✓ every speaker is on the decoded, gap-free engine');
  else console.log('! at least one speaker fell back to the <audio> element');
}

// Does the sound actually run smoothly? Sample one speaker for 8 s and look
// for a step that is not ~the wall-clock time that passed: that is the
// "ruk ruk" the listener hears, and it never showed up in a spread figure.
{
  const samples = await speakers[0].evaluate(async () => {
    const out = [];
    for (let i = 0; i < 40; i++) {
      out.push([performance.now(), window.__syncAudio?.currentTime ?? 0]);
      await new Promise((r) => setTimeout(r, 200));
    }
    return out;
  });
  let worst = 0;
  for (let i = 1; i < samples.length; i++) {
    const wall = (samples[i][0] - samples[i - 1][0]) / 1000;
    const played = samples[i][1] - samples[i - 1][1];
    worst = Math.max(worst, Math.abs(played - wall) * 1000);
  }
  console.log(`  worst gap between played time and real time over 8 s: ${worst.toFixed(1)} ms`);
  if (worst < 60) console.log(`✓ no stutter: playback tracked real time within ${worst.toFixed(0)} ms`);
  else fail(`playback stalled or jumped by ${worst.toFixed(0)} ms`);
}

const dbg = async (p) => p.evaluate(() => window.__syncClient?.debug ?? null);
const d0 = await Promise.all(speakers.map(dbg));
d0.forEach((d, i) => d && console.log(`  speaker ${i + 1} clock: offset=${d.offset?.toFixed(1)}ms rtt=${d.rtt?.toFixed(1)}ms target=${d.target?.toFixed(3)}`));

const first = await Promise.all(speakers.map(probe));
first.forEach((s, i) => log(`  speaker ${i + 1}: currentTime=${s?.t?.toFixed(3)} paused=${s?.paused}`));
if (first.some((s) => !s || s.paused)) fail('a speaker is not playing');
else {
  const spread = (Math.max(...first.map((s) => s.t)) - Math.min(...first.map((s) => s.t))) * 1000;
  log(`✓ inter-speaker spread at start: ${spread.toFixed(1)} ms`);
  if (spread > 300) fail(`start spread too large: ${spread.toFixed(0)} ms`);
}

await host.waitForTimeout(6000);
const d1 = await Promise.all(speakers.map(dbg));
d1.forEach((d, i) => d && console.log(`  speaker ${i + 1} clock: offset=${d.offset?.toFixed(1)}ms rtt=${d.rtt?.toFixed(1)}ms target=${d.target?.toFixed(3)}`));

const later = await Promise.all(speakers.map(probe));
later.forEach((s, i) => log(`  speaker ${i + 1} after 6 s: currentTime=${s.t.toFixed(3)} rate=${s.rate}`));
const spread2 = (Math.max(...later.map((s) => s.t)) - Math.min(...later.map((s) => s.t))) * 1000;
log(`✓ inter-speaker spread after 6 s: ${spread2.toFixed(1)} ms`);
if (spread2 > 150) fail(`drift spread too large: ${spread2.toFixed(0)} ms`);

await host.getByTestId('play').click(); // pause
await host.waitForTimeout(1200);
const paused = await Promise.all(speakers.map(probe));
if (paused.some((s) => !s.paused)) fail('PAUSE did not reach every speaker');
else log('✓ PAUSE stopped every speaker');

/* ---- a phone that joins late must get everything, and every phone must ----
   ---- keep receiving commands afterwards (regression: only the newest   ----
   ---- speaker reacted)                                                  ---- */
await host.getByTestId('play').click(); // resume
await host.waitForTimeout(2500);

const late = await page();
late.on('pageerror', (e) => console.log('  late speaker error:', e.message));
await late.goto(`${link}?mode=direct`, { waitUntil: 'networkidle' });
await late.getByTestId('enable-speaker').click({ timeout: 30000 });
speakers.push(late);
log('✓ a late speaker joined while the song was playing');
await host.waitForTimeout(6000);

const all = await Promise.all(speakers.map(probe));
all.forEach((s, i) => log(`  speaker ${i + 1}: currentTime=${s?.t?.toFixed(3)} paused=${s?.paused}`));
if (all.some((s) => !s || s.paused)) fail('a speaker is not playing after the late join');
else {
  const sp = (Math.max(...all.map((s) => s.t)) - Math.min(...all.map((s) => s.t))) * 1000;
  log(`✓ spread including the late joiner: ${sp.toFixed(1)} ms`);
  if (sp > 300) fail(`late-join spread too large: ${sp.toFixed(0)} ms`);
}

await host.getByTestId('play').click(); // pause again — must reach ALL
await host.waitForTimeout(1500);
const paused2 = await Promise.all(speakers.map(probe));
paused2.forEach((s, i) => { if (!s.paused) fail(`speaker ${i + 1} ignored the second PAUSE`); });
if (paused2.every((s) => s.paused)) log('✓ second PAUSE reached every speaker, including the first one');

/* ---- a speaker must keep playing when its screen goes off ------------ */
{
  // Restart from the top: by this point the 30 s fixture has nearly run out,
  // and "ended" would look exactly like "stopped when the screen went off".
  await host.evaluate(() => {
    const h = window.__syncHost;
    h.playTrack(h.state.transport.playlist[0].id);
  });
  await host.waitForTimeout(4000);

  const victim = speakers[0];
  const hide = (hidden) => victim.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { value: h, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

  await hide(true);
  await host.waitForTimeout(5000);
  const off = await probe(victim);
  log(`  hidden speaker: currentTime=${off.t.toFixed(3)} paused=${off.paused}`);
  if (off.paused || off.t < 1) fail('a speaker stopped when its screen went off');
  else log('✓ a speaker with the screen off keeps playing');
  await hide(false);
  await host.waitForTimeout(1500);
}

/* ---- the host device must play the song too, in the same timeline ---- */
{
  const h = await host.evaluate(() => window.__syncHost?.localAudioState ?? null);
  const others = await Promise.all(speakers.map(probe));
  if (!h) log('  (host audio element not created — autoplay was blocked in this browser)');
  else {
    log(`  host's own output: currentTime=${h.t.toFixed(3)} paused=${h.paused}`);
    const all = [h.t, ...others.map((s) => s.t)];
    const sp = (Math.max(...all) - Math.min(...all)) * 1000;
    log(`✓ the host device followed the same timeline: ${sp.toFixed(1)} ms from the speakers`);
    if (sp > 300) fail(`the host device is ${sp.toFixed(0)} ms away from the speakers`);
    if (h.paused !== others[0].paused) fail('the host device ignored the transport command');
  }
}

/* ---- the host tab must survive a refresh (room id + library persist) ---- */
await host.reload({ waitUntil: 'networkidle' });
// reclaiming the broker slot plus the speakers' rescan takes a few seconds
await host.waitForTimeout(20000);
const stillLive = await host.getByTestId('speaker-count').count();
if (!stillLive) fail('the room disappeared after the host refreshed');
else {
  const back = (await host.getByTestId('speaker-count').innerText()).trim();
  log(`✓ host refreshed: room still open, speakers back: ${back}`);
  if (Number(back) === 0) fail('no speaker reconnected after the host refreshed');
  const pl = await host.locator('[data-testid=playlist] .list-item').count();
  log(`✓ playlist restored after refresh: ${pl} track(s)`);
  if (!pl) fail('the playlist was lost on refresh');
  await host.getByTestId('play').click();
  await host.waitForTimeout(6000);
  const after = await Promise.all(speakers.map(probe));
  after.forEach((s, i) => log(`  speaker ${i + 1} after host refresh: currentTime=${s?.t?.toFixed(3)} paused=${s?.paused}`));
  if (after.some((s) => !s || s.paused)) fail('speakers did not play after the host refreshed');
  else {
    const sp = (Math.max(...after.map((s) => s.t)) - Math.min(...after.map((s) => s.t))) * 1000;
    log(`  spread right after the host refresh: ${sp.toFixed(1)} ms (clocks are re-syncing)`);
    await host.waitForTimeout(8000);
    const settled = await Promise.all(speakers.map(probe));
    const sp2 = (Math.max(...settled.map((s) => s.t)) - Math.min(...settled.map((s) => s.t))) * 1000;
    log(`✓ spread once settled after the host refresh: ${sp2.toFixed(1)} ms`);
    if (sp2 > 150) fail(`post-refresh spread too large: ${sp2.toFixed(0)} ms`);
  }
}

await browser.close();
console.log(bad ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
process.exit(bad ? 1 : 0);
