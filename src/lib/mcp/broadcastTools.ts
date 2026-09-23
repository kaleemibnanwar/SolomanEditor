/**
 * BROADCAST TOOLS — live-streaming configs and the push itself.
 *
 * Two concerns, both generic (no platform is a code path):
 *
 *   · CONFIGS — the reusable "where" of a stream: protocol, address, stream key
 *     and optional login. Saved in IndexedDB, listed, saved, deleted.
 *   · THE PUSH — re-stream a file (or URL) to a config's ingest endpoint. This
 *     runs through the desktop app's ffmpeg process; in a plain web build it
 *     reports "not available" rather than pretending a browser can open RTMP.
 *
 * The stream key is never echoed. `start_broadcast` builds the ingest URL from
 * the config and hands it to the main process, whose status carries only a label
 * and protocol.
 */
import {
  ingestUrl,
  listStreamConfigs,
  getStreamConfig,
  saveStreamConfig,
  deleteStreamConfig,
  maskIngestUrl,
  STREAM_PROTOCOLS,
  STREAM_PLATFORMS,
  type StreamConfig,
} from "@/lib/broadcast";
import { broadcastBridge, NO_BROADCAST_STATUS, type BroadcastStatus } from "@/lib/broadcastHost";
import { startTimelinePush, stopTimelinePush } from "@/lib/broadcastController";
import { READ, WRITE, argBool, argString, argStringList, bool, choice, need, object, str, strList, type ToolDefinition } from "@/lib/mcp/kit";
import { textResult, toolError } from "@/lib/mcp/protocol";
import { orderedLayers } from "@/lib/project";
import { editor } from "@/store/editorStore";

const PROTOCOL_IDS = STREAM_PROTOCOLS.map((p) => p.value);

const lineFor = (config: StreamConfig): string =>
  `  "${config.id}" — ${config.name} (${config.protocol.toUpperCase()}, ${config.platform ?? "no platform"}) → ${maskIngestUrl(config)}`;

function statusLines(status: BroadcastStatus): string[] {
  const lines: string[] = [];
  if (status.running) {
    lines.push(
      `  · pushing "${status.label}" over ${(status.protocol ?? "").toUpperCase()}${status.loop ? " (looping)" : ""}${status.transcode ? ", transcoding" : ", stream-copy"}`,
    );
    if (status.time) lines.push(`  · source time ${status.time}${status.bitrate ? ` · ${status.bitrate}` : ""}${status.speed ? ` · ${status.speed}` : ""}${status.fps ? ` · ${status.fps} fps` : ""}`);
    lines.push(`  · up ${Math.floor(status.uptime / 60)}m ${status.uptime % 60}s`);
  } else {
    lines.push("  · nothing is being pushed right now");
  }
  if (status.error) lines.push(`  ! ${status.error}`);
  return lines;
}

