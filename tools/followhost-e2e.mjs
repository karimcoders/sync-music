/**
 * Whose mixer wins on a speaker phone?
 *
 * Default: the host is the sound engineer and every phone follows it. But a
 * phone with a tinny speaker, or standing in a boomy corner, needs its own
 * curve — and before this, the host's next slider move silently wiped it out.
 *
 * Checks, all against the real running speaker:
 *  1. by default a host move lands on the phone;
 *  2. a phone that moves a slider by hand stops following, and the host's
 *     next move does NOT overwrite it;
 *  3. switching back to "Following host" catches up to the room's current mix
 *     (not the mix from whenever it stopped following);
 *  4. the choice survives a reload;
 *  5. the auto-update reload gives up after two tries instead of looping.
 *
 * Usage: node tools/followhost-e2e.mjs [url]
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
const ctx = await b.newContext();

const host = await ctx.newPage();
await host.goto(`${APP}#/host?mode=direct`, { waitUntil: 'networkidle' });
await signIn(host);
await host.getByTestId('create-session').click();
await host.getByTestId('playlist').waitFor({ timeout: 90000 });
const link = await host.getByTestId('speaker-link').getAttribute('href');

const sp = await (await b.newContext()).newPage();
await sp.goto(`${link}?mode=direct`, { waitUntil: 'networkidle' });
await sp.getByTestId('enable-speaker').click({ timeout: 30000 });
await host.waitForFunction(() => (window.__syncHost?.state?.speakers ?? []).length > 0, null, { timeout: 90000 });

const hostSet = (patch) => host.evaluate((p) => window.__syncHost.setRoomMix('music', p), patch);
const phoneBass = () => sp.evaluate(() => window.__syncClient.mixOf('music').bass);
const follows = () => sp.evaluate(() => window.__syncClient.followsHost);
const settle = (ms = 1200) => sp.waitForTimeout(ms);

/* ------------------------------ 1. the default is to follow the host ----- */
await hostSet({ bass: 4 });
await settle();
let v = await phoneBass();
if (v === 4 && (await follows())) ok(`by default the host's move lands on the phone (bass ${v})`);
else fail(`the host's move did not reach the phone (bass ${v}, following=${await follows()})`);

/* ----------------- 2. a hand-moved slider on the phone wins from then on - */
await sp.evaluate(() => (location.hash = '#/mixer'));
await sp.waitForTimeout(800);
await sp.evaluate(() => {
  // exactly what dragging the on-screen Bass knob does
  const c = window.__syncClient;
  if (c.followsHost) c.setFollowHost(false);
  c.setMix('music', { bass: -3 });
});
await settle(400);
if ((await follows()) === false) ok('moving a slider by hand switches this phone to its own mix');
else fail('the phone still claims to follow the host after a hand move');

await hostSet({ bass: 9 });
await settle();
v = await phoneBass();
if (v === -3) ok(`the host's next move did NOT overwrite the phone's own sound (still bass ${v})`);
else fail(`the host overwrote the phone's own setting (bass ${v}, expected -3)`);

await hostSet({ bass: 12 });
await settle();
v = await phoneBass();
if (v === -3) ok('and it keeps ignoring every later host move');
else fail(`the phone drifted back to the host (bass ${v})`);

/* ------------------- 3. switching back catches up to the CURRENT room mix */
await sp.evaluate(() => window.__syncClient.setFollowHost(true));
await settle(600);
v = await phoneBass();
if (v === 12) ok(`"Following host" catches up to the room's current mix (bass ${v}), not a stale one`);
else fail(`rejoining the room's sound gave bass ${v}, expected 12`);

/* -------------------------------- 4. the choice survives a reload -------- */
await sp.evaluate(() => window.__syncClient.setFollowHost(false));
await sp.waitForTimeout(300);
// back to the speaker page first: that is the screen a phone actually sits on
await sp.evaluate(() => (location.hash = '#/speaker?mode=direct'));
await sp.waitForTimeout(500);
await sp.reload({ waitUntil: 'domcontentloaded' });
await sp.waitForFunction(() => !!window.__syncClient, null, { timeout: 60000 });
if ((await follows()) === false) ok('the phone remembers it is on its own mix after a reload');
else fail('the reload put the phone back under the host without asking');
await sp.evaluate(() => window.__syncClient.setFollowHost(true));

/* -------------- 5. the auto-update must not become a reload loop --------- */
const loop = await sp.evaluate(async () => {
  // Pretend two auto-update reloads have already happened in this tab and the
  // host is STILL newer — a CDN that has not caught up. A third reload would
  // be the start of an endless loop.
  sessionStorage.setItem('sync-music.autoupdate', '2');
  let reloaded = false;
  const orig = location.reload.bind(location);
  try { Object.defineProperty(location, 'reload', { value: () => { reloaded = true; }, configurable: true }); } catch {}
  const stale = () => window.__syncClient.set({ sessionId: 'syncmusic-main', hostBuild: '2999-01-01 00:00' });
  // The live host keeps announcing that it is the SAME build, which clears
  // the flag again, so hold it down for the whole window.
  const iv = setInterval(stale, 200);
  stale();
  await new Promise((r) => setTimeout(r, 1200));
  const card = document.body.innerText.includes('older version');
  await new Promise((r) => setTimeout(r, 4000));
  clearInterval(iv);
  try { Object.defineProperty(location, 'reload', { value: orig, configurable: true }); } catch {}
  return { reloaded, card };
});
if (!loop.reloaded) ok('after two failed auto-updates it stops reloading instead of looping forever');
else fail('the phone would reload itself endlessly when an update never arrives');
if (loop.card) ok('the manual UPDATE NOW notice is still on screen');
else fail('it gave up quietly, leaving the user no way to update');

await b.close();
console.log(bad ? `\nSOME CHECKS FAILED (${bad})` : '\nALL CHECKS PASSED');
process.exit(bad ? 1 : 0);
