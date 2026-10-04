/**
 * The SPEAKER's copy of the music.
 *
 * Once a phone has the bytes it never needs the host — or the internet —
 * for that song again: it survives a refresh, a dead Wi-Fi and a full
 * offline period, and it means the next PLAY starts instantly instead of
 * waiting for a download. Same tiny IndexedDB wrapper as the host's store,
 * in its own database.
 */
const DB = 'sync-music-speaker';
const STORE = 'tracks';

export interface StoredTrack {
  id: string;
  title: string;
  artist: string;
  filename: string;
  mimeType: string;
  size: number;
  duration: number;
  bytes: ArrayBuffer;
}

/**
 * ONE connection, opened once. It used to open a fresh connection on every
 * single read and write and never close any of them, which slows every song
 * change down a little more each time and eventually starves the browser.
 */
let dbPromise: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => {
        req.result.onclose = () => { dbPromise = null; };
        resolve(req.result);
      };
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const putTrack = (t: StoredTrack) => tx('readwrite', (s) => s.put(t)).catch(() => undefined);
export const allTracks = () => tx<StoredTrack[]>('readonly', (s) => s.getAll()).catch(() => [] as StoredTrack[]);
export const deleteTrack = (id: string) => tx('readwrite', (s) => s.delete(id)).catch(() => undefined);
export const clearTracks = () => tx('readwrite', (s) => s.clear()).catch(() => undefined);
export const getTrack = (id: string) =>
  tx<StoredTrack | undefined>('readonly', (s) => s.get(id)).catch(() => undefined);
/**
 * ids this phone already holds — sent to the host so it skips the transfer.
 * Keys only: this used to read EVERY saved song (all the audio bytes) into
 * memory just to list their names, on every connect.
 */
export const trackIds = async (): Promise<string[]> => {
  try { return (await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys())).map(String); }
  catch { return []; }
};
