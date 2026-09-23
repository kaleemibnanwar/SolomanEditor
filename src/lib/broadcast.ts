/**
 * BROADCAST CONFIGURATIONS — the reusable targets a live stream is pushed to.
 *
 * A config is the "where" of a broadcast: the ingest protocol, the address (an
 * endpoint without the key, e.g. `rtmp://a.rtmp.youtube.com/live2`), the stream
 * key, and optional login credentials for servers or hardware encoders that
 * demand authentication. It is deliberately platform-agnostic: "YouTube" is just
 * a label, not a code path — the same config shape drives RTMP/SRT/RTSP pushes
 * to any platform or encoder that accepts one of those.
 *
 * The config is DATA that lives in IndexedDB; the actual push is done by the
 * desktop app's ffmpeg process (`electron/broadcast.cjs`). In a plain web build
 * there is no ffmpeg and no filesystem, so broadcasting degrades to "configs
 * only" — the renderer host reports that clearly rather than pretending.
 */
import { STREAM_STORE, storeDelete, storeGetAll, storePut } from "@/lib/storage";
import { uid } from "@/lib/time";

/** The ingest protocols a broadcast can be pushed over. */
export type StreamProtocol = "rtmp" | "rtmps" | "srt" | "rtsp" | "custom";

export const STREAM_PROTOCOLS: { value: StreamProtocol; label: string; hint: string }[] = [
  { value: "rtmp", label: "RTMP", hint: "YouTube, Twitch, Facebook, hardware encoders" },
  { value: "rtmps", label: "RTMPS", hint: "RTMP over TLS — most modern ingest" },
  { value: "srt", label: "SRT", hint: "Reliable UDP transport — encoders, Wowza, Nimble" },
  { value: "rtsp", label: "RTSP", hint: "Local encoders and IP cameras" },
  { value: "custom", label: "Custom URL", hint: "A full URL template — use {key} for the stream key" },
];

export const STREAM_PLATFORMS = [
  "YouTube",
  "Facebook Live",
  "Twitch",
  "TikTok",
  "Instagram",
  "X (Twitter)",
  "Kick",
  "Vimeo",
  "Restream.io",
  "Hardware encoder",
  "Custom server",
] as const;

export interface StreamConfig {
  id: string;
  name: string;
  protocol: StreamProtocol;
  /** Ingest endpoint WITHOUT the key, e.g. `rtmp://a.rtmp.youtube.com/live2`. */
  address: string;
  streamKey: string;
  username?: string;
  password?: string;
  /** Free-form label — "YouTube", "Hardware encoder", whatever helps identify it. */
  platform?: string;
  createdAt: number;
}

export const PLATFORM_DEFAULTS: { platform: string; protocol: StreamProtocol; address: string }[] = [
  { platform: "YouTube", protocol: "rtmps", address: "rtmps://a.rtmps.youtube.com/live2" },
  { platform: "Twitch", protocol: "rtmp", address: "rtmp://live.twitch.tv/app" },
  { platform: "Facebook Live", protocol: "rtmps", address: "rtmps://live-api-s.facebook.com:443/rtmp" },
  { platform: "Kick", protocol: "rtmp", address: "rtmp://fa723fc1b171.global-contribute.live-video.net/app" },
  { platform: "Restream.io", protocol: "rtmp", address: "rtmp://live.restream.io/live" },
  { platform: "Custom server", protocol: "rtmp", address: "rtmp://" },
  { platform: "Hardware encoder", protocol: "srt", address: "srt://0.0.0.0:9000" },
];

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

export async function listStreamConfigs(): Promise<StreamConfig[]> {
  const configs = await storeGetAll<StreamConfig>(STREAM_STORE);
  return configs.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getStreamConfig(idOrName: string): Promise<StreamConfig | undefined> {
  const configs = await listStreamConfigs();
  return (
    configs.find((config) => config.id === idOrName) ??
    configs.find((config) => config.name.trim().toLowerCase() === idOrName.trim().toLowerCase())
  );
}

export async function saveStreamConfig(
  partial: Omit<StreamConfig, "id" | "createdAt"> & { id?: string },
): Promise<StreamConfig> {
  const existing = partial.id ? await getStreamConfig(partial.id) : undefined;
  const config: StreamConfig = {
    id: existing?.id ?? uid("stream"),
    name: partial.name.trim() || "Untitled stream",
    protocol: partial.protocol,
    address: partial.address.trim(),
    streamKey: partial.streamKey,
    username: partial.username?.trim() || undefined,
    password: partial.password || undefined,
    platform: partial.platform?.trim() || undefined,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  await storePut(STREAM_STORE, config);
  return config;
}

export async function deleteStreamConfig(id: string): Promise<void> {
  await storeDelete(STREAM_STORE, id);
}

/* ------------------------------------------------------------------ *
 * The ingest URL (masked for display, full for the push)
 * ------------------------------------------------------------------ */

/** The target URL ffmpeg pushes to, built from a config. Never logs the key. */
export function ingestUrl(config: StreamConfig): string {
  const creds = config.username ? `${config.username}${config.password ? `:${config.password}` : ""}@` : "";
  const base = config.address.trim();
  const withScheme = (scheme: string) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(base) ? base : `${scheme}://${base}`);
  const withCreds = (url: string) => (creds ? url.replace(/^([a-z][a-z0-9+.-]*:\/\/)/i, `$1${creds}`) : url);

  switch (config.protocol) {
    case "rtmp":
    case "rtmps":
      return `${withCreds(withScheme(config.protocol)).replace(/\/+$/, "")}/${config.streamKey}`;
    case "srt": {
      const url = withScheme("srt");
      const sep = url.includes("?") ? "&" : "?";
      return `${url}${sep}streamid=${encodeURIComponent(config.streamKey)}`;
    }
    case "rtsp":
      return `${withCreds(withScheme("rtsp")).replace(/\/+$/, "")}/${config.streamKey}`;
    case "custom":
    default:
      return base.replace(/\{key\}/g, encodeURIComponent(config.streamKey));
  }
}

/** The ingest URL with the stream key and password hidden, for status/UI. */
export function maskIngestUrl(config: StreamConfig): string {
  return ingestUrl({ ...config, streamKey: "•••••", password: config.password ? "•••••" : undefined });
}
