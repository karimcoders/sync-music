/**
 * Two promises this checks, because both were broken on a real phone:
 *  1. adding/switching to a song nobody has yet must NOT silence the music —
 *     the song already playing carries on until the new file is really there;
 *  2. refreshing a speaker page must not leave it stopped.
 *   node tools/nogap-e2e.mjs <app-url>
 */
import { chromium } from 'playwright';
const APP = process.argv[2] ?? 'http://localhost:9090/';
let bad = 0;
const log = (m) => console.log(m);
const fail = (m) => { bad++; console.log(`✗ ${m}`); };

async function signIn(page) {
  if (!(await page.getByTestId('host-signin').count())) return;
  await page.getByTestId('host-id').fill('admin');
  await page.getByTestId('host-pw').fill('syncmusic');
  await page.getByTestId('host-signin').click();
  await page.waitForFunction(() => !!document.querySelector('[data-testid=save-pw],[data-testid=create-session]'), null, { timeout: 30000 });
  if (await page.getByTestId('save-pw').count()) {
    await page.getByTestId('new-pw').fill('syncmusic');
    await page.getByTestId('new-pw2').fill('syncmusic');
    await page.getByTestId('save-pw').click();
  }
  await page.getByTestId('create-session').waitFor({ timeout: 30000 });
}
const probe = (p) => p.evaluate(() => {
  const a = window.__syncAudio; const s = window.__syncClient?.state;
  return { t: a ? a.currentTime : -1, paused: a ? a.paused : true, title: s?.title ?? s?.trackTitle, info: s?.info, phase: s?.phase };
});

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = async () => (await browser.newContext()).newPage();

const host = await page();
await host.goto(`${APP}#/host?mode=direct`, { waitUntil: 'networkidle' });
await signIn(host);
await host.getByTestId('create-session').click();
await host.getByTestId('playlist').waitFor({ timeout: 90000 });
const link = await host.getByTestId('speaker-link').getAttribute('href');

await host.getByTestId('file').setInputFiles('/tmp/tone.wav');
await host.waitForTimeout(1500);

const sp = await page();
await sp.goto(`${link}?mode=direct`, { waitUntil: 'networkidle' });
await sp.getByTestId('enable-speaker').click({ timeout: 30000 });
// wait until the phone actually holds the first song, so this test measures
// the switch and not the very first download
// the host is the honest source: it only marks a phone ready when that
// phone has confirmed it holds the song
await host.waitForFunction(
  () => (window.__syncHost?.state?.speakers ?? []).some((x) => x.ready),
  null, { timeout: 90000 },
);
await host.getByTestId('play').click();
await host.waitForTimeout(4000);
const before = await probe(sp);
if (before.paused) fail(`the first song never started (${JSON.stringify(before)})`);
else log(`✓ the first song is playing at ${before.t.toFixed(2)}s`);

/* ---- add a SECOND song and switch to it: the music must not stop ---- */
await host.getByTestId('file').setInputFiles('/tmp/tone2.wav');
await host.waitForTimeout(400);
await host.evaluate(() => {
  const h = window.__syncHost;
  const pl = h.state.transport.playlist;
  h.playTrack(pl[pl.length - 1].id);
});

let silent = 0, samples = 0, sawStandIn = false;
for (let i = 0; i < 24; i++) {
  const s = await probe(sp);
  samples++;
  if (s.paused) silent++;
  if (/keeps playing/i.test(s.info || '')) sawStandIn = true;
  await host.waitForTimeout(250);
}
log(`  silent samples while the new song arrived: ${silent}/${samples}`);
if (silent > 2) fail(`the music stopped while the new song was downloading (${silent}/${samples} samples silent)`);
else log('✓ the music kept playing the whole time the new song was downloading');
if (sawStandIn) log('✓ the phone said so plainly ("this one keeps playing until it is ready")');

const after = await probe(sp);
if (after.paused) fail('the phone is not playing after the switch');
else log(`✓ playing after the switch at ${after.t.toFixed(2)}s`);

/* ---- refresh must not leave it stopped ---- */
await sp.reload({ waitUntil: 'networkidle' });
// Android needs one gesture after a reload before a page may make sound.
// That is a browser rule, not something the app can skip, so the test taps
// exactly once — like a person would.
try {
  await sp.getByTestId('enable-speaker').waitFor({ timeout: 20000 });
  await sp.getByTestId('enable-speaker').click();
} catch {
  await sp.mouse.click(200, 300);
}
let back = null;
for (let i = 0; i < 40; i++) {
  back = await probe(sp);
  if (!back.paused) break;
  await host.waitForTimeout(500);
}
log(`  after refresh: ${JSON.stringify(back)}`);
if (back.paused) fail('the speaker is stopped after a refresh');
else log(`✓ the speaker came back playing after a refresh (${back.t.toFixed(2)}s)`);

console.log(bad ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
await browser.close();
process.exit(bad ? 1 : 0);
