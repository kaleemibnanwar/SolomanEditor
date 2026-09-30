/**
 * THE TIMELINE-BROADCAST CONTROLLER — one live capture, shared by UI and MCP.
 *
 * A timeline broadcast spans two processes: ffmpeg in the main process (spawned
 * via the broadcast bridge) and the composed capture in the renderer (the
 * broadcast engine). This module owns the one renderer-side engine so the UI
 * button and the `start_broadcast` tool can't start two at once, and so stopping
 * from either side tears both halves down together.
 *
 * MULTI-TARGET: a timeline push can go to several destinations at once (YouTube
 * AND Facebook). There is still exactly ONE capture engine — composing and
 * encoding the timeline twice for no reason would only burn CPU — but every
 * chunk it produces is fanned out to every ffmpeg session the caller asked for.
 *
 * RESILIENCE: a dropped ingest connection is not fatal. File/URL pushes reconnect
 * inside the main process (`broadcast.cjs`), but a timeline push reads a WebM
 * pipe whose header is gone once consumed, so it must restart from the renderer.
 * This module watches for its own sessions dying and restarts the whole push —
 * capture and sinks together — stepping the bitrate down each attempt until the
 * uplink holds. A manual stop cancels the watch, so it never fights the user.
 */
import { getStreamConfig, ingestUrl, recommendStreamBitrate } from "@/lib/broadcast";
import { broadcastBridge, subscribeBroadcastStatus, type BroadcastStatus } from "@/lib/broadcastHost";
import { startTimelineBroadcast, type TimelineBroadcastSession } from "@/lib/broadcastEngine";
import { preferredStreamMime } from "@/lib/exporter";
import { editorStore } from "@/store/editorStore";

const TIMELINE_RECONNECT_DELAY_MS = 3000;
const TIMELINE_RECONNECT_MAX = 5;

let engine: TimelineBroadcastSession | null = null;
/** True between the first guard and `engine` being assigned — blocks a second start. */
let launching = false;
/** The ffmpeg session ids the current timeline capture feeds, for a scoped stop. */
let timelineSessionIds: string[] = [];

/** Auto-restart bookkeeping — cleared on a manual stop so it never loops. */
let autoConfigIds: string[] = [];
let autoOptions: TimelinePushOptions | null = null;
let autoAttempts = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let watchAttached = false;
let onTimelineSessionsChanged: ((ids: string[]) => void) | null = null;

export const timelinePushActive = (): boolean => engine !== null;

export function setTimelineSessionsListener(listener: ((ids: string[]) => void) | null) {
  onTimelineSessionsChanged = listener;
}

export interface TimelinePushOptions {
  loop: boolean;
  transcode: boolean;
  hiddenTrackIds?: Set<string>;
  /** Target video bitrate in bps. Omit for the resolution-aware "auto" value. */
  videoBitrate?: number;
}

export interface StartedTarget {
  configName: string;
  protocol: string;
  sessionId: string;
}

/** Resolves one config id/name into a pushable target, or throws a clear error. */
async function resolveTarget(configIdOrName: string) {
  const config = await getStreamConfig(configIdOrName);
  if (!config) throw new Error("No stream config by that id or name — list_stream_configs shows them.");
  return config;
}

/** One-time subscription that reconnects the timeline when its sinks die. */
function attachWatch() {
  if (watchAttached) return;
  watchAttached = true;
  subscribeBroadcastStatus((status: BroadcastStatus) => {
    if (!status.id || status.running || status.reconnecting) return;
    // Only our own timeline sessions matter, and only while the engine is still
    // alive — a manual stop clears `engine`, so it will never restart.
    if (!engine || !timelineSessionIds.includes(status.id) || !autoOptions) return;
    scheduleTimelineRestart();
  });
}

/** The effective target bitrate, stepped ~20% down for a reconnect. */
function steppedBitrate(): number {
  const { project } = editorStore.getState();
  const auto = recommendStreamBitrate(project.settings.width, project.settings.height, project.settings.fps).video;
  const current = autoOptions?.videoBitrate ?? auto;
  return Math.max(1_000_000, Math.round(current * 0.8));
}

function scheduleTimelineRestart() {
  if (restartTimer || autoAttempts >= TIMELINE_RECONNECT_MAX) return;
  autoAttempts += 1;
  const configIds = autoConfigIds;
  const nextOptions = { ...autoOptions, videoBitrate: steppedBitrate() } as TimelinePushOptions;
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    await stopTimelinePush();
    try {
      await launchTimelinePush(configIds, nextOptions, false);
    } catch {
      /* the failed start already surfaced its own error */
    }
  }, TIMELINE_RECONNECT_DELAY_MS);
}

