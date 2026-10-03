/** Technical errors are logged here, never surfaced raw to clients. */
export const log = {
  info: (msg: string, meta?: unknown) => console.log(`[info] ${msg}`, meta ?? ''),
  warn: (msg: string, meta?: unknown) => console.warn(`[warn] ${msg}`, meta ?? ''),
  error: (msg: string, err?: unknown) => console.error(`[error] ${msg}`, err ?? ''),
};
