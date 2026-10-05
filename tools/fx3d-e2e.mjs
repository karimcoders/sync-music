/**
 * The 3D / 8D / modulation effects must actually move the sound.
 *
 * Every check feeds a steady tone into the real strip and measures the real
 * output. A movement effect is only real if the measurement MOVES: we sample
 * the output many times over two seconds and insist on a minimum swing, and
 * we insist the same measurement is nearly flat with the effect off. An
 * effect that is wired but inaudible measures flat and fails here.
 *
 * Usage: node tools/fx3d-e2e.mjs [url]
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

const FLAT = {
  bass: 0, mid: 0, treble: 0, b2g: 0, b4g: 0, b5g: 0, hpf: 20, lpf: 20000,
  drive: 0, compOn: false, makeup: 0, echo: 0, echoFeedback: 0, reverb: 0,
  width: 1, pan: 0, gain: 1, limiter: false,
  rotate: 0, haas: 0, chorus: 0, flanger: 0, phaser: 0, tremolo: 0,
};

/**
 * Play a tone for `ms` and report, per channel, how the level at `freq`
 * behaves over time: {spread} = max − min in dB of the mono reading, and
 * {sideSpread} = max − min of (left − right) in dB, which is what an 8D
 * circle moves and a plain filter does not.
 */
const watch = (freq, settings, ms = 2200) => p.evaluate(async ({ freq, settings, ms }) => {
  const wa = window.__syncWA;
  const ctx = wa.ctx;
  wa.mixer.apply(settings);
  const osc = ctx.createOscillator();
  osc.frequency.value = freq;
  const split = ctx.createChannelSplitter(2);
  const mk = () => { const a = ctx.createAnalyser(); a.fftSize = 4096; a.smoothingTimeConstant = 0; return a; };
  const aL = mk(); const aR = mk();
  split.connect(aL, 0); split.connect(aR, 1);
  osc.connect(wa.mixer.input);
  wa.mixer.output.connect(split);
  osc.start();
  await new Promise((r) => setTimeout(r, 400));

  const bin = Math.round(freq / (ctx.sampleRate / 4096));
  const read = (an) => {
    const d = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(d);
    let best = -200;
    for (let i = Math.max(0, bin - 2); i <= bin + 2; i++) best = Math.max(best, d[i]);
    return best;
  };
  const mono = []; const side = [];
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    const l = read(aL); const r = read(aR);
    if (l > -150 && r > -150) { mono.push(Math.max(l, r)); side.push(l - r); }
    await new Promise((r2) => setTimeout(r2, 40));
  }
  osc.stop(); osc.disconnect();
  try { wa.mixer.output.disconnect(split); } catch {}
  const sp = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);
  return { spread: sp(mono), sideSpread: sp(side), n: mono.length };
}, { freq, settings, ms });

/** Steady level at `freq`, one reading. */
const level = (freq, settings) => p.evaluate(async ({ freq, settings }) => {
  const wa = window.__syncWA;
  const ctx = wa.ctx;
  wa.mixer.apply(settings);
  const osc = ctx.createOscillator();
  osc.frequency.value = freq;
  const an = ctx.createAnalyser(); an.fftSize = 8192;
  osc.connect(wa.mixer.input);
  wa.mixer.output.connect(an);
  osc.start();
  await new Promise((r) => setTimeout(r, 600));
  const d = new Float32Array(an.frequencyBinCount);
  an.getFloatFrequencyData(d);
  const bin = Math.round(freq / (ctx.sampleRate / 8192));
  let best = -200;
  for (let i = Math.max(0, bin - 2); i <= bin + 2; i++) best = Math.max(best, d[i]);
  osc.stop(); osc.disconnect();
  try { wa.mixer.output.disconnect(an); } catch {}
  return best;
}, { freq, settings });

/* ------------------------------------------- 0. the strip is still honest */
const base = await watch(1000, FLAT);
console.log(`  flat: level swing ${base.spread.toFixed(1)} dB, L−R swing ${base.sideSpread.toFixed(1)} dB over ${base.n} samples`);
if (base.spread < 2 && base.sideSpread < 2) ok('with every effect off the output is steady');
else fail(`the flat strip is not steady (${base.spread.toFixed(1)} / ${base.sideSpread.toFixed(1)} dB)`);

