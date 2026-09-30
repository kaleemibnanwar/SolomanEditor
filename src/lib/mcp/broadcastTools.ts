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
  listStreamConfigs,
  getStreamConfig,
  saveStreamConfig,
  deleteStreamConfig,
  maskIngestUrl,
  STREAM_PROTOCOLS,
  STREAM_PLATFORMS,
  type StreamConfig,
} from "@/lib/broadcast";
import { broadcastBridge, type BroadcastStatus } from "@/lib/broadcastHost";
import { startSourcePush, startTimelinePush, stopTimelinePush } from "@/lib/broadcastController";
import { READ, WRITE, argBool, argNumber, argString, argStringList, bool, choice, need, num, object, str, strList, type ToolDefinition } from "@/lib/mcp/kit";
import { textResult, toolError } from "@/lib/mcp/protocol";
import { orderedLayers } from "@/lib/project";
import { editor } from "@/store/editorStore";

const PROTOCOL_IDS = STREAM_PROTOCOLS.map((p) => p.value);

const lineFor = (config: StreamConfig): string =>
  `  "${config.id}" — ${config.name} (${config.protocol.toUpperCase()}, ${config.platform ?? "no platform"}) → ${maskIngestUrl(config)}`;

function statusLines(sessions: BroadcastStatus[]): string[] {
  if (!sessions.length) return ["  · nothing is being pushed right now"];
  const lines: string[] = [];
  for (const s of sessions) {
    if (s.running) {
      lines.push(`  · "${s.label}" → ${(s.protocol ?? "").toUpperCase()}${s.loop ? " (looping)" : ""}${s.transcode ? ", transcoding" : ", stream-copy"}`);
      const detail = [s.time && `t ${s.time}`, s.bitrate, s.speed, s.fps && `${s.fps} fps`].filter(Boolean).join(" · ");
      lines.push(`    · ${detail || "starting…"} · up ${Math.floor(s.uptime / 60)}m ${s.uptime % 60}s`);
    } else {
      lines.push(`  · "${s.label ?? "stream"}" stopped${s.error ? ` — ${s.error}` : ""}`);
    }
  }
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
          { available: false, running: false, sessions: [] },
        );
      }
      const [probe, sessions] = await Promise.all([bridge.probe(), bridge.status()]);
      return textResult(
        [
          `ffmpeg: ${probe.available ? `available (${probe.version})` : "NOT installed — set FFMPEG_PATH or install ffmpeg"}`,
          ...statusLines(sessions),
        ].join("\n"),
        { available: probe.available, ffmpeg: probe.version, running: sessions.some((s) => s.running), sessions },
      );
    },
  },
  {
    name: "start_broadcast",
    title: "Broadcast live",
    description:
      "Push to one or more saved stream configs via ffmpeg — `configs` takes a list so the same feed (a file, a URL, or the composed timeline) can go to YouTube AND Facebook at once. Sources: `file` (local path) or `url` re-streamed as-is, or `timeline: true` to broadcast the composed timeline live. `loop` repeats until stopped; `transcode` re-encodes to H.264/AAC. `video_bitrate` sets the target in bits per second — omit it for a resolution- and fps-aware auto value (the fix for a 'bitrate too low' warning). The key is never echoed. Poll broadcast_status.",
    inputSchema: object(
      {
        config: str("A single stream config id or name from list_stream_configs."),
        configs: strList("One or more stream config ids/names to push the same feed to at once."),
        file: str("Local path to the video file to stream (ignored when timeline is true)."),
        url: str("An http(s) URL to the video to stream (ignored when timeline is true)."),
        timeline: bool("Broadcast the composed timeline instead of a file/URL. Defaults to false."),
        loop: bool("Keep looping until stopped. Defaults to false for files, true for the timeline."),
        transcode: bool("Re-encode to H.264/AAC. Defaults to true — live ingest (YouTube) rejects other codecs."),
        video_bitrate: num("Target video bitrate in bits per second. Omit for auto (resolution + fps)."),
        hidden_tracks: strList("Track ids to drop from a timeline broadcast — see list_timeline_rows."),
      },
      [],
    ),
    annotations: WRITE,
    run: async (args) => {
      const bridge = broadcastBridge();
      if (!bridge) return toolError("Broadcasting needs the desktop app and ffmpeg — a browser cannot open an RTMP/SRT socket.");

      const single = argString(args, "config");
      const list = argStringList(args, "configs");
      const configIds = list?.length ? list : single ? [single] : [];
      if (!configIds.length) {
        return toolError("start_broadcast needs `config` or `configs` — the stream config id(s)/name(s) from list_stream_configs.");
      }

      const videoBitrate = argNumber(args, "video_bitrate");

      if (argBool(args, "timeline") ?? false) {
        const loop = argBool(args, "loop") ?? true;
        const hidden = argStringList(args, "hidden_tracks");
        const result = await startTimelinePush(configIds, {
          loop,
          transcode: argBool(args, "transcode") ?? false,
          hiddenTrackIds: hidden ? new Set(hidden) : undefined,
          videoBitrate,
        });
        const sessions = await bridge.status();
        return textResult(
          [
            `Broadcasting the timeline to ${result.started.length} destination(s): ${result.started.map((t) => t.configName).join(", ")}.`,
            `  · every layer is composed${result.copySafe ? " — H.264/AAC, stream-copied" : " — VP8/9, transcoded to H.264/AAC"}`,
            `  · target bitrate ${videoBitrate ? `${Math.round(videoBitrate / 1000)} kbps` : "auto (resolution + fps)"}`,
            loop ? "  · looping the whole piece" : "  · single pass",
            ...statusLines(sessions),
          ].join("\n"),
          { ok: true, timeline: true, started: result.started, running: sessions.some((s) => s.running), sessions },
        );
      }

      const file = argString(args, "file");
      const url = argString(args, "url");
      if (!file && !url) return toolError("start_broadcast needs a `file` path, a `url`, or timeline: true.");

      const source = file ? { kind: "file" as const, value: file } : { kind: "url" as const, value: url! };
      const sessions = await startSourcePush(configIds, source, {
        loop: argBool(args, "loop") ?? false,
        transcode: argBool(args, "transcode") ?? true,
        videoBitrate,
      });

      return textResult(
        [
          `Broadcasting to ${sessions.length} destination(s) from ${source.kind === "file" ? `file "${file}"` : `url ${url}`}${argBool(args, "loop") ? " (looping)" : ""}.`,
          `  · target bitrate ${videoBitrate ? `${Math.round(videoBitrate / 1000)} kbps` : "auto"}`,
          ...statusLines(sessions),
        ].join("\n"),
        { ok: true, running: sessions.some((s) => s.running), sessions },
      );
    },
  },
  {
    name: "stop_broadcast",
    title: "Stop the broadcast",
    description: "Stop the running broadcast — one destination by `id` (from broadcast_status), or every destination when no id is given. Leaves the stream config in place for the next push.",
    inputSchema: object({ id: str("A session id from broadcast_status, to stop just that destination.") }),
    annotations: WRITE,
    run: async (args) => {
      const id = argString(args, "id");
      // Stopping a specific destination by id is scoped to that sink; only a full
      // stop (no id) also tears down the live timeline capture.
      if (!id) await stopTimelinePush();
      const bridge = broadcastBridge();
      if (!bridge) return toolError("Broadcasting is not available here.");
      const sessions = (await bridge.stop(id)) ?? [];
      return textResult(id ? `Stopped destination "${id}".` : "Broadcast stopped.", { ok: true, running: sessions.some((s) => s.running), sessions });
    },
  },
];