export const BROADCAST_TOOLS: ToolDefinition[] = [
  {
    name: "list_timeline_rows",
    title: "List timeline rows",
    description:
      "The editor's rows (tracks) — id, name, whether it is the main layer, and how many clips are on it. When broadcasting the timeline, these ids are what you pass to start_broadcast's `hidden_tracks` to choose which components (headlines, lower thirds, audio) go on air.",
    inputSchema: object({}),
    annotations: READ,
    run: () => {
      const state = editor();
      const rows = state.project.trackIds.map((id) => {
        const track = state.project.tracks[id];
        const clipCount = orderedLayers(state.project).filter((layer) => layer.trackId === id).length;
        return { id, name: track?.name ?? "(missing)", main: track?.main ?? false, clipCount };
      });
      return textResult(
        [
          `${rows.length} row(s) — pass the ids you want OFF air as hidden_tracks:`,
          ...rows.map((row) => `  "${row.id}" — ${row.name}${row.main ? " (main layer)" : ""} — ${row.clipCount} clip(s)`),
        ].join("\n"),
        { count: rows.length, rows },
      );
    },
  },
  {
    name: "list_stream_configs",
    title: "List stream configs",
    description:
      "The saved broadcast targets: each one's id, name, protocol (RTMP/RTMPS/SRT/RTSP/custom), ingest address (stream key masked) and platform label. These are the `config` a start_broadcast pushes to. Generic — YouTube, Twitch, a hardware encoder or a private server are all just a config.",
    inputSchema: object({}),
    annotations: READ,
    run: async () => {
      const configs = await listStreamConfigs();
      return textResult(
        configs.length
          ? [
              `${configs.length} stream config(s):`,
              ...configs.map(lineFor),
              "  start_broadcast { config, file | url } pushes a file to one of these.",
            ].join("\n")
          : "No stream configs saved yet. save_stream_config one (protocol + address + stream key), then start_broadcast.",
        {
          count: configs.length,
          configs: configs.map((config) => ({
            id: config.id,
            name: config.name,
            protocol: config.protocol,
            address: config.address,
            platform: config.platform,
            hasAuth: !!config.username,
            target: maskIngestUrl(config),
          })),
        },
      );
    },
  },
  {
    name: "save_stream_config",
    title: "Save a stream config",
    description:
      "Create or update a broadcast target: name, protocol (rtmp/rtmps/srt/rtsp/custom), the ingest address WITHOUT the key (e.g. rtmp://a.rtmp.youtube.com/live2), the stream key, and optional username/password for servers or encoders that authenticate. Pass `id` to update an existing config. The key is stored, never echoed back in plain text.",
    inputSchema: object(
      {
        id: str("Update an existing config by id. Omit to create a new one."),
        name: str("A label, e.g. \"YouTube — main channel\"."),
        protocol: choice("Which ingest protocol.", PROTOCOL_IDS),
        address: str("The endpoint WITHOUT the key. For srt, a host:port; for custom, a full URL template using {key}."),
        streamKey: str("The stream key the platform/encoder gave you."),
        username: str("Login username, when the server demands authentication."),
        password: str("Login password."),
        platform: choice("What this target is, as a label only.", [...STREAM_PLATFORMS]),
      },
      ["name", "protocol", "address", "streamKey"],
    ),
    annotations: WRITE,
    run: async (args) => {
      const config = await saveStreamConfig({
        id: argString(args, "id"),
        name: argString(args, "name") ?? "Untitled stream",
        protocol: (argString(args, "protocol") ?? "rtmp") as StreamConfig["protocol"],
        address: argString(args, "address") ?? "",
        streamKey: argString(args, "streamKey") ?? "",
        username: argString(args, "username"),
        password: argString(args, "password"),
        platform: argString(args, "platform"),
      });
      return textResult(
        [
          `Saved stream config "${config.name}" (${config.id}).`,
          `  · ${config.protocol.toUpperCase()} → ${maskIngestUrl(config)}`,
          `  · platform: ${config.platform ?? "none"}`,
          config.username ? "  · authenticated with username + password" : "  · no authentication",
          "  · start_broadcast { config } to push a file to it",
        ].join("\n"),
        { ok: true, configId: config.id, name: config.name, protocol: config.protocol, platform: config.platform, target: maskIngestUrl(config) },
      );
    },
  },
  {
    name: "delete_stream_config",
    title: "Delete a stream config",
    description: "Delete a saved broadcast target permanently. Does not stop a broadcast already in flight.",
    inputSchema: object({ id: str("The config id (or name) to delete.") }, ["id"]),
    annotations: { ...WRITE, destructiveHint: true },
    run: async (args) => {
      const config = await getStreamConfig(need(args, "id"));
      if (!config) return toolError("No stream config by that id or name — list_stream_configs shows them.");
      await deleteStreamConfig(config.id);
      return textResult(`Deleted stream config "${config.name}" (${config.id}).`, { ok: true, configId: config.id, name: config.name });
    },
  },
  {
    name: "broadcast_status",
    title: "Get broadcast status",
    description:
      "Whether ffmpeg is available and whether a broadcast is running: what it is pushing, its source time/bitrate/speed/fps, how long it has been up, and any error. Read this before and after start_broadcast.",
    inputSchema: object({}),
    annotations: READ,
    run: async () => {
      const bridge = broadcastBridge();
      if (!bridge) {
        return textResult(
          "Broadcasting is not available here — it needs the desktop app and ffmpeg (a browser cannot open an RTMP/SRT socket). Stream configs still save and list.",
          { available: false, ...NO_BROADCAST_STATUS },
        );
      }
      const [probe, status] = await Promise.all([bridge.probe(), bridge.status()]);
      return textResult(
        [
          `ffmpeg: ${probe.available ? `available (${probe.version})` : "NOT installed — set FFMPEG_PATH or install ffmpeg"}`,
          ...statusLines(status),
        ].join("\n"),
        { available: probe.available, ffmpeg: probe.version, ...status },
      );
    },
  },
  {
    name: "start_broadcast",
    title: "Broadcast live",
    description:
      "Push to a saved stream config via ffmpeg. Two sources: a `file` (local path) or `url` re-streamed as-is, or `timeline: true` to broadcast the COMPOSED editor timeline live — every layer, headline, sticker and effect, with the playhead looping the whole piece. `loop` repeats until stopped; `transcode` re-encodes to H.264/AAC. The key is never echoed. Poll broadcast_status.",
    inputSchema: object(
      {
        config: str("The stream config id or name from list_stream_configs."),
        file: str("Local path to the video file to stream (ignored when timeline is true)."),
        url: str("An http(s) URL to the video to stream (ignored when timeline is true)."),
        timeline: bool("Broadcast the composed timeline instead of a file/URL. Defaults to false."),
        loop: bool("Keep looping until stopped. Defaults to false for files, true for the timeline."),
        transcode: bool("Re-encode to H.264/AAC. Defaults to true — live ingest (YouTube) rejects other codecs."),
        hidden_tracks: strList("Track ids to drop from a timeline broadcast — see list_timeline_rows."),
      },
      ["config"],
    ),
    annotations: WRITE,
    run: async (args) => {
      const bridge = broadcastBridge();
      if (!bridge) return toolError("Broadcasting needs the desktop app and ffmpeg — a browser cannot open an RTMP/SRT socket.");

      const config = await getStreamConfig(need(args, "config"));
      if (!config) return toolError("No stream config by that id or name — list_stream_configs shows them.");

      if (argBool(args, "timeline") ?? false) {
        const loop = argBool(args, "loop") ?? true;
        const hidden = argStringList(args, "hidden_tracks");
        const result = await startTimelinePush(config.id, {
          loop,
          transcode: argBool(args, "transcode") ?? false,
          hiddenTrackIds: hidden ? new Set(hidden) : undefined,
        });
        const status = await bridge.status();
        return textResult(
          [
            `Broadcasting the timeline as "${result.configName}" → ${result.protocol.toUpperCase()}.`,
            `  · every layer is composed${result.copySafe ? " — H.264/AAC, stream-copied" : " — VP8/9, transcoded to H.264/AAC"}`,
            loop ? "  · looping the whole piece" : "  · single pass",
            ...statusLines(status),
          ].join("\n"),
          { ok: true, configId: config.id, name: config.name, protocol: config.protocol, timeline: true, ...status },
        );
      }

      const file = argString(args, "file");
      const url = argString(args, "url");
      if (!file && !url) return toolError("start_broadcast needs a `file` path, a `url`, or timeline: true.");

      const source = file ? { kind: "file" as const, value: file } : { kind: "url" as const, value: url! };
      const status = (await bridge.start({
        url: ingestUrl(config),
        protocol: config.protocol,
        source,
        loop: argBool(args, "loop") ?? false,
        transcode: argBool(args, "transcode") ?? true,
        label: config.name,
      })) ?? NO_BROADCAST_STATUS;

      return textResult(
        [
          `Broadcasting "${config.name}" → ${(config.protocol ?? "").toUpperCase()}.`,
          `  · source: ${source.kind === "file" ? `file "${file}"` : `url ${url}`}${argBool(args, "loop") ? " (looping)" : ""}`,
          ...statusLines(status),
        ].join("\n"),
        { ok: true, configId: config.id, name: config.name, protocol: config.protocol, running: status.running, ...status },
      );
    },
  },
  {
    name: "stop_broadcast",
    title: "Stop the broadcast",
    description: "Stop the running broadcast — file or timeline. Leaves the stream config in place for the next push.",
    inputSchema: object({}),
    annotations: WRITE,
    run: async () => {
      await stopTimelinePush();
      const bridge = broadcastBridge();
      if (!bridge) return toolError("Broadcasting is not available here.");
      const status = (await bridge.stop()) ?? NO_BROADCAST_STATUS;
      return textResult("Broadcast stopped.", { ok: true, running: status.running, ...status });
    },
  },
];
