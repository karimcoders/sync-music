/**
 * Every control on the advanced desk must actually change the sound.
 *
 * Not "does the slider move" and not "is the node there": each check feeds a
 * known signal into the strip and measures the strip's own output with an
 * analyser, then insists the measurement moved in the right direction by a
 * real amount. A control that measures flat is a lie and fails here.
 *
 * Usage: node tools/mixerpro-e2e.mjs [url]
 */
import { chromium } from 'playwright';

const APP = process.argv[2] || 'http://localhost:9090/';
let bad = 0;
const ok = (m) => console.log(`✓ ${m}`);
const fail = (m) => { bad++; console.log(`✗ ${m}`); };

const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await (await b.newContext()).newPage();
await p.goto(`${APP}#/speaker?mode=direct`, { waitUntil: 'networkidle' });
await p.waitForFunction(() => !!window.__syncClient, null, { timeout: 30000 });
await p.evaluate(() => window.__syncClient.enableSpeaker());
await p.waitForFunction(() => !!window.__syncWA, null, { timeout: 30000 });
await p.waitForTimeout(600);

/**
 * Level of a steady sine at `freq`, measured at the strip's output, with the
 * given settings applied. Returns dBFS in that FFT bin.
 */
const atFreq = (freq, settings) => p.evaluate(async ({ freq, settings }) => {
  const wa = window.__syncWA;
  const ctx = wa.ctx;
  wa.mixer.apply(settings);
  const osc = ctx.createOscillator();
  osc.frequency.value = freq;
  const an = ctx.createAnalyser();
  an.fftSize = 8192;
  osc.connect(wa.mixer.input);
  wa.mixer.output.connect(an);
  osc.start();
  await new Promise((r) => setTimeout(r, 500));
  const d = new Float32Array(an.frequencyBinCount);
  an.getFloatFrequencyData(d);
  const bin = Math.round(freq / (ctx.sampleRate / an.fftSize));
  let best = -200;
  for (let i = Math.max(0, bin - 2); i <= bin + 2; i++) best = Math.max(best, d[i]);
  osc.stop(); osc.disconnect();
  try { wa.mixer.output.disconnect(an); } catch {}
  return best;
}, { freq, settings });

const FLATISH = {
  bass: 0, mid: 0, treble: 0, b2g: 0, b4g: 0, b5g: 0, hpf: 20, lpf: 20000,
  drive: 0, compOn: false, makeup: 0, echo: 0, echoFeedback: 0, reverb: 0, width: 1, pan: 0,
  gain: 1, limiter: false,
};

/* --------------------------------------------------- 1. the six EQ bands */
const bands = [
  ['bass (low shelf)', 'bass', 60],
  ['band 2 (low-mid)', 'b2g', 400],
  ['mid', 'mid', 1200],
  ['band 4 (high-mid)', 'b4g', 2800],
  ['band 5 (presence)', 'b5g', 6000],
  ['treble (high shelf)', 'treble', 9000],
];
for (const [label, key, f] of bands) {
  const lo = await atFreq(f, { ...FLATISH, [key]: -12 });
  const hi = await atFreq(f, { ...FLATISH, [key]: +12 });
  const d = hi - lo;
  console.log(`  ${label} at ${f} Hz: ${lo.toFixed(1)} → ${hi.toFixed(1)} dBFS`);
  if (d > 12) ok(`${label} really moves its own frequency (${d.toFixed(1)} dB)`);
  else fail(`${label} only changed ${d.toFixed(1)} dB`);
}

/* ------------------------------------------- 2. bands are independent */
{
  const ref = await atFreq(6000, FLATISH);
  const withBass = await atFreq(6000, { ...FLATISH, bass: 12 });
  const d = Math.abs(withBass - ref);
  if (d < 3) ok(`the bass control leaves 6 kHz alone (${d.toFixed(1)} dB)`);
  else fail(`boosting bass changed 6 kHz by ${d.toFixed(1)} dB — the bands are not independent`);
}

