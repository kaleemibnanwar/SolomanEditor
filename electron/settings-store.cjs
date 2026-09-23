/**
 * THE SETTINGS STORE.
 *
 * The stock-media provider API keys the renderer needs but that should survive
 * a restart. This is deliberately as small as `mcp-http.cjs` is narrow: one
 * JSON file in the user's data directory, read on demand and rewritten whole on
 * every change — there is no concurrent writer to race, so nothing fancier
 * earns its keep.
 *
 * The renderer still performs the actual provider fetches itself (see
 * `src/lib/stock.ts`) — this only gets the key off disk and into memory. A
 * design that kept the key in the main process for every request would mean
 * proxying every stock search through IPC, which is a much bigger change than
 * "persist a handful of strings" and isn't what this file is for.
 */
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const FILE_NAME = "octo-cut-settings.json";

/** Keys this store will read/write. Anything else in the file is preserved but ignored. */
const KNOWN_KEYS = new Set(["pixabayApiKey", "pexelsApiKey"]);

function filePathIn(userDataDir) {
  return path.join(userDataDir, FILE_NAME);
}

async function readAll(userDataDir) {
  try {
    const raw = await fs.readFile(filePathIn(userDataDir), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    console.error(`[octo-cut] settings file unreadable, starting empty — ${error?.message ?? error}`);
    return {};
  }
}

async function writeAll(userDataDir, data) {
  await fs.writeFile(filePathIn(userDataDir), JSON.stringify(data, null, 2), "utf8");
}

/** `{ get(key), set(key, value), getAll() }`, bound to one user-data directory. */
function createSettingsStore(userDataDir) {
  return {
    async get(key) {
      const all = await readAll(userDataDir);
      return all[key] ?? null;
    },
    async set(key, value) {
      if (!KNOWN_KEYS.has(key)) throw new Error(`Unknown setting "${key}".`);
      const all = await readAll(userDataDir);
      if (value === null || value === undefined || value === "") delete all[key];
      else all[key] = value;
      await writeAll(userDataDir, all);
      return all[key] ?? null;
    },
    async getAll() {
      const all = await readAll(userDataDir);
      const out = {};
      for (const key of KNOWN_KEYS) out[key] = all[key] ?? null;
      return out;
    },
  };
}

module.exports = { createSettingsStore, KNOWN_KEYS };
