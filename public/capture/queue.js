import { MAX_QUEUE_BYTES, MAX_QUEUE_CLIPS } from './capture-state.js';

function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function completed(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error || new Error('Local storage transaction was aborted.'));
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function openQueue() {
  const request = indexedDB.open('eleagent-capture', 1);
  request.onupgradeneeded = () => {
    const clips = request.result.createObjectStore('clips', { keyPath: 'id' });
    clips.createIndex('createdAt', 'createdAt');
    request.result.createObjectStore('state');
  };
  const db = await result(request);
  db.onversionchange = () => db.close();
  return {
    async stats() {
      return await result(db.transaction('state').objectStore('state').get('stats')) || { count: 0, bytes: 0 };
    },
    async add(meta, blob) {
      const tx = db.transaction(['clips', 'state'], 'readwrite');
      const done = completed(tx);
      const state = tx.objectStore('state');
      const clips = tx.objectStore('clips');
      const stats = await result(state.get('stats')) || { count: 0, bytes: 0 };
      if (stats.count + 1 > MAX_QUEUE_CLIPS || stats.bytes + blob.size > MAX_QUEUE_BYTES) {
        tx.abort();
        await done.catch(() => {});
        throw new Error('buffer_full');
      }
      clips.add({ id: `${meta.capture_id}:${meta.clip_seq}`, createdAt: Date.now(), meta, blob });
      state.put({ count: stats.count + 1, bytes: stats.bytes + blob.size }, 'stats');
      await done;
    },
    async first() {
      const cursor = await result(db.transaction('clips').objectStore('clips').index('createdAt').openCursor());
      return cursor?.value;
    },
    async remove(item) {
      const tx = db.transaction(['clips', 'state'], 'readwrite');
      const done = completed(tx);
      const state = tx.objectStore('state');
      const clips = tx.objectStore('clips');
      const stored = await result(clips.get(item.id));
      const stats = await result(state.get('stats')) || { count: 0, bytes: 0 };
      if (stored) {
        clips.delete(item.id);
        state.put({ count: Math.max(0, stats.count - 1), bytes: Math.max(0, stats.bytes - stored.blob.size) }, 'stats');
      }
      await done;
    },
    async clear() {
      const tx = db.transaction(['clips', 'state'], 'readwrite');
      const done = completed(tx);
      tx.objectStore('clips').clear();
      tx.objectStore('state').put({ count: 0, bytes: 0 }, 'stats');
      await done;
    },
  };
}
