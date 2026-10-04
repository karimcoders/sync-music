/**
 * Checks the two new features that need a microphone: the host's live mic
 * reaching a speaker, and the Sound Check page producing real numbers.
 * Chromium is given a fake mic so this runs unattended.
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
const APP = process.argv[2] || 'http://localhost:9090/';
let bad = false;
const log = (m) => console.log(m);
const fail = (m) => { bad = true; console.log(`✗ ${m}`); };

const browser = await chromium.launch({
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
         '--autoplay-policy=no-user-gesture-required'],
});
const page = async () => {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  return ctx.newPage();
};

/* ---------------------------- sound check page --------------------------- */
const tools = await page();
await tools.goto(`${APP}#/sound`, { waitUntil: 'networkidle' });
await tools.getByTestId('mic-start').click();
// Chromium's fake microphone emits a short beep once per second, so judge the
// peak hold rather than one instantaneous reading.
await tools.waitForTimeout(6000);
const lvl = parseFloat(await tools.getByTestId('level').innerText());
const pk = parseFloat(await tools.getByTestId('peak').innerText());
log(`  sound check: level ${lvl} dBFS, peak ${pk} dBFS`);
if (!Number.isFinite(lvl) || !Number.isFinite(pk)) fail('the sound check page produced no reading');
else if (pk <= -100) fail('the sound check page read nothing from the microphone');
else log('✓ sound check measures a real microphone signal');
const bars = await tools.locator('.spectrum .spec-col').count();
if (bars < 10) fail(`the spectrum shows ${bars} bands`); else log(`✓ spectrum renders ${bars} octave bands`);

/* ------------------------------- live mic -------------------------------- */
const host = await page();
await host.goto(`${APP}#/host?mode=direct`, { waitUntil: 'networkidle' });
await signIn(host);
await host.getByTestId('create-session').click();
await host.getByTestId('playlist').waitFor({ timeout: 90000 });

const sp = await page();
await sp.goto(`${APP}#/speaker?mode=direct`, { waitUntil: 'networkidle' });
await sp.getByTestId('enable-speaker').click({ timeout: 60000 });
for (let i = 0; i < 25; i++) {
  if ((await host.getByTestId('speaker-count').innerText()).trim() === '1') break;
  await host.waitForTimeout(1000);
}
log('✓ one speaker connected');

await host.getByTestId('mic').click();
await host.waitForTimeout(6000);
const micState = await sp.evaluate(() => {
  const c = window.__syncClient;
  const a = c?.micAudio;
  const s = a?.srcObject;
  return { have: !!s, live: !!s && s.getAudioTracks().some((t) => t.readyState === 'live'), paused: a?.paused };
});
log(`  speaker mic stream: ${JSON.stringify(micState)}`);
const banner = await sp.getByTestId('host-mic').count();
if (!banner) fail('the speaker does not show that the host is live');
else log('✓ the speaker shows a "Host is speaking" banner');
if (!micState.have) fail('the host microphone never reached the speaker');
else if (!micState.live) fail('the speaker received a microphone track that is not live');
else log('✓ the host microphone is live on the speaker');

await host.getByTestId('mic').click();
await host.waitForTimeout(2500);
const after = await sp.evaluate(() => !!window.__syncClient?.micAudio?.srcObject);
if (after) fail('turning the microphone off left the stream running');
else log('✓ turning the microphone off stops it on the speaker');

await browser.close();
console.log(bad ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
process.exit(bad ? 1 : 0);
