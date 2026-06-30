/**
 * IndexedDB-backed store for this device's delta event log.
 *
 * The log lives here instead of `browser.storage.local` so that writing it does not
 * fan out through `storage.local.onChanged`: Firefox structure-clones the full old and
 * new value once per registered listener and holds those copies, which for the ~10 MB
 * log drove resident memory to ~1.6 GB. IndexedDB writes are point updates that no
 * `onChanged` listener observes.
 *
 * One record (key `'self'`) holds the whole log object, mirroring the shape the log
 * used to write to storage.local: `{v, deviceId, events}`.
 *
 * @module sync/delta/delta-log-store
 */

const DB_NAME = 'stg-delta-sync';
const DB_VERSION = 1;
const STORE_NAME = 'deltaLog';
const RECORD_KEY = 'self';

let openPromise = null;

function openDb() {
    return openPromise ??= new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('delta-log IndexedDB open blocked'));
    }).catch(err => {
        openPromise = null;
        throw err;
    });
}

function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function load() {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    return requestToPromise(tx.objectStore(STORE_NAME).get(RECORD_KEY));
}

async function save(record) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(record, RECORD_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

async function remove() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(RECORD_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

export default {load, save, remove};