async function launchTimelinePush(
  configIdsOrNames: string[],
  options: TimelinePushOptions,
  resetAttempts: boolean,
): Promise<{ started: StartedTarget[]; copySafe: boolean }> {
  const bridge = broadcastBridge();
  if (!bridge) throw new Error("Timeline broadcasting needs the desktop app and ffmpeg.");
  if (engine || launching) throw new Error("A timeline broadcast is already running — stop it first.");
  if (!configIdsOrNames.length) throw new Error("Pick at least one destination to broadcast to.");

  const mime = preferredStreamMime();
  if (!mime) throw new Error("This browser cannot record a live stream (no MediaRecorder MP4/WebM support).");

  // Set synchronously before the first await so two overlapping starts can't both
  // slip past the `engine` guard above and interleave their capture streams.
  launching = true;
  try {
    // One bitrate for the capture AND every ffmpeg re-encode, derived from the
    // project once so all stages agree exactly.
    const { project } = editorStore.getState();
    const bitrate = recommendStreamBitrate(
      project.settings.width,
      project.settings.height,
      project.settings.fps,
      options.videoBitrate,
    );

    const configs = await Promise.all(configIdsOrNames.map(resolveTarget));

    // Start every ffmpeg session before the capture, so no chunk is produced
    // before a sink is ready to receive it.
    const started: StartedTarget[] = [];
    try {
      for (const config of configs) {
        const status = await bridge.start({
          url: ingestUrl(config),
          protocol: config.protocol,
          source: { kind: "timeline", format: mime.copySafe ? "mp4" : "webm", copySafe: mime.copySafe },
          loop: options.loop,
          transcode: options.transcode,
          label: config.name,
          videoBitrate: bitrate.video,
          fps: project.settings.fps,
        });
        started.push({ configName: config.name, protocol: config.protocol, sessionId: status.id ?? "" });
      }
    } catch (error) {
      // A half-started fan-out has no capture feeding it — tear it down cleanly
      // rather than leave dead pushes running. Only the sinks this attempt
      // actually started are stopped, so one failing start never takes down the
      // other, healthy pushes.
      const ids = started.map((t) => t.sessionId).filter(Boolean);
      if (ids.length) await Promise.all(ids.map((id) => bridge.stop(id))).catch(() => {});
      throw error;
    }

    // Record the push so a later drop can be reconnected (and so a manual stop
    // knows what to forget).
    if (resetAttempts) autoAttempts = 0;
    autoConfigIds = configIdsOrNames;
    autoOptions = options;
    attachWatch();

    // One engine; every chunk it emits is written to all sessions by the bridge.
    timelineSessionIds = started.map((t) => t.sessionId).filter(Boolean);
    onTimelineSessionsChanged?.(timelineSessionIds);

    const stopTimelineSessions = () => {
      const ids = timelineSessionIds;
      timelineSessionIds = [];
      onTimelineSessionsChanged?.([]);
      if (ids.length) void Promise.all(ids.map((id) => bridge.stop(id))).catch(() => {});
    };

    try {
      engine = startTimelineBroadcast({
        loop: options.loop,
        hiddenTrackIds: options.hiddenTrackIds,
        videoBitrate: options.videoBitrate,
        onChunk: (chunk) => bridge.chunk(chunk),
        onError: (message) => console.error("[octo-cut] timeline broadcast:", message),
        onStopped: () => {
          engine = null;
          // Stop only this timeline's sinks — other streams (files, URLs) keep pushing.
          stopTimelineSessions();
        },
      });
    } catch (error) {
      // The engine could not start (no render surface / capture). The ffmpeg
      // sinks above are already running with no capture to feed them — stop them
      // so a failed start never leaves dead pushes behind.
      stopTimelineSessions();
      throw error;
    }

    return { started, copySafe: mime.copySafe };
  } finally {
    launching = false;
  }
}

export async function startTimelinePush(
  configIdsOrNames: string[],
  options: TimelinePushOptions,
): Promise<{ started: StartedTarget[]; copySafe: boolean }> {
  return launchTimelinePush(configIdsOrNames, options, true);
}

/** Start one file/URL push per destination (no capture engine involved). */
export async function startSourcePush(
  configIdsOrNames: string[],
  source: { kind: "file" | "url"; value: string },
  options: { loop: boolean; transcode: boolean; videoBitrate?: number },
): Promise<BroadcastStatus[]> {
  const bridge = broadcastBridge();
  if (!bridge) throw new Error("Broadcasting needs the desktop app and ffmpeg.");
  if (!configIdsOrNames.length) throw new Error("Pick at least one destination to broadcast to.");

  const configs = await Promise.all(configIdsOrNames.map(resolveTarget));
  const statuses: BroadcastStatus[] = [];
  try {
    for (const config of configs) {
      statuses.push(
        await bridge.start({
          url: ingestUrl(config),
          protocol: config.protocol,
          source,
          loop: options.loop,
          transcode: options.transcode,
          label: config.name,
          videoBitrate: options.videoBitrate,
        }),
      );
    }
  } catch (error) {
    // Only tear down the sinks this attempt already started — a failing push must
    // not take down the other running file/URL/timeline broadcasts.
    const ids = statuses.map((s) => s.id).filter((id): id is string => !!id);
    if (ids.length) await Promise.all(ids.map((id) => bridge.stop(id))).catch(() => {});
    throw error;
  }
  return statuses;
}

export async function stopTimelinePush(): Promise<void> {
  // A manual stop cancels any pending reconnect, so it never restarts behind the
  // user's back.
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  autoOptions = null;
  autoConfigIds = [];

  const active = engine;
  engine = null;
  const ids = timelineSessionIds;
  timelineSessionIds = [];
  try {
    active?.stop();
  } catch (error) {
    console.error("[octo-cut] timeline stop failed:", error);
  }
  // Stop ffmpeg directly too — the engine's onStopped does this, but a failure in
  // the capture cleanup must never leave the push running. Only this timeline's
  // sinks are stopped; concurrent file/URL streams are left untouched.
  const bridge = broadcastBridge();
  if (bridge && ids.length) {
    try {
      await Promise.all(ids.map((id) => bridge.stop(id)));
    } catch {
      /* ignore — the push is already gone */
    }
  }
}
