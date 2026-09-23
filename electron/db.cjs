/**
 * THE SQLITE STORE — the durable backing for projects, media, templates, macros
 * and stream configs.
 *
 * Runs in the main process (the renderer is sandboxed with no Node), so the
 * renderer reaches it over the `octo-cut:store:*` IPC channels. The schema is one
 * key-value table — `kv(domain, key, value, blob)` — where `value` is the record
 * as JSON text and `blob` holds the binary media payload (the one field that
 * cannot live in JSON). A WAL journal and a WITHOUT-ROWID primary key keep it
 * fast and crash-safe.
 *
 * `node:sqlite` is built into Node 22.5+ and needs no native rebuild, which is
 * why it is preferred over `better-sqlite3`. If it is not available (an older
 * Electron), the store reports `available: false` and the renderer falls back to
 * IndexedDB rather than failing.
 */
"use strict";

const path = require("node:path");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

/**
 * Open (or create) the store at `<userData>/octo-cut.db`.
 *
 * Every method is async so the IPC handlers can await it uniformly, even though
 * `node:sqlite` itself is synchronous under the hood.
 */
function createStore(userDataDir) {
  if (!DatabaseSync) {
    const unavailable = {
      available: false,
      get: async () => null,
      getAll: async () => [],
      count: async () => 0,
      put: async () => {},
      putMany: async () => {},
      delete: async () => {},
    };
    return unavailable;
  }

  const file = path.join(userDataDir, "octo-cut.db");
  const db = new DatabaseSync(file);

  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(
    "CREATE TABLE IF NOT EXISTS kv (" +
      "domain TEXT NOT NULL, " +
      "key TEXT NOT NULL, " +
      "value TEXT NOT NULL, " +
      "blob BLOB, " +
      "PRIMARY KEY (domain, key)" +
      ") WITHOUT ROWID;",
  );

  const getStmt = db.prepare("SELECT value, blob FROM kv WHERE domain = ? AND key = ?");
  const allStmt = db.prepare("SELECT key, value, blob FROM kv WHERE domain = ?");
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM kv WHERE domain = ?");
  const putStmt = db.prepare(
    "INSERT INTO kv (domain, key, value, blob) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(domain, key) DO UPDATE SET value = excluded.value, blob = excluded.blob",
  );
  const delStmt = db.prepare("DELETE FROM kv WHERE domain = ? AND key = ?");

  const asBlob = (bytes) => (bytes == null ? null : Buffer.from(bytes));

  /** Write many records for one domain atomically, in a single transaction. */
  const putMany = async (domain, records) => {
    db.exec("BEGIN");
    try {
      for (const record of records) putStmt.run(domain, record.id, record.value, asBlob(record.blob));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  return {
    available: true,
    get: async (domain, key) => {
      const row = getStmt.get(domain, key);
      return row ? { value: row.value, blob: row.blob ?? null } : null;
    },
    getAll: async (domain) => allStmt.all(domain).map((row) => ({ key: row.key, value: row.value, blob: row.blob ?? null })),
    count: async (domain) => (countStmt.get(domain)?.n ?? 0),
    put: async (domain, id, value, blob) => putStmt.run(domain, id, value, asBlob(blob)),
    putMany,
    delete: async (domain, key) => delStmt.run(domain, key),
  };
}

module.exports = { createStore };
