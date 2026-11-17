/**
 * PERSISTENT STORAGE — the one place this app keeps anything after a reload.
 *
 * Two backings, chosen once at startup:
 *
 *   · SQLite (desktop). The durable store lives in the main process
 *     (`electron/db.cjs`, via `node:sqlite`) and is reached over the
 *     `solomanEditorHost.store` bridge. This is the real database: a file on disk,
 *     WAL-journalled, with media stored as a BLOB column.
 *   · IndexedDB (web fallback). A plain browser has no Node, so the same API is
 *     answered from IndexedDB — the historical implementation, kept for the web
 *     build and as the source of a one-time migration into SQLite.
 *
 * The shape the rest of the app sees is identical either way: `storeGet`,
 * `storeGetAll`, `storePut`, `storeDelete`, `storagePersists`. The only thing a
 * caller can detect is `storagePersists` — a real file versus "this browser may
 * not keep it".
 *
 * Media is the one thing JSON cannot carry, so a record's top-level `blob` field
 * (an Asset's bytes) is pulled out of the JSON, sent as binary, and re-attached
 * as a `Blob` on read — typed from the record's own `mime` when it has one.
 */

export const PROJECT_STORE = "projects";
export const ASSET_STORE = "assets";
export const TEMPLATE_STORE = "templates";
export const MACRO_STORE = "macros";
export const STREAM_STORE = "streams";

const ALL_DOMAINS = [PROJECT_STORE, ASSET_STORE, TEMPLATE_STORE, MACRO_STORE, STREAM_STORE] as const;
type StoreName = (typeof ALL_DOMAINS)[number];

/** The main-process SQLite bridge, published on `window.solomanEditorHost.store`. */
export interface StoreBridge {
  available: () => Promise<boolean>;
  get: (domain: string, key: string) => Promise<{ value: string; blob: Uint8Array | null } | null>;
  getAll: (domain: string) => Promise<{ key: string; value: string; blob: Uint8Array | null }[]>;
  count: (domain: string) => Promise<number>;
  put: (domain: string, id: string, value: string, blob: Uint8Array | null) => Promise<void>;
  putMany: (domain: string, records: { id: string; value: string; blob: Uint8Array | null }[]) => Promise<void>;
  delete: (domain: string, key: string) => Promise<void>;
}

const bridge = (): StoreBridge | null => (typeof window === "undefined" ? null : window.solomanEditorHost?.store ?? null);

/* ------------------------------------------------------------------ *
 * SQLite backend (desktop)
 * ------------------------------------------------------------------ */

/** Pull a record's Blob out and return the JSON + bytes to persist. */
async function serializeForPut(value: Record<string, unknown>): Promise<{ json: string; blob: Uint8Array | null }> {
  const copy: Record<string, unknown> = { ...value };
  let blob: Uint8Array | null = null;
  if (copy.blob instanceof Blob) {
    blob = new Uint8Array(await copy.blob.arrayBuffer());
    delete copy.blob;
  }
  return { json: JSON.stringify(copy), blob };
}

/** Re-attach a stored BLOB as a Blob, typed from the record's own mime. */
function deserializeFromGet<T>(json: string, blob: Uint8Array | null): T {
  const value = JSON.parse(json) as Record<string, unknown> & { mime?: string };
  if (blob) value.blob = new Blob([blob], { type: value.mime ?? "application/octet-stream" });
  return value as T;
}

async function sqliteGet<T>(domain: StoreName, key: string): Promise<T | undefined> {
  const row = await bridge()!.get(domain, key);
  return row ? deserializeFromGet<T>(row.value, row.blob) : undefined;
}

async function sqliteGetAll<T>(domain: StoreName): Promise<T[]> {
  const rows = await bridge()!.getAll(domain);
  return rows.map((row) => deserializeFromGet<T>(row.value, row.blob));
}

async function sqlitePut(domain: StoreName, value: { id: string }): Promise<void> {
  const { json, blob } = await serializeForPut(value as Record<string, unknown>);
  await bridge()!.put(domain, value.id, json, blob);
}

async function sqliteDelete(domain: StoreName, key: string): Promise<void> {
  await bridge()!.delete(domain, key);
}

/* ------------------------------------------------------------------ *
 * IndexedDB backend (web fallback + migration source)
 * ------------------------------------------------------------------ */

const DB_NAME = "soloman-editor";
const DB_VERSION = 4;

const memory: Record<StoreName, Map<string, unknown>> = {
  [PROJECT_STORE]: new Map(),
  [ASSET_STORE]: new Map(),
  [TEMPLATE_STORE]: new Map(),
  [MACRO_STORE]: new Map(),
  [STREAM_STORE]: new Map(),
};

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of ALL_DOMAINS) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });

  return dbPromise;
}

async function idbRun<T>(storeName: StoreName, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise<T | undefined>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeName, mode);
    } catch {
      resolve(undefined);
      return;
    }
    const request = work(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => resolve(undefined);
    tx.onabort = () => resolve(undefined);
  });
}

