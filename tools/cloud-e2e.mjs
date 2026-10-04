/**
 * Does the cloud shortcut actually make a song arrive faster?
 *   node tools/cloud-e2e.mjs <app-url> <github-token>
 * Uploads one song on the host with cloud delivery ON and measures how long
 * each phone takes from "song added" to "I hold this song".
 */
import { chromium } from 'playwright';
const APP = process.argv[2] ?? 'http://localhost:9090/';
const TOKEN = process.argv[3];
const FILE = '/tmp/tone.wav';
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
host.on('pageerror', (e) => console.log('  host error:', e.message));
await host.goto(`${APP}#/host?mode=direct`, { waitUntil: 'networkidle' });
await signIn(host);
await host.getByTestId('create-session').click();
await host.getByTestId('playlist').waitFor({ timeout: 90000 });
const link = await host.getByTestId('speaker-link').getAttribute('href');

if (TOKEN) {
  await host.getByTestId('cloud-toggle').click();
  await host.getByTestId('cloud-token').fill(TOKEN);
  await host.getByTestId('cloud-save').click();
  log('✓ cloud delivery switched on');
} else log('  (no token given — measuring the phone-to-phone path)');

const speakers = [];
for (let i = 0; i < 3; i++) {
  const p = await page();
  p.on('pageerror', (e) => console.log(`  speaker ${i + 1} error:`, e.message));
  await p.goto(`${link}?mode=direct`, { waitUntil: 'networkidle' });
  await p.getByTestId('enable-speaker').click({ timeout: 30000 });
  speakers.push(p);
}
log(`✓ ${speakers.length} speakers connected`);

const t0 = Date.now();
await host.getByTestId('file').setInputFiles(FILE);
const times = new Array(speakers.length).fill(null);
for (let k = 0; k < 120 && times.some((t) => t === null); k++) {
  await Promise.all(speakers.map(async (p, i) => {
    if (times[i] !== null) return;
    const ok = await p.evaluate(() => {
      const s = window.__syncClient?.state;
      return !!s && s.bufferedPct === 100 && !!s.trackTitle && s.trackTitle !== '—';
    }).catch(() => false);
    if (ok) times[i] = Date.now() - t0;
  }));
  await host.waitForTimeout(250);
}
times.forEach((t, i) => log(`  speaker ${i + 1}: song in hand after ${t === null ? 'NEVER' : t + ' ms'}`));
if (times.some((t) => t === null)) fail('a phone never received the song');
else {
  const worst = Math.max(...times);
  log(`${worst < 15000 ? '✓' : '✗'} slowest phone: ${worst} ms`);
  if (worst >= 15000) bad++;
}
console.log(bad ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
await browser.close();
process.exit(bad ? 1 : 0);
