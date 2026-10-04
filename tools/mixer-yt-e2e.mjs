/**
 * The mixer must really change the sound, and YouTube must really play on
 * every phone at the same second.
 *
 * The mixer check is deliberately not "did the slider move": it measures the
 * actual output of the audio graph with an analyser, with bass up and bass
 * down, and insists the low end really changed.
 */
import { chromium } from 'playwright';

const APP = process.argv[2] || 'http://localhost:9090/';
let bad = 0;
const ok = (m) => console.log(`✓ ${m}`);
const fail = (m) => { bad++; console.log(`✗ ${m}`); };

const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = async () => (await b.newContext()).newPage();

/* ---------------------------------------------------- 1. the mixer works */
{
  const p = await page();
  await p.goto(`${APP}#/speaker?mode=direct`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  // the page shows either an explicit button or a tap-anywhere overlay
  await p.locator('body').click();
  if (await p.getByTestId('enable-speaker').count()) await p.getByTestId('enable-speaker').click();
  await p.waitForFunction(() => !!window.__syncWA, null, { timeout: 30000 });
  await p.waitForTimeout(800);

  // feed a known 80 Hz tone through the music channel strip and measure it
  const measure = async (bass) => p.evaluate(async (bassDb) => {
    const c = window.__syncClient;
    c.setMix('music', { bass: bassDb, mid: 0, treble: 0, gain: 1, echo: 0, limiter: false });
    const wa = window.__syncWA;
    const ctx = wa.ctx;
    const osc = ctx.createOscillator();
    osc.frequency.value = 80;
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    // in through the strip's input, measured at the strip's output
    osc.connect(wa.mixer.input);
    wa.mixer.output.connect(an);
    osc.start();
    await new Promise((r) => setTimeout(r, 600));
    const data = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(data);
    const bin = Math.round(80 / (ctx.sampleRate / an.fftSize));
    const level = data[bin];
    osc.stop();
    osc.disconnect();
    try { wa.mixer.output.disconnect(an); } catch {}
    return level;
  }, bass);

  const lo = await measure(-12);
  const hi = await measure(+12);
  console.log(`  80 Hz through the strip: bass −12 dB → ${lo.toFixed(1)} dBFS, bass +12 dB → ${hi.toFixed(1)} dBFS`);
  if (hi - lo > 10) ok(`the bass control really moves the low end (${(hi - lo).toFixed(1)} dB)`);
  else fail(`the bass control changed the sound by only ${(hi - lo).toFixed(1)} dB`);

  // settings must survive a reload — they are per phone
  await p.evaluate(() => window.__syncClient.setMix('music', { bass: 6 }));
  await p.reload({ waitUntil: 'networkidle' });
  const kept = await p.evaluate(() => JSON.parse(localStorage.getItem('sync-music.mixer.music') || '{}').bass);
  if (kept === 6) ok('the mixer is remembered on this phone');
  else fail(`the mixer was not remembered (bass=${kept})`);
  await p.close();
}

/* --------------------------------------------- 2. YouTube on every phone */
{
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

  const sps = [];
  for (let i = 0; i < 2; i++) {
    const p = await page();
    await p.goto(`${APP}#/speaker?mode=direct`, { waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);
    await p.locator('body').click();
    if (await p.getByTestId('enable-speaker').count()) await p.getByTestId('enable-speaker').click();
    sps.push(p);
  }
  await host.waitForTimeout(5000);

  // the YouTube API demo video, which allows embedding
  await host.getByTestId('yt-url').fill('https://www.youtube.com/watch?v=M7lc1UVf-VE');
  await host.getByTestId('yt-play').click();
  await host.waitForTimeout(12000);

  const pos = await Promise.all(sps.map((p) => p.evaluate(() => ({
    id: window.__syncClient?.state.youtubeId ?? null,
    t: (() => { try { return window.__syncClient.yt?.position?.() ?? -1; } catch { return -1; } })(),
    hasYt: !!window.__syncClient?.yt,
    state: (() => { try { return window.__syncClient.yt ? window.__syncClient.yt.isPlaying() : null; } catch { return 'throw'; } })(),
    iframe: !!document.querySelector('#yt-host, iframe[src*=youtube]'),
    err: window.__syncClient?.state.error ?? null,
  }))));
  pos.forEach((s, i) => console.log(`  speaker ${i + 1}: video=${s.id} at ${s.t}s playing=${s.state} yt=${s.hasYt} iframe=${s.iframe} ${s.err ? `(${s.err})` : ''}`));

  if (pos.every((s) => s.id)) ok('every phone was put on the same video');
  else fail('a phone was not given the video');

  const times = pos.map((s) => s.t).filter((t) => t > 0);
  if (times.length === sps.length) {
    const spread = (Math.max(...times) - Math.min(...times)) * 1000;
    console.log(`  spread between phones: ${spread.toFixed(0)} ms`);
    if (spread < 1500) ok(`the phones are within ${spread.toFixed(0)} ms on YouTube`);
    else fail(`the phones are ${spread.toFixed(0)} ms apart on YouTube`);
  } else {
    fail('a phone never started playing the video');
  }
  await host.close();
}

console.log(bad ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
await b.close();
process.exit(bad ? 1 : 0);