/* ----------------------------------------------------- 1. 8D rotation */
const spin = await watch(1000, { ...FLAT, rotate: 1, rotateRate: 2 });
console.log(`  8D: L−R swing ${spin.sideSpread.toFixed(1)} dB (flat was ${base.sideSpread.toFixed(1)} dB)`);
if (spin.sideSpread > base.sideSpread + 6)
  ok(`8D really walks the sound across the head (${spin.sideSpread.toFixed(1)} dB of left-right movement)`);
else fail(`8D did not move the image (${spin.sideSpread.toFixed(1)} dB)`);

/* ------------------------------------------------- 2. 8D height is HRTF */
const up = await level(1000, { ...FLAT, rotate: 1, rotateRate: 30, rotateHeight: 1 });
const lvl = await level(1000, { ...FLAT, rotate: 1, rotateRate: 30, rotateHeight: 0 });
console.log(`  HRTF height: ${lvl.toFixed(1)} dBFS level vs ${up.toFixed(1)} dBFS overhead`);
if (Math.abs(up - lvl) > 0.5) ok('the height control changes the HRTF colouring');
else fail('the height control did nothing');

/* ------------------------------------- 3. Haas: a 1 ms side delay combs */
const dry500 = await level(500, FLAT);
const haas500 = await level(500, { ...FLAT, haas: 1 });
console.log(`  Haas 1 ms at 500 Hz (its notch): ${dry500.toFixed(1)} → ${haas500.toFixed(1)} dBFS`);
if (dry500 - haas500 > 4) ok(`Haas really delays one side (${(dry500 - haas500).toFixed(1)} dB notch where the theory says it should be)`);
else fail('Haas produced no comb notch, so it is not delaying anything');

/* -------------------------------------------------------- 4. chorus */
const cho = await watch(1000, { ...FLAT, chorus: 1, chorusRate: 2 });
console.log(`  chorus: level swing ${cho.spread.toFixed(1)} dB`);
if (cho.spread > base.spread + 3) ok(`chorus really modulates the signal (${cho.spread.toFixed(1)} dB)`);
else fail(`chorus measured flat (${cho.spread.toFixed(1)} dB)`);

/* ------------------------------------------------------- 5. flanger */
const fla = await watch(1000, { ...FLAT, flanger: 1, flangerFeedback: 0.6 });
console.log(`  flanger: level swing ${fla.spread.toFixed(1)} dB`);
if (fla.spread > base.spread + 3) ok(`the flanger sweep is real (${fla.spread.toFixed(1)} dB)`);
else fail(`the flanger measured flat (${fla.spread.toFixed(1)} dB)`);

/* -------------------------------------------------------- 6. phaser */
const pha = await watch(1000, { ...FLAT, phaser: 1, phaserRate: 2 });
console.log(`  phaser: level swing ${pha.spread.toFixed(1)} dB`);
if (pha.spread > base.spread + 3) ok(`the phaser notches really sweep (${pha.spread.toFixed(1)} dB)`);
else fail(`the phaser measured flat (${pha.spread.toFixed(1)} dB)`);

/* ------------------------------------------------------- 7. tremolo */
const tre = await watch(1000, { ...FLAT, tremolo: 1, tremoloRate: 4 });
console.log(`  tremolo: level swing ${tre.spread.toFixed(1)} dB`);
if (tre.spread > base.spread + 4) ok(`tremolo really pumps the level (${tre.spread.toFixed(1)} dB)`);
else fail(`tremolo measured flat (${tre.spread.toFixed(1)} dB)`);

/* --------------------------------------- 8. everything off is clean again */
const after = await watch(1000, FLAT);
console.log(`  back to flat: ${after.spread.toFixed(1)} / ${after.sideSpread.toFixed(1)} dB`);
if (after.spread < 2 && after.sideSpread < 2) ok('turning the effects off restores a steady, un-moving signal');
else fail('the effects left residue after being turned off');

/* ------------------------------------------- 9. the knobs exist in the UI */
await p.evaluate(() => (location.hash = '#/mixer'));
await p.waitForTimeout(800);
await p.click('[data-testid="sect-fx"]').catch(() => {});
await p.waitForTimeout(400);
for (const t of ['rotate', 'rotate-rate', 'rotate-height', 'haas', 'chorus', 'flanger', 'phaser', 'tremolo']) {
  const n = await p.locator(`[data-testid="${t}"]`).count();
  if (n > 0) ok(`the 3D / FX page has a "${t}" control`);
  else fail(`the 3D / FX page is missing "${t}"`);
}

await b.close();
console.log(bad ? `\nSOME CHECKS FAILED (${bad})` : '\nALL CHECKS PASSED');
process.exit(bad ? 1 : 0);