/* ------------------------------------------------------ 3. HPF and LPF */
{
  const open = await atFreq(60, FLATISH);
  const cut = await atFreq(60, { ...FLATISH, hpf: 400 });
  console.log(`  60 Hz with the high-pass at 400 Hz: ${open.toFixed(1)} → ${cut.toFixed(1)} dBFS`);
  if (open - cut > 20) ok(`the high-pass really removes the lows (${(open - cut).toFixed(1)} dB)`);
  else fail(`the high-pass only removed ${(open - cut).toFixed(1)} dB`);

  const openHi = await atFreq(9000, FLATISH);
  const cutHi = await atFreq(9000, { ...FLATISH, lpf: 2000 });
  if (openHi - cutHi > 20) ok(`the low-pass really removes the highs (${(openHi - cutHi).toFixed(1)} dB)`);
  else fail(`the low-pass only removed ${(openHi - cutHi).toFixed(1)} dB`);
}

/* --------------------------------------- 4. drive adds real harmonics */
{
  // A pure 300 Hz sine has no 900 Hz content until something distorts it. Both
  // readings therefore play 300 Hz and look at 900 Hz — measuring a clean
  // 900 Hz tone instead (the first version of this test) proves nothing.
  const third = (drive) => p.evaluate(async (drv) => {
    const wa = window.__syncWA; const ctx = wa.ctx;
    wa.mixer.apply({ ...window.__syncWA.mixer.values, drive: drv, driveMix: 1, limiter: false, gain: 1, echo: 0, echoFeedback: 0, reverb: 0, compOn: false });
    const osc = ctx.createOscillator(); osc.frequency.value = 300;
    const an = ctx.createAnalyser(); an.fftSize = 8192;
    osc.connect(wa.mixer.input); wa.mixer.output.connect(an); osc.start();
    await new Promise((r) => setTimeout(r, 500));
    const d = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(d);
    const bin = Math.round(900 / (ctx.sampleRate / an.fftSize));
    let best = -200; for (let i = bin - 2; i <= bin + 2; i++) best = Math.max(best, d[i]);
    osc.stop(); osc.disconnect(); try { wa.mixer.output.disconnect(an); } catch {}
    return best;
  }, drive);
  const clean = await third(0);
  const dirty = await third(80);
  console.log(`  third harmonic of a 300 Hz tone: clean ${clean.toFixed(1)} → driven ${dirty.toFixed(1)} dBFS`);
  if (dirty - clean > 15) ok(`drive really adds harmonics (${(dirty - clean).toFixed(1)} dB of third harmonic)`);
  else fail(`drive added only ${(dirty - clean).toFixed(1)} dB of harmonic content`);
}

/* ------------------------------------------- 5. the compressor compresses */
{
  const r = await p.evaluate(async () => {
    const wa = window.__syncWA; const ctx = wa.ctx;
    const measure = async (settings) => {
      wa.mixer.apply(settings);
      const osc = ctx.createOscillator(); osc.frequency.value = 220;
      const g = ctx.createGain(); g.gain.value = 0.9;          // a hot signal
      const an = ctx.createAnalyser(); an.fftSize = 2048;
      osc.connect(g).connect(wa.mixer.input); wa.mixer.output.connect(an); osc.start();
      await new Promise((r) => setTimeout(r, 700));
      const d = new Float32Array(an.fftSize);
      let peak = 0;
      for (let k = 0; k < 5; k++) {
        an.getFloatTimeDomainData(d);
        for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
        await new Promise((r) => setTimeout(r, 60));
      }
      const red = wa.mixer.reduction;
      osc.stop(); osc.disconnect(); try { wa.mixer.output.disconnect(an); } catch {}
      return { db: peak > 0 ? 20 * Math.log10(peak) : -120, red };
    };
    const off = await measure({ compOn: false, makeup: 0, limiter: false, gain: 1, drive: 0 });
    const on = await measure({ compOn: true, compThreshold: -30, compRatio: 12, compAttack: 0.003, compRelease: 0.1, makeup: 0, limiter: false });
    return { off, on };
  });
  console.log(`  hot 220 Hz tone: compressor off ${r.off.db.toFixed(1)} dBFS, on ${r.on.db.toFixed(1)} dBFS (gain reduction ${r.on.red.toFixed(1)} dB)`);
  if (r.off.db - r.on.db > 6 && r.on.red > 3) ok(`the compressor really reduces the peaks (${(r.off.db - r.on.db).toFixed(1)} dB)`);
  else fail(`the compressor changed the peak by ${(r.off.db - r.on.db).toFixed(1)} dB, reduction meter ${r.on.red.toFixed(1)} dB`);
}

