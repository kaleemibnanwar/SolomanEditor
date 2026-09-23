/**
 * The desktop window's own minimize / maximize / close, reached through the
 * narrow `window.octoCutHost.windowControls` bridge (see `electron/preload.cjs`).
 *
 * `electron/main.cjs` opens the window with `frame: false`, so there is no OS
 * title bar to do this job — `TopBar.tsx` draws its own and calls through here.
 * A plain browser tab has no such bridge at all, which is the signal the UI
 * uses to hide the controls rather than render ones that do nothing.
 */

export interface WindowControlsBridge {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  /** Fires on any change, including OS-level snap/tile gestures. */
  onMaximizedChange: (handler: (maximized: boolean) => void) => void;
}

// The `Window.octoCutHost` shape itself is declared once, in `mcp/host.ts` —
// see the comment there for why a second `declare global` here would conflict
// instead of merging.

export const windowControls = (): WindowControlsBridge | null =>
  typeof window === "undefined" ? null : (window.octoCutHost?.windowControls ?? null);
