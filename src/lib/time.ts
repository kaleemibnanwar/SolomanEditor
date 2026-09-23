export const uid = (prefix = "id") =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export const round = (v: number, decimals = 2) => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

/** 00:12.34 — mm:ss.cs */
export function formatTimecode(seconds: number, withMs = true): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return withMs ? `${mm}:${ss}.${String(cs).padStart(2, "0")}` : `${mm}:${ss}`;
}

/** 00:00:12:14 — frames-based timecode for the transport readout. */
export function formatFrames(seconds: number, fps: number): string {
  const total = Math.max(0, Math.round(seconds * fps));
  const f = total % Math.round(fps);
  const secs = Math.floor(total / fps);
  const s = secs % 60;
  const m = Math.floor(secs / 60) % 60;
  const h = Math.floor(secs / 3600);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
}

/** Snap a time value to the nearest frame boundary. */
export const snapToFrame = (t: number, fps: number) => Math.round(t * fps) / fps;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDurationLong(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m === 0) return `${sec}s`;
  return `${m}m ${sec}s`;
}
