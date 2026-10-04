/**
 * Changing the song must change it EVERYWHERE, at once.
 *
 * The bug this exists for: every transport message names its track, but the
 * speaker ignored that name — so a phone that had not received the new song
 * kept playing the old one at the new position. Two phones, two songs.
 *
 * Usage: node tools/switch-e2e.mjs [url] [speakers]
 */
import { chromium } from 'playwright';

const APP = process.argv[2] || 'http://localhost:9090/';
const N = Number(process.argv[3] || 2);
let bad = 0;
const ok = (m) => console.log(`✓ ${m}`);
const fail = (m) => { bad++; console.log(`✗ ${m}`); };

const b = await chromium.launch();
const page = async () => (await b.newContext()).newPage();

const host = await page();
await host.goto(`${APP}#/host?mode=direct`, { waitUntil: 'networkidle' });
if (await host.getByTestId('host-signin').count()) {
  await host.getByTestId('host-id').fill('admin');
  await host.getByTestId('host-pw').fill('syncmusic');
  await host.getByTestId('host-signin').click();
  await host.waitForFunction(() => !!document.querySelector('[data-testid=save-pw],[data-testid=create-session]'), null, { timeout: 30000 });
  if (await host.getByTestId('save-pw').count()) {
    await host.getByTestId('new-pw').fill('syncmusic');
    await host.getByTestId('new-pw2').fill('syncmusic');
    await host.getByTestId('save-pw').click();
  }
}
await host.getByTestId('create-session').click();
await host.waitForTimeout(1500);

// two different songs, so "which one is playing" is answerable
await host.locator('input[type=file]').setInputFiles('/tmp/tone.wav');
await host.waitForTimeout(2500);
await host.locator('input[type=file]').setInputFiles('/tmp/tone2.wav');
await host.waitForTimeout(2500);

const speakers = [];
for (let i = 0; i < N; i++) {
  const p = await page();
  await p.goto(`${APP}#/speaker?mode=direct`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  await p.locator('body').click();
  speakers.push(p);
}
await host.waitForTimeout(6000);

const title = (p) => p.evaluate(() => window.__syncClient?.state?.trackTitle ?? null);
const playing = (p) => p.evaluate(() => ({
  t: window.__syncAudio?.currentTime ?? 0,
  paused: window.__syncAudio ? window.__syncAudio.paused : true,
}));

await host.getByTestId('play-track-0').click();
await host.waitForTimeout(4000);
const first = await Promise.all(speakers.map(title));
console.log(`  song 1 on the phones: ${first.join(' | ')}`);
if (first.some((t) => t !== first[0] || !t)) fail('phones disagree about the first song');
else ok(`every phone is on the same song: ${first[0]}`);

// now switch, and watch how long the phones take to follow
const t0 = Date.now();
await host.getByTestId('play-track-1').click();
const wantTitle = await host.getByTestId('now-title').innerText();
let switched = 0;
for (let i = 0; i < 40; i++) {
  const now = await Promise.all(speakers.map(title));
  if (now.every((t) => t === wantTitle)) { switched = Date.now() - t0; break; }
  await host.waitForTimeout(250);
}
const after = await Promise.all(speakers.map(title));
console.log(`  host switched to: ${wantTitle}`);
console.log(`  phones now report: ${after.join(' | ')}`);
if (!switched) fail(`a phone is still on the old song after 10 s: ${after.join(' | ')}`);
else ok(`every phone followed the switch in ${switched} ms`);

await host.waitForTimeout(2500);
const states = await Promise.all(speakers.map(playing));
states.forEach((s, i) => console.log(`  speaker ${i + 1}: ${s.paused ? 'silent' : 'playing'} at ${s.t.toFixed(2)}s`));
if (states.some((s) => s.paused)) fail('a phone went silent instead of playing the new song');
else ok('every phone is playing the new song');
const spread = (Math.max(...states.map((s) => s.t)) - Math.min(...states.map((s) => s.t))) * 1000;
console.log(`  spread on the new song: ${spread.toFixed(1)} ms`);
if (spread > 250) fail(`the new song is not in sync: ${spread.toFixed(0)} ms apart`);
else ok(`the new song is in sync: ${spread.toFixed(0)} ms apart`);

// The stuck case from a real phone: the host believes it already sent the
// file (its bookkeeping says so) but the phone does not have it. The phone
// asks with TRACK_WANT; if the host trusts its bookkeeping and stays quiet,
// the phone sits on "Switching to the new song" forever.
{
  await host.getByTestId('play-track-0').click();
  await host.waitForTimeout(3000);

  // make the phones forget song 2 AND make the host believe they have it
  const gone = await host.evaluate(() => {
    const h = window.__syncHost;
    const ids = h.transport.playlist.map((t) => t.id);
    const second = ids[1];
    h.conns.forEach((c) => c.sent.add(second));
    return second;
  });
  await Promise.all(speakers.map((p) => p.evaluate(async (id) => {
    await new Promise((res) => {
      const r = indexedDB.open('sync-music-speaker');
      r.onsuccess = () => {
        const db = r.result;
        const tx = db.transaction('tracks', 'readwrite');
        tx.objectStore('tracks').delete(id);
        tx.oncomplete = () => res();
        tx.onerror = () => res();
      };
      r.onerror = () => res();
    });
    window.__syncClient.haveTrack = null;
  }, gone)));

  const t1 = Date.now();
  await host.getByTestId('play-track-1').click();
  const want = await host.getByTestId('now-title').innerText();
  let got = 0;
  for (let i = 0; i < 60; i++) {
    const now = await Promise.all(speakers.map(title));
    if (now.every((t) => t === want)) { got = Date.now() - t1; break; }
    await host.waitForTimeout(250);
  }
  if (!got) fail('a phone stayed stuck on "Switching to the new song" — the host refused to resend');
  else ok(`a phone that lost the file got it anyway, in ${got} ms`);
}

console.log(bad ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
await b.close();
process.exit(bad ? 1 : 0);
