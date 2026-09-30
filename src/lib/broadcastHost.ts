/**
 * THE BROADCAST BRIDGE — the renderer's view of the main process's ffmpeg.
 *
 * Broadcasting is a desktop-app capability: it needs ffmpeg and a filesystem, so
 * it lives in `electron/broadcast.cjs`. This module is the renderer half of that
 * arrangement, mirroring `host.ts`: it reads the preload bridge if one exists and
 * reports "not available" otherwise, rather than pretending a static web build
 * can push to RTMP.
 */

/** The live state of one broadcast session, pushed up from main. */
export interface BroadcastStatus {
  /** The main process's id for this session. `null` only for the "none" sentinel. */
  id: string | null;
  running: boolean;
  /** True between reconnect attempts, after the connection dropped. */
  reconnecting: boolean;
  label: string | null;
  protocol: string | null;
  loop: boolean;
  transcode: boolean;
  startedAt: number | null;
  uptime: number;
  /** ffmpeg's `time=` — how far into the source it has reached. */
  time: string | null;
  bitrate: string | null;
  speed: string | null;
  fps: number | null;
  error: string | null;
  note?: string | null;
  /** ffmpeg version string, when one was found. */
  ffmpeg?: string;
  /** The last 40 lines of ffmpeg output logs. */
  tail?: string[];
}

/** A broadcast's source: a file/URL on disk, or the editor's live composed timeline. */
export type BroadcastSource =
  | { kind: "file" | "url"; value: string }
  | { kind: "timeline"; format?: "mp4" | "webm"; copySafe?: boolean };

export interface StartBroadcastPayload {
  /** The pre-built ingest URL, key included. Never echoed back in status. */
  url: string;
  protocol: string;
  source: BroadcastSource;
  loop?: boolean;
  transcode?: boolean;
  label?: string;
  /** Target video bitrate in bps. Omit for the resolution-aware "auto" value. */
  videoBitrate?: number;
  /** Source frame rate, for a correct keyframe interval. Omit for file/URL. */
  fps?: number;
}

export interface BroadcastBridge {
  probe: () => Promise<{ available: boolean; version: string | null }>;
  /** Every session in flight, most recent first. Empty when nothing is pushing. */
  status: () => Promise<BroadcastStatus[]>;
  /** Start one push; resolves with that session's status (id included). */
  start: (payload: StartBroadcastPayload) => Promise<BroadcastStatus>;
  /** Stop one session by id, or every session when no id is given. */
  stop: (id?: string) => Promise<BroadcastStatus[]>;
  /** Feed a MediaRecorder chunk to ffmpeg's stdin (timeline broadcasts). */
  chunk: (chunk: Uint8Array) => void;
  onStatus: (handler: (status: BroadcastStatus) => void) => void;
}

/** The preload bridge, or `null` outside the desktop app. */
export const broadcastBridge = (): BroadcastBridge | null =>
  typeof window === "undefined" ? null : window.octoCutHost?.broadcast ?? null;

export const broadcastAvailable = (): boolean => broadcastBridge() !== null;

/** The state a broadcast host reports when there is no bridge to talk to. */
export const NO_BROADCAST_STATUS: BroadcastStatus = {
  id: null,
  running: false,
  reconnecting: false,
  label: null,
  protocol: null,
  loop: false,
  transcode: false,
  startedAt: null,
  uptime: 0,
  time: null,
  bitrate: null,
  speed: null,
  fps: null,
  error: null,
};

/**
 * Subscribe to pushed status changes. Delivers the current snapshot immediately,
 * then every change the main process announces. Returns an unsubscribe.
 *
 * The preload's `onStatus` cannot detach (see preload.cjs), so it is attached
 * once and fanned out to renderer listeners — the same shape `session.ts` uses
 * for the MCP event log.
 */
const statusListeners = new Set<(status: BroadcastStatus) => void>();
let statusAttached = false;

export function subscribeBroadcastStatus(listener: (status: BroadcastStatus) => void): () => void {
  const bridge = broadcastBridge();
  if (!bridge) {
    listener(NO_BROADCAST_STATUS);
    return () => {};
  }

  if (!statusAttached) {
    statusAttached = true;
    bridge.onStatus((status) => {
      for (const subscribed of statusListeners) subscribed(status);
    });
  }

  statusListeners.add(listener);
  // The current snapshot is a list of sessions — deliver each one to the
  // single-session handler, then rely on onStatus for subsequent changes.
  void bridge
    .status()
    .then((sessions) => sessions.forEach(listener))
    .catch(() => {});
  return () => {
    statusListeners.delete(listener);
  };
}
