/**
 * Two failures seen on a real phone, both proved here:
 *
 *  1. A transfer that is going nowhere ("Re-requesting 131 → 150 missing
 *     piece(s)…", forever, stuck at 00:00). The chase must give up and get
 *     the song another way instead of shouting into a dead channel.
 *  2. A phone running an older cached build than the host. It must update
 *     itself, not just display a notice nobody acts on.
 *
 * Usage: node tools/stalled-e2e.mjs [url]
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

/* ------------------------------------------- 1. the chase gives up in time */
const chase = await p.evaluate(async () => {
  const c = window.__syncClient;
  const seen = [];
  const un = c.subscribe((s) => seen.push(s.info));
  // A transfer that will never receive another byte: ten pieces, none of
  // them arriving, and no host on the other end to answer TRACK_NEED.
  c.incoming = { trackId: 'stall-test', title: 'stall', mime: 'audio/wav', chunks: 10, parts: [], got: 0 };
  c.lastChunkAt = 0;
  c.startChunkChase();
  await new Promise((r) => setTimeout(r, 6000));
  un?.();
  return { seen: [...new Set(seen.filter(Boolean))], incoming: !!c.incoming };
});
console.log(`  info messages seen: ${JSON.stringify(chase.seen)}`);
const gaveUp = chase.seen.some((t) => t.includes('That transfer stalled'));
if (gaveUp) ok('a dead transfer is abandoned and the song is fetched another way');
else fail('the phone kept re-requesting pieces forever — the exact bug from the screenshots');
if (!chase.incoming) ok('the stuck half-downloaded track was dropped, so a fresh attempt can start');
else fail('the dead transfer is still held, so nothing else can begin');
const asked = chase.seen.filter((t) => t.startsWith('Re-requesting')).length;
if (asked > 0) ok(`it still retries first (${asked} re-request round(s)) before giving up — a brief hiccup is not punished`);
else fail('it gave up without retrying at all');

/* ----------------------------------------- 2. a stale phone updates itself */
await p.evaluate(() => { window.__stillHere = true; });
await p.evaluate(() => {
  const c = window.__syncClient;
  // sessionId is what the main speaker screen renders behind; in real life it
  // is always set by the time the host has told us its build.
  c.set({ sessionId: 'syncmusic-main', hostBuild: '2999-01-01 00:00' });
});
await p.waitForTimeout(700);
const card = (await p.content()).includes('updating it now') ? 1 : 0;
if (card > 0) ok('the stale phone tells the user it is updating');
else fail('no update notice appeared');

await p.waitForTimeout(6000);
const survived = await p.evaluate(() => window.__stillHere === true).catch(() => false);
if (!survived) ok('the page actually reloaded itself onto the newer build');
else fail('the phone showed the notice but never reloaded — it would stay stale forever');

await b.close();
console.log(bad ? `\nSOME CHECKS FAILED (${bad})` : '\nALL CHECKS PASSED');
process.exit(bad ? 1 : 0);
