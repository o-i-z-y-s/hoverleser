/**
 * Hoverleser tests: a Map-backed stand-in for the slice of IndexedDB that
 * background.js uses (open, object stores keyed by keyPath, get/put/clear,
 * transaction oncomplete).
 *
 * It mirrors two real IndexedDB rules that the lookup code relies on:
 *   • Values are structured-cloned on the way in and out.
 *   • A transaction stays usable across promise continuations of its own
 *     requests, and is closed once control returns to the event loop with no
 *     request pending. Using it after that throws, as a browser would.
 */
'use strict';

const clone = v => (v === undefined || v === null ? v : structuredClone(v));

class FakeTransaction {
  constructor(db, onAccess) {
    this.db = db;
    this.onAccess = onAccess;
    this.pending = 0;
    this.finished = false;
    this.oncomplete = null;
    this.onerror = null;
    this.error = null;
    this._scheduleCheck();
  }

  _scheduleCheck() {
    setImmediate(() => {
      if (this.finished || this.pending > 0) return;
      this.finished = true;
      if (this.oncomplete) this.oncomplete();
    });
  }

  _request(run) {
    if (this.finished) {
      const err = new Error('TransactionInactiveError: request placed on a finished transaction');
      err.name = 'TransactionInactiveError';
      throw err;
    }
    const req = { result: undefined, error: null, onsuccess: null, onerror: null };
    this.pending++;
    queueMicrotask(() => {
      req.result = run();
      if (req.onsuccess) req.onsuccess({ target: req });
      this.pending--;
      this._scheduleCheck();
    });
    return req;
  }

  objectStore(name) {
    const store = this.db.stores.get(name);
    if (!store) throw new Error(`NotFoundError: no object store "${name}"`);
    return {
      get: key => this._request(() => {
        const hit = store.rows.get(key);
        if (this.onAccess) this.onAccess(name, key, hit !== undefined);
        return clone(hit);
      }),
      put: value => this._request(() => { store.rows.set(value[store.keyPath], clone(value)); }),
      clear: () => this._request(() => { store.rows.clear(); }),
    };
  }
}

class FakeDatabase {
  constructor(onAccess) {
    this.stores = new Map();
    this.onAccess = onAccess;
    this.objectStoreNames = { contains: name => this.stores.has(name) };
  }
  createObjectStore(name, { keyPath }) {
    this.stores.set(name, { keyPath, rows: new Map() });
  }
  transaction() {
    return new FakeTransaction(this, this.onAccess);
  }
}

/**
 * @param {(store:string, key:string, hit:boolean) => void} [onAccess]
 *        Called for every get; make-fixture.js uses it to record which keys a
 *        set of lookups reads.
 */
function createFakeIndexedDB(onAccess) {
  const databases = new Map();
  return {
    databases,
    open(name) {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        let db = databases.get(name);
        const isNew = !db;
        if (isNew) { db = new FakeDatabase(onAccess); databases.set(name, db); }
        req.result = db;
        if (isNew && req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
  };
}

module.exports = { createFakeIndexedDB };
