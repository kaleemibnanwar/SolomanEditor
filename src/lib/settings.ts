/**
 * The stock-media provider API keys, which need to survive a restart.
 *
 * The desktop app persists these to disk via `electron/settings-store.cjs`,
 * reached through the narrow `window.octoCutHost.settings` bridge. A plain
 * browser tab (`pnpm dev`, or a static build with no Electron host at all) has
 * no main process to ask, so it falls back to `localStorage` — the same
 * degrade-gracefully shape `mcp/host.ts` already uses when neither host exists.
 *
 * Web storage is not always there, though: a sandboxed preview iframe sits on an
 * opaque origin, where reaching for `localStorage` throws, and some hosts hand
 * back a store that accepts `setItem` and then forgets it. Either way a write
 * must never be silently discarded — the dialog would close as if it had saved,
 * and the search that needs the key would go on insisting it is missing. So the
 * value is always kept in memory for the session, `localStorage` is used purely
 * as the thing that makes it outlive a reload, and `settingsPersist()` lets the
 * UI say which of the two the user is getting.
 */

export type SettingKey = "pixabayApiKey" | "pexelsApiKey";

export const SETTING_KEYS: SettingKey[] = ["pixabayApiKey", "pexelsApiKey"];

export interface SettingsValues extends Record<SettingKey, string> {}

const LOCAL_STORAGE_PREFIX = "octo-cut:setting:";

const bridge = () => (typeof window === "undefined" ? undefined : window.octoCutHost?.settings);

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

/** This session's values: the source of truth when web storage can't be one. */
const memory = new Map<SettingKey, string>();

/** `null` until asked; the answer can't change while the page lives. */
let storageProbe: boolean | null = null;

/**
 * `localStorage` if it can actually hold a value here, else `null`.
 *
 * Merely reaching for the property can throw, and a store that accepts a write
 * without keeping it is worse than none at all — it looks like success. So the
 * first call round-trips a probe value and only trusts the store if it reads
 * back what it was given.
 */
function webStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  if (storageProbe === false) return null;
  try {
    const store = window.localStorage;
    if (!store) return null;
    if (storageProbe === null) {
      const probe = `${LOCAL_STORAGE_PREFIX}probe`;
      store.setItem(probe, "1");
      storageProbe = store.getItem(probe) === "1";
      store.removeItem(probe);
    }
    return storageProbe ? store : null;
  } catch {
    storageProbe = false;
    return null;
  }
}

/**
 * Whether a saved key will still be there after a reload. False in a sandboxed
 * preview: it works for this session, and Settings says so rather than
 * pretending otherwise.
 */
export function settingsPersist(): boolean {
  if (bridge()) return true;
  return webStorage() !== null;
}

/* ------------------------------------------------------------------ *
 * Change notification
 * ------------------------------------------------------------------ */

/**
 * Saving a key has to be observable, or whatever needed it keeps showing the
 * message it produced a moment ago: a stock search that failed with "add a key
 * in Settings" would sit on screen unchanged after the key arrived, because
 * nothing told it to look again. Readers bump on this version instead.
 */
const listeners = new Set<() => void>();
let version = 0;

export function settingsVersion(): number {
  return version;
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function announce(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/* ------------------------------------------------------------------ *
 * Reading and writing
 * ------------------------------------------------------------------ */

export async function getSetting(key: SettingKey): Promise<string | null> {
  const host = bridge();
  if (host) return host.get(key);

  // A value set in this session wins: it is what the user just typed, and it is
  // the only copy that exists at all when storage is unavailable.
  const remembered = memory.get(key);
  if (remembered !== undefined) return remembered;

  const store = webStorage();
  if (!store) return null;
  try {
    const stored = store.getItem(LOCAL_STORAGE_PREFIX + key);
    if (stored !== null) memory.set(key, stored);
    return stored;
  } catch {
    return null;
  }
}

export async function setSetting(key: SettingKey, value: string | null): Promise<void> {
  const host = bridge();
  if (host) {
    await host.set(key, value);
    announce();
    return;
  }

  if (value === null || value === "") memory.delete(key);
  else memory.set(key, value);

  const store = webStorage();
  if (store) {
    try {
      if (value === null || value === "") store.removeItem(LOCAL_STORAGE_PREFIX + key);
      else store.setItem(LOCAL_STORAGE_PREFIX + key, value);
    } catch {
      // Out of quota, or a store that only pretends: the session copy stands.
      storageProbe = false;
    }
  }

  announce();
}

export async function getAllSettings(): Promise<Record<SettingKey, string | null>> {
  const host = bridge();
  if (host) return (await host.getAll()) as Record<SettingKey, string | null>;
  const out = {} as Record<SettingKey, string | null>;
  for (const key of SETTING_KEYS) out[key] = await getSetting(key);
  return out;
}
