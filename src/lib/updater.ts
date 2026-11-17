/**
 * Auto-update, from the renderer's side.
 *
 * The desktop app's main process owns the real updater (`electron-updater` in
 * `electron/main.cjs`) and pushes its status over IPC. This module is a small
 * client of that: one store, subscribed via `useSyncExternalStore`, plus the
 * verbs the top bar's badge needs. Outside the desktop app there is no bridge,
 * so `available` is false and every control is a no-op — the same
 * degrade-gracefully shape `settings.ts` and `mcp/host.ts` use.
 */
import { useSyncExternalStore } from "react";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

/** The one shape `electron/main.cjs` broadcasts and this module reads. */
export interface UpdateState {
  status: UpdateStatus;
  version: string | null;
  percent: number;
}

/** The narrow bridge `electron/preload.cjs` exposes as `solomanEditorHost.update`. */
export interface UpdateBridge {
  status: () => Promise<UpdateState>;
  check: () => Promise<unknown>;
  download: () => Promise<unknown>;
  install: () => Promise<void>;
  onStatus: (handler: (state: UpdateState) => void) => void;
}

const IDLE: UpdateState = { status: "idle", version: null, percent: 0 };

/** The current state; replaced (not mutated) on every change so React re-renders. */
let state: UpdateState = IDLE;
let subscribed = false;
const listeners = new Set<() => void>();

const bridge = (): UpdateBridge | undefined =>
  typeof window === "undefined" ? undefined : window.solomanEditorHost?.update;

function emit(next: UpdateState) {
  state = next;
  for (const listener of listeners) listener();
}

/** Attach once: request the current status and subscribe to later pushes. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const host = bridge();
  if (host && !subscribed) {
    subscribed = true;
    host.onStatus(emit);
    void host.status().then(emit);
  }
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): UpdateState => state;

/** Whether a desktop updater exists here at all (false in a plain browser tab). */
export function updaterAvailable(): boolean {
  return bridge() !== undefined;
}

export function useUpdater() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    state: current,
    available: bridge() !== undefined,
    check: () => void bridge()?.check(),
    install: () => void bridge()?.install(),
  };
}
