/**
 * THE TIMELINE-BROADCAST CONTROLLER — one live capture, shared by UI and MCP.
 *
 * A timeline broadcast spans two processes: ffmpeg in the main process (spawned
 * via the broadcast bridge) and the composed capture in the renderer (the
 * broadcast engine). This module owns the one renderer-side engine so the UI
 * button and the `start_broadcast` tool can't start two at once, and so stopping
 * from either side tears both halves down together.
 */
import { getStreamConfig, ingestUrl } from "@/lib/broadcast";
import { broadcastBridge } from "@/lib/broadcastHost";
import { startTimelineBroadcast, type TimelineBroadcastSession } from "@/lib/broadcastEngine";
import { preferredStreamMime } from "@/lib/exporter";

let engine: TimelineBroadcastSession | null = null;

export const timelinePushActive = (): boolean => engine !== null;

export interface TimelinePushOptions {
  loop: boolean;
  transcode: boolean;
  hiddenTrackIds?: Set<string>;
}

export async function startTimelinePush(
  configIdOrName: string,
  options: TimelinePushOptions,
): Promise<{ configName: string; protocol: string; copySafe: boolean }> {
  const bridge = broadcastBridge();
  if (!bridge) throw new Error("Timeline broadcasting needs the desktop app and ffmpeg.");
  if (engine) throw new Error("A timeline broadcast is already running — stop it first.");

  const config = await getStreamConfig(configIdOrName);
  if (!config) throw new Error("No stream config by that id or name — list_stream_configs shows them.");

  const mime = preferredStreamMime();
  if (!mime) throw new Error("This browser cannot record a live stream (no MediaRecorder MP4/WebM support).");

  await bridge.start({
    url: ingestUrl(config),
    protocol: config.protocol,
    source: { kind: "timeline", format: mime.copySafe ? "mp4" : "webm", copySafe: mime.copySafe },
    loop: options.loop,
    transcode: options.transcode,
    label: config.name,
  });

  engine = startTimelineBroadcast({
    loop: options.loop,
    hiddenTrackIds: options.hiddenTrackIds,
    onChunk: (chunk) => bridge.chunk(chunk),
    onError: (message) => console.error("[octo-cut] timeline broadcast:", message),
    onStopped: () => {
      engine = null;
      void bridge.stop().catch(() => {});
    },
  });

  return { configName: config.name, protocol: config.protocol, copySafe: mime.copySafe };
}

export async function stopTimelinePush(): Promise<void> {
  const active = engine;
  engine = null;
  active?.stop();
}
