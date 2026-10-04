/**
 * The cloud shortcut: put the song somewhere every phone can pull it from.
 *
 * Why this exists. Without it the host phone has to upload the SAME file once
 * per speaker over WebRTC. Five phones means five uploads out of one phone's
 * connection, and the phones that are still waiting show "Getting the new
 * song… 51 %" for a long time. Measured on the bench, that one uplink was the
 * whole bottleneck.
 *
 * With it the host uploads ONCE, to a place that serves the file over plain
 * HTTPS with CORS and byte ranges, and every phone downloads in parallel at
 * whatever speed its own connection allows. That is exactly how beatsync.gg
 * gets its speed — they use Cloudflare R2; we use a GitHub branch, so there
 * is no new account to create.
 *
 * Be honest about what this costs:
 *  - the song becomes a PUBLIC file at a public URL (the repo is public).
 *    Anyone with the link can download it. Do not use it for private
 *    recordings.
 *  - it needs a GitHub token with write access to one repository. The token
 *    is typed in on the host phone and kept in that phone's localStorage. It
 *    is never committed, never sent to a speaker, and never leaves the host
 *    device except to api.github.com.
 *  - no token, no network, or an upload that fails simply means the old
 *    phone-to-phone transfer is used instead. Nothing breaks.
 */

export interface CloudConfig {
  /** "owner/repo" */
  repo: string;
  /** branch used as the bucket */
  branch: string;
  token: string;
}

const KEY = 'sync-music.cloud';

export function loadCloud(): CloudConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as CloudConfig;
    return c.token && c.repo ? { ...c, branch: c.branch || 'audio-cdn' } : null;
  } catch { return null; }
}

export function saveCloud(c: CloudConfig | null) {
  try {
    if (!c) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(c));
  } catch { /* private mode */ }
}

/** base64 without blowing the stack on a 10 MB file */
function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let s = '';
  const STEP = 0x8000;
  for (let i = 0; i < view.length; i += STEP) {
    s += String.fromCharCode.apply(null, Array.from(view.subarray(i, i + STEP)) as unknown as number[]);
  }
  return btoa(s);
}

async function gh(cfg: CloudConfig, path: string, init: RequestInit = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `token ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  const body = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(body.message || `GitHub said ${r.status}`);
  return body;
}

/** Make sure the bucket branch exists. Safe to call every time. */
async function ensureBranch(cfg: CloudConfig) {
  try {
    await gh(cfg, `/repos/${cfg.repo}/git/refs/heads/${cfg.branch}`);
    return;
  } catch { /* not there yet */ }
  const main = await gh(cfg, `/repos/${cfg.repo}/git/refs/heads/main`);
  await gh(cfg, `/repos/${cfg.repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${cfg.branch}`, sha: main.object.sha }),
  });
}

/**
 * Upload one song and return the URL every phone can fetch.
 *
 * GitHub's contents API takes base64, which inflates the payload by a third,
 * so a 9 MB song is a 12 MB request. That is one upload instead of one per
 * phone, which is the entire point.
 */
export async function uploadTrack(
  cfg: CloudConfig,
  trackId: string,
  bytes: ArrayBuffer,
  filename: string,
): Promise<string> {
  await ensureBranch(cfg);
  const safe = filename.replace(/[^\w.\-]+/g, '_').slice(-60) || 'track';
  const path = `audio/${trackId}-${safe}`;
  // already there from an earlier run? reuse it, do not re-upload
  try {
    const got = await gh(cfg, `/repos/${cfg.repo}/contents/${path}?ref=${cfg.branch}`);
    if (got?.download_url) return got.download_url as string;
  } catch { /* first time */ }
  const res = await gh(cfg, `/repos/${cfg.repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `audio: ${safe}`,
      branch: cfg.branch,
      content: toBase64(bytes),
    }),
  });
  const url = res?.content?.download_url as string | undefined;
  if (!url) throw new Error('GitHub accepted the file but gave no download URL.');
  return url;
}

/**
 * Download a song from that URL, with progress.
 *
 * Nothing here is GitHub-specific: any URL that allows cross-origin reads
 * works, so the same code would serve an R2 bucket or a plain web server.
 */
export async function fetchTrack(
  url: string,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const r = await fetch(url, { signal, cache: 'force-cache' });
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  const total = Number(r.headers.get('content-length') || 0);
  if (!r.body || !total) return r.arrayBuffer();

  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      parts.push(value);
      got += value.byteLength;
      onProgress?.(Math.min(99, Math.round((got / total) * 100)));
    }
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  onProgress?.(100);
  return out.buffer;
}
