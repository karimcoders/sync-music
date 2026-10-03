/**
 * Tiny IndexedDB store for the host's audio files.
 *
 * In direct mode the host tab IS the server, so a refresh used to lose the
 * room and the music with it. Keeping the bytes here (plus the room id in
 * localStorage) lets the host reload, keep the same room id and have the
 * speakers reconnect on their own.
 */
const DB = 'sync-music';
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

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