async function idbGet<T>(storeName: StoreName, key: string): Promise<T | undefined> {
  const fromDb = await idbRun<T>(storeName, "readonly", (store) => store.get(key));
  if (fromDb !== undefined) return fromDb;
  return memory[storeName].get(key) as T | undefined;
}

async function idbGetAll<T>(storeName: StoreName): Promise<T[]> {
  const fromDb = await idbRun<T[]>(storeName, "readonly", (store) => store.getAll());
  if (fromDb && fromDb.length) return fromDb;
  return [...memory[storeName].values()] as T[];
}

async function idbCount(storeName: StoreName): Promise<number> {
  const fromDb = await idbRun<number>(storeName, "readonly", (store) => store.count());
  if (fromDb !== undefined) return fromDb;
  return memory[storeName].size;
}

async function idbPut(storeName: StoreName, value: { id: string }): Promise<void> {
  memory[storeName].set(value.id, value);
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function idbDelete(storeName: StoreName, key: string): Promise<void> {
  memory[storeName].delete(key);
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(storeName, "readwrite");
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

/* ------------------------------------------------------------------ *
 * Backend selection + one-time migration
 * ------------------------------------------------------------------ */

type Backend = "sqlite" | "idb";
let backend: Backend | null = null;
let resolving: Promise<Backend> | null = null;

const MIGRATION_FLAG = "indexeddbMigrated";

/**
 * Copy every IndexedDB record into SQLite once, guarded by a flag row in the
 * `meta` domain.
 *
 * Optimized two ways: each domain is written in ONE IPC round-trip (rather than
 * one per record) and ONE SQLite transaction, so a large media library migrates
 * quickly and atomically. And the copy is VERIFIED — record counts must match —
 * before the flag is set and the old IndexedDB is dropped. If verification fails,
 * IndexedDB is left intact as the source of truth and the migration simply runs
 * again next boot.
 */
async function migrateIndexedDb(): Promise<void> {
  const store = bridge()!;
  try {
    if (await store.get("meta", MIGRATION_FLAG)) return;
  } catch {
    /* first run — the meta row has never been written */
  }

  const expected: Partial<Record<StoreName, number>> = {};
  for (const domain of ALL_DOMAINS) expected[domain] = await idbCount(domain);

  for (const domain of ALL_DOMAINS) {
    const records = await idbGetAll<{ id: string }>(domain);
    if (!records.length) continue;
    const encoded = await Promise.all(
      records.map(async (record) => {
        const { json, blob } = await serializeForPut(record as Record<string, unknown>);
        return { id: record.id, value: json, blob };
      }),
    );
    await store.putMany(domain, encoded);
  }

  // Verify every record landed before trusting the copy.
  for (const domain of ALL_DOMAINS) {
    if ((await store.count(domain)) !== expected[domain]) {
      console.warn(`[soloman-editor] storage migration could not be verified for "${domain}" — IndexedDB kept intact.`);
      return;
    }
  }

  await store.put("meta", MIGRATION_FLAG, "1", null);
  await clearIndexedDb();
}

/** Drop the legacy IndexedDB database once its data is safely in SQLite. */
async function clearIndexedDb(): Promise<void> {
  dbPromise = null;
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

function resolveBackend(): Promise<Backend> {
  if (backend) return Promise.resolve(backend);
  if (!resolving) {
    resolving = (async () => {
      const store = bridge();
      if (store && (await store.available())) {
        await migrateIndexedDb();
        backend = "sqlite";
      } else {
        backend = "idb";
      }
      return backend;
    })();
  }
  return resolving;
}

/* ------------------------------------------------------------------ *
 * The public API (identical shape for both backends)
 * ------------------------------------------------------------------ */

export async function storeGet<T>(storeName: StoreName, key: string): Promise<T | undefined> {
  return (await resolveBackend()) === "sqlite" ? sqliteGet<T>(storeName, key) : idbGet<T>(storeName, key);
}

export async function storeGetAll<T>(storeName: StoreName): Promise<T[]> {
  return (await resolveBackend()) === "sqlite" ? sqliteGetAll<T>(storeName) : idbGetAll<T>(storeName);
}

export async function storePut(storeName: StoreName, value: { id: string }): Promise<void> {
  if ((await resolveBackend()) === "sqlite") await sqlitePut(storeName, value);
  else await idbPut(storeName, value);
}

export async function storeDelete(storeName: StoreName, key: string): Promise<void> {
  if ((await resolveBackend()) === "sqlite") await sqliteDelete(storeName, key);
  else await idbDelete(storeName, key);
}

/* ------------------------------------------------------------------ *
 * Persistence probes
 * ------------------------------------------------------------------ */

let persists: boolean | null = null;

/** True when a write will still be there after a reload. */
export async function storagePersists(): Promise<boolean> {
  if ((await resolveBackend()) === "sqlite") return true;
  if (persists === null) persists = (await openDb()) !== null;
  return persists;
}

/** Synchronous best guess, for a component that renders before the probe lands. */
export const storagePersistsSync = (): boolean => {
  if (typeof window !== "undefined" && window.solomanEditorHost?.store) return true;
  return persists === true;
};
