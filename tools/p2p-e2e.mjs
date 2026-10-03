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
await host.getByTestId('create-session').click();
await host.getByTestId('playlist').waitFor({ timeout: 30000 });
const link = await host.locator('a[href*="h="]').first().getAttribute('href');
if (!link) fail('host did not publish a speaker link');
log(`✓ direct room open — ${link}`);

await host.getByTestId('file').setInputFiles(FILE);
await host.waitForTimeout(2500);

const speakers = [];
for (let i = 0; i < N; i++) {
  const p = await page();
  p.on('pageerror', (e) => console.log(`  speaker ${i + 1} error:`, e.message));
  await p.goto(link, { waitUntil: 'networkidle' });
  await p.getByTestId('enable-speaker').click({ timeout: 30000 });
  speakers.push(p);
  log(`✓ speaker ${i + 1} connected over WebRTC and audio enabled`);
}

await host.waitForTimeout(2000);
const count = (await host.getByTestId('speaker-count').innerText()).trim();
log(`✓ host shows Connected Speakers: ${count}`);
if (Number(count) !== N) fail(`host should see ${N} speakers, shows ${count}`);

await host.getByTestId('play').click();
log('→ PLAY sent, waiting for the scheduled start…');
await host.waitForTimeout(6000);

const probe = (p) => p.evaluate(() => {
  const a = window.__syncAudio;
  return a ? { t: a.currentTime, paused: a.paused, rate: a.playbackRate } : null;
});

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

await browser.close();
console.log(bad ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
process.exit(bad ? 1 : 0);
