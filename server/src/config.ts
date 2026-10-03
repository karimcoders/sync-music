import path from 'node:path';

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v == null ? d : /^(1|true|yes|on)$/i.test(v));

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: num(process.env.PORT, 8080),

  /** Public origin used to build absolute (signed) audio URLs. */
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? '',
  /** Optional CDN in front of object storage. */
  cdnBaseUrl: process.env.CDN_BASE_URL ?? '',

  /** Secrets. MUST be set in production. Never shipped to the client. */
  tokenSecret: process.env.TOKEN_SECRET ?? 'dev-insecure-token-secret-change-me',
  audioUrlSecret: process.env.AUDIO_URL_SECRET ?? 'dev-insecure-audio-secret-change-me',

  /** INFRASTRUCTURE capacity guard — NOT a product speaker limit. */
  maxConnectionsPerInstance: num(process.env.MAX_CONNECTIONS_PER_INSTANCE, 5000),
  /** Optional per-session guard, 0 = disabled (default). Not a product limit. */
  maxSpeakersPerSessionInfra: num(process.env.MAX_SPEAKERS_PER_SESSION_INFRA, 0),
  /** How many speakers are sent in a snapshot before the host list is paged. */
  speakerSnapshotLimit: num(process.env.SPEAKER_SNAPSHOT_LIMIT, 200),

  sessionTtlMs: num(process.env.SESSION_TTL_MS, 12 * 60 * 60 * 1000),
  speakerGraceMs: num(process.env.SPEAKER_GRACE_MS, 60_000),
  audioTokenTtlMs: num(process.env.AUDIO_TOKEN_TTL_MS, 6 * 60 * 60 * 1000),

  maxUploadBytes: num(process.env.MAX_UPLOAD_BYTES, 60 * 1024 * 1024),
  allowedAudioMime: (process.env.ALLOWED_AUDIO_MIME ??
    'audio/mpeg,audio/mp3,audio/mp4,audio/aac,audio/x-m4a,audio/m4a,audio/wav,audio/x-wav,audio/wave')
    .split(',').map((s) => s.trim()),

  dataDir: process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data'),
  storageDriver: (process.env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',

  redisUrl: process.env.REDIS_URL ?? '',
  /** serve the built speaker web app from this server (single-container mode) */
  serveWeb: bool(process.env.SERVE_WEB, true),
  webDir: process.env.WEB_DIR ?? path.resolve(process.cwd(), '../apps/speaker-web/dist'),

  trustProxy: bool(process.env.TRUST_PROXY, true),
};

export function assertProductionSecrets() {
  if (config.env !== 'production') return;
  const bad: string[] = [];
  if (config.tokenSecret.startsWith('dev-insecure')) bad.push('TOKEN_SECRET');
  if (config.audioUrlSecret.startsWith('dev-insecure')) bad.push('AUDIO_URL_SECRET');
  if (bad.length) throw new Error(`Refusing to start in production without: ${bad.join(', ')}`);
}