/* ------------------------------------------- 6. reverb leaves a real tail */
{
  const tail = await p.evaluate(async () => {
    const wa = window.__syncWA; const ctx = wa.ctx;
    wa.mixer.apply({ reverb: 1, reverbSize: 3, reverbDamp: 0.3, echo: 0, limiter: false, gain: 1, drive: 0, compOn: false });
    const osc = ctx.createOscillator(); osc.frequency.value = 500;
    const an = ctx.createAnalyser(); an.fftSize = 2048;
    osc.connect(wa.mixer.input); wa.mixer.output.connect(an); osc.start();
    await new Promise((r) => setTimeout(r, 700));
    osc.stop(); osc.disconnect();
    // 300 ms AFTER the source stopped there must still be sound
    await new Promise((r) => setTimeout(r, 300));
    const d = new Float32Array(an.fftSize);
    let peak = 0;
    an.getFloatTimeDomainData(d);
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    try { wa.mixer.output.disconnect(an); } catch {}
    return peak > 0 ? 20 * Math.log10(peak) : -120;
  });
  console.log(`  300 ms after the tone stopped, with reverb on: ${tail.toFixed(1)} dBFS`);
  if (tail > -60) ok('the reverb leaves a real tail behind the sound');
  else fail(`nothing was left after the tone stopped (${tail.toFixed(1)} dBFS) — the reverb is not sounding`);
}

/* ---------------------------------------------- 7. echo repeats the sound */
{
  const rep = await p.evaluate(async () => {
    const wa = window.__syncWA; const ctx = wa.ctx;
    wa.mixer.apply({ reverb: 0, echo: 1, echoTime: 0.3, echoFeedback: 0.6, limiter: false, gain: 1, drive: 0, compOn: false });
    const osc = ctx.createOscillator(); osc.frequency.value = 500;
    const an = ctx.createAnalyser(); an.fftSize = 2048;
    osc.connect(wa.mixer.input); wa.mixer.output.connect(an); osc.start();
    await new Promise((r) => setTimeout(r, 400));
    osc.stop(); osc.disconnect();
    await new Promise((r) => setTimeout(r, 320));
    const d = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(d);
    let peak = 0; for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
    try { wa.mixer.output.disconnect(an); } catch {}
    return peak > 0 ? 20 * Math.log10(peak) : -120;
  });
  console.log(`  320 ms after the tone stopped, with a 300 ms echo: ${rep.toFixed(1)} dBFS`);
  if (rep > -60) ok('the echo really repeats the sound');
  else fail(`no repeat was heard (${rep.toFixed(1)} dBFS)`);
}

/* ------------------------------------------ 8. width collapses to mono */
{
  const r = await p.evaluate(async () => {
    const wa = window.__syncWA; const ctx = wa.ctx;
    // a hard-panned source: all the energy is in the side signal
    const measure = async (width) => {
      // echoFeedback 0 as well: a delay line still circulating the PREVIOUS
      // test's tone is sound that did not come from this measurement.
      wa.mixer.apply({ width, pan: 0, echo: 0, echoFeedback: 0, reverb: 0, limiter: false, gain: 1, drive: 0, compOn: false });
      await new Promise((r) => setTimeout(r, 400));
      const osc = ctx.createOscillator(); osc.frequency.value = 700;
      const pan = ctx.createStereoPanner(); pan.pan.value = -1;     // left only
      const split = ctx.createChannelSplitter(2);
      const anR = ctx.createAnalyser(); anR.fftSize = 2048;
      osc.connect(pan).connect(wa.mixer.input);
      wa.mixer.output.connect(split);
      split.connect(anR, 1);                                        // listen to RIGHT
      osc.start();
      await new Promise((r) => setTimeout(r, 500));
      const d = new Float32Array(anR.fftSize);
      let peak = 0;
      for (let k = 0; k < 4; k++) {
        anR.getFloatTimeDomainData(d);
        for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
        await new Promise((r) => setTimeout(r, 50));
      }
      osc.stop(); osc.disconnect();
      try { wa.mixer.output.disconnect(split); } catch {}
      return peak > 0 ? 20 * Math.log10(peak) : -120;
    };
    return { stereo: await measure(1), mono: await measure(0) };
  });
  console.log(`  a left-only tone, measured on the RIGHT: width 1 → ${r.stereo.toFixed(1)} dBFS, width 0 (mono) → ${r.mono.toFixed(1)} dBFS`);
  if (r.mono - r.stereo > 6) ok(`width 0 really folds the stereo image to mono (${(r.mono - r.stereo).toFixed(1)} dB more in the other channel)`);
  else fail(`collapsing to mono changed the right channel by only ${(r.mono - r.stereo).toFixed(1)} dB`);
}

