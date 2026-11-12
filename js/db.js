// Stockage local sur l'appareil (IndexedDB).

let dbp;
function open() {
  return dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('vtt-gps', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('tracks', { keyPath: 'id' });
      r.result.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function run(store, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const tx = d.transaction(store, mode), rq = fn(tx.objectStore(store));
    tx.oncomplete = () => res(rq && rq.result);
    tx.onerror = () => rej(tx.error);
  });
}
export const allTracks = () => run('tracks', 'readonly', s => s.getAll());
export const putTrack = t => run('tracks', 'readwrite', s => s.put(t));
export const delTrack = id => run('tracks', 'readwrite', s => s.delete(id));
export const getKV = k => run('kv', 'readonly', s => s.get(k));
export const setKV = (k, v) => run('kv', 'readwrite', s => s.put(v, k));
