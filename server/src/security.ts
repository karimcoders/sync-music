import crypto from 'node:crypto';
import { config } from './config';

export const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');

function hmac(secret: string, data: string) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function timingSafeEqual(a: string, b: string) {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Short-lived, signed, opaque token. Payload is public (base64url JSON) but tamper-proof. */
export function signToken(payload: Record<string, unknown>, ttlMs: number): string {
  const body = { ...payload, exp: Date.now() + ttlMs };
  const b = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${b}.${hmac(config.tokenSecret, b)}`;
}

export function verifyToken<T = any>(token: string | undefined | null): T | null {
  if (!token || !token.includes('.')) return null;
  const [b, sig] = token.split('.');
  if (!b || !sig || !timingSafeEqual(sig, hmac(config.tokenSecret, b))) return null;
  try {
    const body = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    if (typeof body.exp !== 'number' || body.exp < Date.now()) return null;
    return body as T;
  } catch { return null; }
}

/** Signed audio URL: /api/audio/:id?exp=..&sig=.. (expires, cannot be forged). */
export function signAudioPath(audioId: string, ttlMs = config.audioTokenTtlMs) {
  const exp = Date.now() + ttlMs;
  const sig = hmac(config.audioUrlSecret, `${audioId}.${exp}`);
  return `/api/audio/${encodeURIComponent(audioId)}?exp=${exp}&sig=${sig}`;
}

export function verifyAudioSignature(audioId: string, exp: string | undefined, sig: string | undefined) {
  if (!exp || !sig) return false;
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Date.now()) return false;
  return timingSafeEqual(sig, hmac(config.audioUrlSecret, `${audioId}.${e}`));
}

/** Strip any path component / control chars from a user supplied filename. */
export function sanitizeFilename(name: string) {
  const base = name.split(/[\\/]/).pop() ?? 'audio';
  const clean = base.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  return clean || 'audio';
}
