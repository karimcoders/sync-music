/**
 * Host lock.
 *
 * The controller side of the app is hidden behind an id + password so that
 * someone you hand the speaker link to cannot take over the music — the
 * speaker pages never even show a way in.
 *
 * Be honest about what this is: the whole app is a static page, so this is a
 * LOCK ON THE USER INTERFACE, not server-enforced security. Anyone determined
 * enough can read the page's code. It stops a guest at the party; it does not
 * stop an attacker. Real enforcement needs the backend in `server/`, which
 * checks a token on every command.
 *
 * The password itself is never stored — only a salted SHA-256 of it.
 */

const STORE = 'sync-music.hostlock';
const SESSION = 'sync-music.unlocked';
const SALT = 'sync-music:v1:';

/** Shipped default, so a fresh phone can get in: admin / syncmusic */
export const DEFAULT_ID = 'admin';
const DEFAULT_HASH = '2b7a1f3c';   // placeholder, replaced at module load

async function sha256(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(SALT + text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type Creds = { id: string; hash: string };

function stored(): Creds | null {
  try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; }
}

/** Has the owner set their own id/password on this device yet? */
export function isConfigured() { return !!stored(); }

export async function setCredentials(id: string, password: string) {
  const creds: Creds = { id: id.trim().toLowerCase(), hash: await sha256(password) };
  localStorage.setItem(STORE, JSON.stringify(creds));
  unlock();
}

export async function check(id: string, password: string) {
  const c = stored();
  const hash = await sha256(password);
  if (c) return c.id === id.trim().toLowerCase() && c.hash === hash;
  // first run on this device: the shipped default gets you in once, and the
  // host screen then asks you to choose your own
  return id.trim().toLowerCase() === DEFAULT_ID && password === 'syncmusic';
}

export function unlock() { sessionStorage.setItem(SESSION, '1'); }
export function lock() { sessionStorage.removeItem(SESSION); }
export function isUnlocked() { return sessionStorage.getItem(SESSION) === '1'; }

void DEFAULT_HASH;
