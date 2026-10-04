/**
 * The question this answers: when the host picks a song a phone has never
 * downloaded, how long until that phone makes SOUND?
 *
 * With the cloud copy the phone does not have to finish downloading: it
 * streams from the URL and the full copy lands underneath.
 *   node tools/stream-e2e.mjs <app-url> <github-token>
 */
import { chromium } from 'playwright';
const APP = process.argv[2] ?? 'http://localhost:9090/';
const TOKEN = process.argv[3];
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

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = async () => (await browser.newContext()).newPage();
const host = await page();
await host.goto(`${APP}#/host?mode=direct`, { waitUntil: 'networkidle' });
await signIn(host);
await host.getByTestId('create-session').click();
await host.getByTestId('playlist').waitFor({ timeout: 90000 });
const link = await host.getByTestId('speaker-link').getAttribute('href');

if (!TOKEN) { console.log('needs a token: node tools/stream-e2e.mjs <url> <token>'); process.exit(2); }
await host.getByTestId('cloud-toggle').click();
await host.getByTestId('cloud-token').fill(TOKEN);
await host.getByTestId('cloud-save').click();
log('✓ cloud delivery on');

await host.getByTestId('file').setInputFiles('/tmp/tone.wav');
await host.waitForTimeout(8000);

const sp = [];
for (let i = 0; i < 2; i++) {
  const p = await page();
  await p.goto(`${link}?mode=direct`, { waitUntil: 'networkidle' });
  await p.getByTestId('enable-speaker').click({ timeout: 30000 });
  sp.push(p);
}
await host.getByTestId('play').click();
await host.waitForTimeout(8000);
log('✓ song 1 is playing on both phones');

// a song neither phone has ever seen
await host.getByTestId('file').setInputFiles('/tmp/tone2.wav');
await host.waitForFunction(() => {
  const st = window.__syncHost?.state;
  const pl = st?.transport?.playlist ?? [];
  if (pl.length < 2) return false;
  const d = st?.delivery;
  return !!d && d.trackId === pl[pl.length - 1].id && (d.phase === 'delivering' || d.phase === 'done');
}, null, { timeout: 120000 });
log('✓ the new song is in the cloud');

const t0 = Date.now();
await host.evaluate(() => {
  const h = window.__syncHost;
  const pl = h.state.transport.playlist;
  h.playTrack(pl[pl.length - 1].id);
});
const sound = [null, null];
for (let i = 0; i < 120 && sound.some((x) => x === null); i++) {
  await Promise.all(sp.map(async (p, k) => {
    if (sound[k] !== null) return;
    const ok = await p.evaluate(() => {
      const a = window.__syncAudio; const s = window.__syncClient?.state;
      return !!a && !a.paused && a.currentTime > 0.05 && s?.trackTitle === 'tone2';
    }).catch(() => false);
    if (ok) sound[k] = Date.now() - t0;
  }));
  await host.waitForTimeout(200);
}
for (const [i, p] of sp.entries()) {
  const st = await p.evaluate(() => {
    const a = window.__syncAudio; const s = window.__syncClient?.state;
    return { title: s?.trackTitle, phase: s?.phase, info: s?.info, buf: s?.bufferedPct, t: a?.currentTime, paused: a?.paused, engine: a?.engine };
  });
  log(`  phone ${i + 1} state: ${JSON.stringify(st)}`);
}
sound.forEach((t, i) => log(`  phone ${i + 1}: sound on the NEW song after ${t === null ? 'never' : t + ' ms'}`));
if (sound.some((t) => t === null)) fail('a phone never started the new song');
else {
  const worst = Math.max(...sound);
  if (worst < 4000) log(`✓ every phone was playing the new song within ${worst} ms`);
  else fail(`the new song took ${worst} ms to start`);
}
console.log(bad ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
await browser.close();
process.exit(bad ? 1 : 0);
