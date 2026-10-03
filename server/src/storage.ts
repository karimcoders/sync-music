import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config';
import type { AudioTrack } from '@sync-music/protocol';

/**
 * Audio objects live in scalable object storage. Speakers always fetch the
 * asset directly from storage/CDN with a signed URL — the Host NEVER uploads
 * or streams the file to individual speakers.
 *
 * Driver `local`: disk + this server (fine for self-hosting / dev), supports
 * HTTP Range so browsers can seek and cache partially.
 * Driver `s3`:    presigned object-storage URL behind CDN_BASE_URL (prod).
 */

const audioDir = path.join(config.dataDir, 'audio');
const metaFile = path.join(config.dataDir, 'audio-index.json');
fs.mkdirSync(audioDir, { recursive: true });

type Meta = Record<string, Omit<AudioTrack, 'url'>>;
let meta: Meta = {};
try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { meta = {}; }

let flushTimer: NodeJS.Timeout | null = null;
function flush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await fsp.writeFile(metaFile, JSON.stringify(meta, null, 2)).catch(() => {});
  }, 200);
}

export const audioStore = {
  filePath: (id: string) => path.join(audioDir, id),

  async put(id: string, record: Omit<AudioTrack, 'url'>) {
    meta[id] = record;
    flush();
  },
  get(id: string) { return meta[id] ?? null; },
  list(): Omit<AudioTrack, 'url'>[] {
    return Object.values(meta).sort((a, b) => b.createdAt - a.createdAt);
  },
  async remove(id: string) {
    delete meta[id];
    flush();
    await fsp.unlink(path.join(audioDir, id)).catch(() => {});
  },
  exists(id: string) { return !!meta[id] && fs.existsSync(path.join(audioDir, id)); },
};

/** Absolute URL a speaker should fetch. Prefers CDN when configured. */
export function publicAudioUrl(signedPath: string, requestOrigin: string) {
  const base = config.cdnBaseUrl || config.publicBaseUrl || requestOrigin;
  return `${base.replace(/\/$/, '')}${signedPath}`;
}
