/**
 * Does the SONG actually go through the mixer?
 *
 * tools/mixer-yt-e2e.mjs only ever proved that the channel strip itself works:
 * it injects an oscillator into `mixer.input` and measures `mixer.output`. That
 * passes even when the song reaches the loudspeaker around the strip, which is
 * exactly the state a real phone ends up in — and why every slider felt dead
 * while the test said 22.2 dB.
 *
 * This test plays a real track from a real host and measures the level AT THE
 * STRIP'S OUTPUT. If the song is routed through the mixer there is signal
 * there; if it bypasses the mixer the strip's output is silence. Then it pulls
 * the channel gain to zero and insists the level collapses — proof that the
 * mixer is in command of what the phone emits.
 *
 * Usage: node tools/mixer-real-e2e.mjs [url]
 */
import { chromium } from 'playwright';

const APP = process.argv[2] || 'http://localhost:9090/';
let bad = 0;
const ok = (m) => console.log(`✓ ${m}`);
const fail = (m) => { bad++; console.log(`✗ ${m}`); };

// NOTE: deliberately no --autoplay-policy override. We want the phone's real
// starting condition: a suspended AudioContext that only resumes on a tap.
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
await host.locator('input[type=file]').setInputFiles('/tmp/tone.wav');
await host.waitForTimeout(2500);

const spk = await page();
await spk.goto(`${APP}#/speaker?mode=direct`, { waitUntil: 'networkidle' });
await spk.waitForTimeout(1200);
// a REAL click, the way a person enables the speaker
if (await spk.getByTestId('enable-speaker').count()) await spk.getByTestId('enable-speaker').click();
else await spk.locator('body').click();

await host.waitForFunction(() => (window.__syncHost?.state?.speakers?.length ?? 0) > 0, null, { timeout: 40000 });
await host.getByTestId('play-track-0').click();

// wait until this phone is really making sound
let started = false;
for (let i = 0; i < 40; i++) {
  const s = await spk.evaluate(() => {
    const wa = window.__syncWA;
    const a = window.__syncAudio;
    return { wa: wa ? !wa.paused : false, el: a ? !a.paused && a.currentTime > 0.05 : false };
  });
  if (s.wa || s.el) { started = true; break; }
  await spk.waitForTimeout(500);
}
if (!started) fail('the phone never started playing — cannot judge the mixer');
else ok('the phone is playing the song');

await spk.waitForTimeout(1500);

/** peak level, in dBFS, measured at the OUTPUT of the music channel strip */
const levelAtStrip = async () => spk.evaluate(async () => {
  const wa = window.__syncWA;
  if (!wa) return { err: 'no WebAudioPlayer' };
  const ctx = wa.ctx;
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  wa.mixer.output.connect(an);
  await new Promise((r) => setTimeout(r, 700));
  const d = new Float32Array(an.fftSize);
  let peak = 0;
  // sample a few times, the tone is steady but the graph may be mid-ramp
  for (let i = 0; i < 6; i++) {
    an.getFloatTimeDomainData(d);
    for (let j = 0; j < d.length; j++) peak = Math.max(peak, Math.abs(d[j]));
    await new Promise((r) => setTimeout(r, 80));
  }
  try { wa.mixer.output.disconnect(an); } catch {}
  return { db: peak > 0 ? 20 * Math.log10(peak) : -120, ctx: ctx.state };
});

const live = await levelAtStrip();
if (live.err) fail(live.err);
else {
  console.log(`  level at the strip's output while the song plays: ${live.db.toFixed(1)} dBFS (context ${live.ctx})`);
  if (live.db > -60) ok('the song really is routed THROUGH the mixer');
  else fail(`the song is bypassing the mixer — the strip sees ${live.db.toFixed(1)} dBFS while the phone plays`);
}

// and the strip must be able to shut the song up
await spk.evaluate(() => window.__syncClient.setMix('music', { gain: 0, bass: 0, mid: 0, treble: 0, echo: 0 }));
await spk.waitForTimeout(600);
const muted = await levelAtStrip();
if (!muted.err) {
  console.log(`  level with the channel gain at 0: ${muted.db.toFixed(1)} dBFS`);
  if (live.db - muted.db > 20) ok(`the mixer commands the sound (${(live.db - muted.db).toFixed(1)} dB of control)`);
  else fail(`pulling the gain to zero changed the output by only ${(live.db - muted.db).toFixed(1)} dB`);
}

await spk.evaluate(() => window.__syncClient.setMix('music', { gain: 1 }));
await spk.waitForTimeout(400);

/* -------- the host's desk must reach the speaker, not just its own ears --- */
{
  const before = await levelAtStrip();
  await host.evaluate(() => window.__syncHost.setRoomMix('music', { gain: 0 }));
  await spk.waitForTimeout(1200);
  const after = await levelAtStrip();
  console.log(`  speaker level: ${before.db.toFixed(1)} dBFS -> ${after.db.toFixed(1)} dBFS after the HOST pulled the room gain down`);
  if (before.db - after.db > 20) ok(`the host's mixer really controls the speakers (${(before.db - after.db).toFixed(1)} dB)`);
  else fail(`the host moved the room mixer and the speaker barely changed (${(before.db - after.db).toFixed(1)} dB)`);

  await host.evaluate(() => window.__syncHost.setRoomMix('music', { gain: 1 }));
  await spk.waitForTimeout(1000);
  const back = await levelAtStrip();
  if (back.db > -60) ok('and brings it back up again');
  else fail(`the speaker stayed quiet after the host restored the gain (${back.db.toFixed(1)} dBFS)`);

  // a phone that joins later must inherit the room's sound
  await host.evaluate(() => window.__syncHost.setRoomMix('music', { bass: 9 }));
  const late = await page();
  await late.goto(`${APP}#/speaker?mode=direct`, { waitUntil: 'networkidle' });
  await late.waitForTimeout(1200);
  if (await late.getByTestId('enable-speaker').count()) await late.getByTestId('enable-speaker').click();
  else await late.locator('body').click();
  let inherited = null;
  for (let i = 0; i < 30; i++) {
    inherited = await late.evaluate(() => window.__syncClient?.mixOf('music')?.bass ?? null);
    if (inherited === 9) break;
    await late.waitForTimeout(500);
  }
  if (inherited === 9) ok('a phone joining later inherits the room sound');
  else fail(`a late joiner did not get the room's bass setting (got ${inherited})`);
  await host.evaluate(() => window.__syncHost.setRoomMix('music', { bass: 0 }));
}

await b.close();
console.log(bad ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
process.exit(bad ? 1 : 0);
