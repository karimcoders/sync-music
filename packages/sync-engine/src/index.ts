/**
 * @sync-music/sync-engine
 * Pure, dependency-free and platform-independent synchronization logic.
 *  - ClockSync : NTP-style server-clock offset estimation
 *  - DriftController : decides ignore / soft rate-nudge / hard seek
 * Both are unit-testable and are used by the speaker web client.
 * (The Kotlin host mirrors ClockSync in apps/host-android.)
 */
import { SYNC } from '@sync-music/protocol';

export interface ClockSample {
  offset: number; // serverTime - clientTime
  rtt: number;
}

/**
 * NTP-ish estimator.
 *   T1 client send, T2 server receive, T3 server send, T4 client receive
 *   rtt    = (T4 - T1) - (T3 - T2)
 *   offset = ((T2 - T1) + (T3 - T4)) / 2
 * We keep a window of samples and use the offset of the lowest-RTT ones,
 * which is far more robust than averaging over a jittery mobile network.
 */
export class ClockSync {
  private samples: ClockSample[] = [];
  private readonly window: number;
  private _offset = 0;
  private _rtt = 0;
  private _synced = false;

  constructor(window = 12) {
    this.window = window;
  }

  addSample(t1: number, t2: number, t3: number, t4: number): ClockSample {
    const rtt = Math.max(0, t4 - t1 - (t3 - t2));
    const offset = (t2 - t1 + (t3 - t4)) / 2;
    const s = { offset, rtt };
    this.samples.push(s);
    if (this.samples.length > this.window) this.samples.shift();
    this.recompute();
    return s;
  }

  private recompute() {
    const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const best = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 3)));
    this._offset = best.reduce((a, s) => a + s.offset, 0) / best.length;
    this._rtt = best.reduce((a, s) => a + s.rtt, 0) / best.length;
    this._synced = this.samples.length >= 3;
  }

  /** Best estimate of the server clock, in epoch ms. */
  now(localNow = Date.now()): number {
    return localNow + this._offset;
  }

  get offset() { return this._offset; }
  /** average round-trip; one-way latency ~ rtt/2 */
  get rtt() { return this._rtt; }
  get latencyMs() { return this._rtt / 2; }
  get synced() { return this._synced; }
  get sampleCount() { return this.samples.length; }
  reset() { this.samples = []; this._synced = false; }
}

export type Correction =
  | { action: 'none'; driftMs: number; rate: number }
  | { action: 'rate'; driftMs: number; rate: number }
  | { action: 'seek'; driftMs: number; rate: number; targetPosition: number };

/**
 * Decides how to converge local playback onto the authoritative position.
 * drift > 0  => we are AHEAD of the server timeline  => slow down
 * drift < 0  => we are BEHIND                        => speed up
 */
export class DriftController {
  private rate = 1;
  private lastHardSeek = 0;
  /** don't hard-seek more than once every 3s, it is audible */
  constructor(private readonly minHardSeekGapMs = 3000) {}

  evaluate(localPosition: number, targetPosition: number, now = Date.now()): Correction {
    const driftMs = (localPosition - targetPosition) * 1000;
    const abs = Math.abs(driftMs);

    if (abs > SYNC.DRIFT_HARD_MS && now - this.lastHardSeek > this.minHardSeekGapMs) {
      this.lastHardSeek = now;
      this.rate = 1;
      return { action: 'seek', driftMs, rate: 1, targetPosition };
    }
    if (abs <= SYNC.DRIFT_IGNORE_MS) {
      if (this.rate !== 1) { this.rate = 1; return { action: 'rate', driftMs, rate: 1 }; }
      return { action: 'none', driftMs, rate: 1 };
    }
    // soft correction, inaudible pitch change
    const desired = driftMs > 0 ? 1 - SYNC.RATE_NUDGE : 1 + SYNC.RATE_NUDGE;
    if (desired !== this.rate) { this.rate = desired; return { action: 'rate', driftMs, rate: desired }; }
    return { action: 'none', driftMs, rate: this.rate };
  }

  reset() { this.rate = 1; this.lastHardSeek = 0; }
}

/**
 * Authoritative position of a transport at a given server time.
 * Used identically on server (for drift math) and client (for resync).
 */
export function projectPosition(
  basePosition: number,
  baseServerTime: number,
  atServerTime: number,
  playing: boolean,
  durationSeconds = Infinity,
): number {
  if (!playing) return basePosition;
  const p = basePosition + Math.max(0, atServerTime - baseServerTime) / 1000;
  return Math.min(p, durationSeconds);
}
