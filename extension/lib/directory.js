// lib/directory.js — File System Access directory management (controls page only).
import { dbg } from "./debug.js";
import { formatBytes } from "./utils.js";
// Persist the chosen directory handle in IndexedDB and scan/write within it.

const DB_NAME = "sppe_dir";
const STORE = "handles";
const DB_KEY = "active";
const DB_STORE = STORE;
const dbPromise = typeof indexedDB === "undefined" ? null : indexedDB.open(DB_NAME, 2);
export const idb = dbPromise
  ? new Promise((resolve, reject) => {
      dbPromise.onupgradeneeded = (event) => {
        const db = event.target.result;
        const transaction = event.target.transaction;
        const store = db.objectStoreNames.contains(STORE)
          ? transaction.objectStore(STORE)
          : db.createObjectStore(STORE, { keyPath: "k" });
        const request = store.get(DB_KEY);
        request.onsuccess = () => {
          const record = request.result;
          if (record?.handle && !record.value) {
            store.put({ ...record, value: record.handle });
          }
        };
      };
      dbPromise.onsuccess = () => resolve(dbPromise.result);
      dbPromise.onerror = () => reject(dbPromise.error);
      dbPromise.onblocked = () => reject(new Error("Directory database is blocked"));
    })
  : Promise.resolve(null);

function tx(store, mode) {
  const d = idb;
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => reject(new Error("IndexedDB request timed out")), 2000);
    d.then((db) => {
      if (!db) throw new Error("IndexedDB is unavailable");
      const objectStore = db.transaction(store, mode).objectStore(store);
      clearTimeout(timer);
      timer = null;
      resolve(objectStore);
    }).catch((error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export const FS_SUPPORT = typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";

export async function storeDirHandle(handle) {
  const t = await tx(DB_STORE, "readwrite");
  return new Promise((res, rej) => {
    const req = t.put({ k: DB_KEY, value: handle });
    req.onsuccess = () => res(handle);
    req.onerror = () => rej(req.error);
  });
}

export async function getStoredDirHandle() {
  try {
    const t = await tx(DB_STORE, "readonly");
    return new Promise((res, rej) => {
      const req = t.get(DB_KEY);
      const timer = setTimeout(() => rej(new Error("IndexedDB request timed out")), 2000);
      req.onsuccess = () => {
        clearTimeout(timer);
        res(req.result?.value ?? req.result?.handle ?? null);
      };
      req.onerror = () => {
        clearTimeout(timer);
        rej(req.error);
      };
    });
  } catch (_) {
    return null;
  }
}

export async function clearStoredDirHandle() {
  const t = await tx(DB_STORE, "readwrite");
  return new Promise((res, rej) => {
    const req = t.delete(DB_KEY);
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
}

export async function pickDirectory() {
  if (!FS_SUPPORT) throw new Error("File System Access API not available in this browser");
  const handle = await window.showDirectoryPicker({ mode: "readwrite", requestNew: false });
  await storeDirHandle(handle);
  return handle;
}

export async function ensureWritePermission(handle) {
  const state = await handle.queryPermission({ mode: "readwrite" });
  if (state !== "granted") await handle.requestPermission({ mode: "readwrite" });
  return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
}

export function dirLabel(handle) {
  return handle?.name || "";
}

export async function* iterFiles(handle) {
  for await (const entry of handle.values()) {
    if (entry.kind === "file") {
      yield entry;
    } else if (entry.kind === "directory") {
      yield* iterFiles(entry);
    }
  }
}

export async function writeFile(handle, relativePath, blob) {
  dbg("writeFile", relativePath, formatBytes(blob.size));
  await ensureWritePermission(handle);
  const parts = relativePath.split("/");
  let current = handle;
  for (let i = 0; i < parts.length - 1; i++) {
    let next = current;
    const children = await current.getDirectoryHandle(parts[i], { create: true });
    next = children;
    current = next;
  }
  const fileHandle = await current.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return fileHandle.name;
}

export async function fileExistsName(handle, targetName) {
  const lower = targetName.toLowerCase();
  for await (const entry of handle.values()) {
    if (entry.kind === "file" && entry.name.toLowerCase() === lower) return true;
    if (entry.kind === "directory" && (await fileExistsName(entry, targetName))) return true;
  }
  return false;
}

export async function scanDirectoryIndex(handle, ids) {
  const idSet = new Set(ids);
  const foundIds = new Set();
  const names = new Set();
  const nonUuidIds = [...idSet].filter((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  for await (const entry of iterFiles(handle)) {
    names.add(entry.name.toLowerCase());
    const matches = entry.name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || [];
    for (const id of matches) {
      const normalized = id.toLowerCase();
      if (idSet.has(normalized)) foundIds.add(normalized);
    }
    for (const id of nonUuidIds) {
      if (entry.name.includes(id)) foundIds.add(id);
    }
  }
  return { ids: foundIds, names };
}

export async function scanExistingIds(handle, ids) {
  return (await scanDirectoryIndex(handle, ids)).ids;
}

export async function replaceFile(handle, relativePath, blob) {
  await writeFile(handle, relativePath, blob);
}