/* --------------------------------------------------- 9. meters are real */
{
  const m = await p.evaluate(async () => {
    const wa = window.__syncWA; const ctx = wa.ctx;
    wa.mixer.apply({ gain: 1, limiter: false, drive: 0, compOn: false, echo: 0, echoFeedback: 0, reverb: 0 });
    await new Promise((r) => setTimeout(r, 1200));     // let any tail die first
    const silent = wa.mixer.levels();
    const osc = ctx.createOscillator(); osc.frequency.value = 440;
    const g = ctx.createGain(); g.gain.value = 0.5;
    osc.connect(g).connect(wa.mixer.input); osc.start();
    await new Promise((r) => setTimeout(r, 500));
    const loud = wa.mixer.levels();
    const spec = wa.mixer.spectrum();
    osc.stop(); osc.disconnect();
    return { silent, loud, bins: spec.length, specMax: Math.max(...spec) };
  });
  console.log(`  meters: silence ${m.silent.peak.toFixed(1)} dBFS → tone ${m.loud.peak.toFixed(1)} dBFS peak / ${m.loud.rms.toFixed(1)} RMS, spectrum ${m.bins} bins`);
  if (m.loud.peak - m.silent.peak > 20 && m.loud.peak > m.loud.rms) ok('the meters read the real signal (peak above RMS, as it must be)');
  else fail('the meters do not follow the signal');
  if (m.bins >= 512 && m.specMax > -90) ok(`the spectrum is live (${m.bins} bins)`);
  else fail('the spectrum is empty');
}

/* --------------------------------------- 10. the UI drives the real DSP */
{
  await p.goto(`${APP}#/mixer`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(800);
  const has = async (id) => (await p.getByTestId(id).count()) > 0;
  const missing = [];
  for (const id of ['spectrum', 'levels', 'sect-eq', 'sect-dyn', 'sect-space', 'sect-out']) {
    if (!(await has(id))) missing.push(id);
  }
  if (missing.length) fail(`the mixer page is missing: ${missing.join(', ')}`);
  else ok('the desk shows a spectrum, meters and all four sections');

  // move a real control through the UI and check the audio graph followed
  await p.getByTestId('sect-eq').click();
  const slider = p.getByTestId('hpf');
  if (await slider.count()) {
    await slider.fill('400');
    await p.waitForTimeout(400);
    const applied = await p.evaluate(() => window.__syncWA?.mixer?.values?.hpf ?? null);
    if (applied !== null && Math.abs(applied - 400) < 1) ok('moving the high-pass on screen really moved the filter (400 Hz)');
    else fail(`the UI said 400 Hz but the filter is at ${applied}`);
  } else fail('the high-pass control is not on the page');

  await p.getByTestId('sect-dyn').click();
  await p.waitForTimeout(200);
  if (await has('comp-threshold')) ok('the compressor section is reachable');
  else fail('the compressor section did not open');
}

await p.evaluate(() => window.__syncWA?.mixer?.apply({ ...window.__syncWA.mixer.values, gain: 1, limiter: true, hpf: 20 }));
await b.close();
console.log(bad ? '\nSOME CHECKS FAILED' : '\nALL CHECKS PASSED');
process.exit(bad ? 1 : 0);
