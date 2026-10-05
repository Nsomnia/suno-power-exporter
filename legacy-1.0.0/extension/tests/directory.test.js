import test from "node:test";
import assert from "node:assert/strict";

test("directory handles round-trip through IndexedDB and migrate legacy records", async () => {
  const records = new Map([["active", { k: "active", handle: { name: "old" } }]]);
  let store;
  let created = false;
  const request = {};
  const db = {
    objectStoreNames: { contains: () => created },
    createObjectStore() {
      created = true;
      return store;
    },
    result: null,
    transaction() {
      return { objectStore() { return store; } };
    }
  };
  store = {
    get(key) {
      const result = records.get(key);
      queueMicrotask(() => request.onsuccess?.());
      return Object.assign(request, { result });
    },
    put(record) {
      records.set(record.k, record);
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
    delete(key) {
      records.delete(key);
      queueMicrotask(() => request.onsuccess?.());
      return request;
    }
  };
  db.result = db;
  const openRequest = {
    result: db,
    transaction() {
      return { objectStore() { return store; } };
    }
  };
  globalThis.indexedDB = {
    open() {
      queueMicrotask(() => {
        openRequest.onupgradeneeded?.({ target: openRequest });
        openRequest.onsuccess?.();
      });
      return openRequest;
    }
  };
  globalThis.chrome = { storage: { local: { get: async () => ({}), set: async () => {} } } };
  const moduleUrl = `../lib/directory.js?roundtrip=${Date.now()}`;
  const { getStoredDirHandle, storeDirHandle, clearStoredDirHandle } = await import(moduleUrl);
  assert.deepEqual(await getStoredDirHandle(), { name: "old" });
  const handle = { name: "new" };
  await storeDirHandle(handle);
  assert.deepEqual(await getStoredDirHandle(), handle);
  await clearStoredDirHandle();
  assert.equal(await getStoredDirHandle(), null);
});
