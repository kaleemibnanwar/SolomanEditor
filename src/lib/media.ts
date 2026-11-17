/**
 * Media pipeline: file import → playable DOM element + poster thumbnail +
 * decoded audio buffer + waveform peaks.
 *
 * Nothing here touches the store directly; callers get an Asset object back and
 * register it with the editor store.
 */
import type { Asset, MediaKind } from "@/types/editor";
import { uid } from "@/lib/time";

/* ------------------------------------------------------------------ *
 * Audio context (shared, created on demand)
 * ------------------------------------------------------------------ */

let audioCtx: AudioContext | null = null;
export function getAudioContext(): AudioContext {
  if (!audioCtx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audioCtx = new Ctor();
  }
  return audioCtx;
}

export async function resumeAudioContext() {
  const ctx = getAudioContext();
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      /* browser refused — playback will stay silent until a real gesture */
    }
  }
  return ctx;
}

/* ------------------------------------------------------------------ *
 * Kind detection
 * ------------------------------------------------------------------ */

const VIDEO_EXT = ["mp4", "webm", "mov", "m4v", "ogv", "mkv", "avi"];
const IMAGE_EXT = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"];
const AUDIO_EXT = ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"];

export function detectKind(file: File): MediaKind | null {
  const type = file.type || "";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (VIDEO_EXT.includes(ext)) return "video";
  if (IMAGE_EXT.includes(ext)) return "image";
  if (AUDIO_EXT.includes(ext)) return "audio";
  return null;
}

/* ------------------------------------------------------------------ *
 * Waveform peaks
 * ------------------------------------------------------------------ */

export function computePeaks(buffer: AudioBuffer, buckets = 800): number[] {
  const data = buffer.getChannelData(0);
  if (!data.length) return [];
  const block = Math.max(1, Math.floor(data.length / buckets));
  const peaks: number[] = [];
  for (let i = 0; i < buckets; i++) {
    const start = i * block;
    let peak = 0;
    for (let j = 0; j < block; j += 8) {
      const v = Math.abs(data[start + j] || 0);
      if (v > peak) peak = v;
    }
    peaks.push(Math.min(1, peak * 1.35));
  }
  return peaks;
}

export async function decodeAudioBuffer(url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  const arr = await res.arrayBuffer();
  const ctx = getAudioContext();
  return await ctx.decodeAudioData(arr.slice(0));
}

/* ------------------------------------------------------------------ *
 * Thumbnails
 * ------------------------------------------------------------------ */

function drawToDataUrl(source: CanvasImageSource, width: number, height: number, maxWidth = 200): string {
  const scale = Math.min(1, maxWidth / Math.max(1, width));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.round(width * scale));
  canvas.height = Math.max(2, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.72);
}

function captureVideoThumb(el: HTMLVideoElement): Promise<string> {
  return new Promise((resolve) => {
    const finish = () => {
      try {
        if (el.videoWidth) resolve(drawToDataUrl(el, el.videoWidth, el.videoHeight));
        else resolve("");
      } catch {
        resolve("");
      }
    };
    const timer = window.setTimeout(finish, 2000);
    el.addEventListener(
      "seeked",
      () => {
        window.clearTimeout(timer);
        finish();
      },
      { once: true },
    );
    try {
      el.currentTime = Math.min(0.12, Math.max(0, (el.duration || 1) / 2));
    } catch {
      window.clearTimeout(timer);
      finish();
    }
  });
}

/* ------------------------------------------------------------------ *
 * Metadata loading (patches an already-registered asset)
 * ------------------------------------------------------------------ */

export interface LoadedMeta {
  width?: number;
  height?: number;
  duration?: number;
  thumbnail?: string;
  waveform?: number[];
  audioBuffer?: AudioBuffer;
  el?: Asset["el"];
}

export function loadVideoMeta(url: string): Promise<LoadedMeta> {
  return new Promise((resolve) => {
    const el = document.createElement("video");
    el.src = url;
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    el.muted = false;
    el.playsInline = true;

    let settled = false;
    const settle = async () => {
      if (settled) return;
      settled = true;
      const meta: LoadedMeta = {
        width: el.videoWidth || 1280,
        height: el.videoHeight || 720,
        duration: Number.isFinite(el.duration) ? el.duration : 10,
        el,
      };
      meta.thumbnail = await captureVideoThumb(el);
      resolve(meta);
    };

    el.addEventListener("loadeddata", () => void settle(), { once: true });
    el.addEventListener(
      "error",
      () => resolve({ width: 1280, height: 720, duration: 5, el }),
      { once: true },
    );
    window.setTimeout(() => {
      if (el.readyState >= 1) void settle();
    }, 2500);
  });
}

export function loadImageMeta(url: string): Promise<LoadedMeta> {
  return new Promise((resolve) => {
    const el = new Image();
    el.crossOrigin = "anonymous";
    el.src = url;
    el.onload = () =>
      resolve({
        width: el.naturalWidth || 1280,
        height: el.naturalHeight || 720,
        el,
        thumbnail: drawToDataUrl(el, el.naturalWidth || 1280, el.naturalHeight || 720),
      });
    el.onerror = () => resolve({ width: 1280, height: 720, el });
  });
}

export async function loadAudioMeta(url: string): Promise<LoadedMeta> {
  try {
    const buffer = await decodeAudioBuffer(url);
    return {
      duration: buffer.duration,
      audioBuffer: buffer,
      waveform: computePeaks(buffer),
      width: 0,
      height: 0,
    };
  } catch {
    return { duration: 5, waveform: [] };
  }
}

/**
 * Imports files into Asset records. The asset is returned immediately with a
 * playable URL; metadata is filled in by `loadAssetMeta` so the UI never blocks.
 */
export function createAssetsFromFiles(files: File[]): { asset: Asset; meta: Promise<LoadedMeta> }[] {
  const out: { asset: Asset; meta: Promise<LoadedMeta> }[] = [];
  for (const file of files) {
    const kind = detectKind(file);
    if (!kind) continue;
    const url = URL.createObjectURL(file);
    const asset: Asset = {
      id: uid("asset"),
      kind,
      name: file.name.replace(/\.[^.]+$/, ""),
      mime: file.type || `${kind}/unknown`,
      url,
      size: file.size,
      width: kind === "audio" ? 0 : undefined,
      height: kind === "audio" ? 0 : undefined,
      duration: kind === "image" ? undefined : 0,
    };
    const meta =
      kind === "video" ? loadVideoMeta(url) : kind === "image" ? loadImageMeta(url) : loadAudioMeta(url);
    out.push({ asset, meta });
  }
  return out;
}

export function assetMetaPatch(meta: LoadedMeta): Partial<Asset> {
  return {
    width: meta.width,
    height: meta.height,
    duration: meta.duration,
    thumbnail: meta.thumbnail,
    waveform: meta.waveform,
    audioBuffer: meta.audioBuffer,
    el: meta.el,
  };
}

/* ------------------------------------------------------------------ *
 * Generated demo media (no network, no assets on disk)
 * ------------------------------------------------------------------ */

export function generateDemoImage(): { asset: Asset; meta: Promise<LoadedMeta> } {
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  const ctx = canvas.getContext("2d")!;
  const grad = ctx.createLinearGradient(0, 0, 1920, 1080);
  grad.addColorStop(0, "#0f172a");
  grad.addColorStop(0.45, "#1d4ed8");
  grad.addColorStop(1, "#7c3aed");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1920, 1080);

  ctx.globalAlpha = 0.35;
  for (let i = 0; i < 26; i++) {
    ctx.beginPath();
    const r = 40 + ((i * 137) % 220);
    ctx.arc(((i * 271) % 1920), ((i * 593) % 1080), r, 0, Math.PI * 2);
    ctx.fillStyle = i % 2 ? "#22d3ee" : "#f472b6";
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.lineWidth = 4;
  for (let x = -1080; x < 1920; x += 120) {
    ctx.beginPath();
    ctx.moveTo(x, 1080);
    ctx.lineTo(x + 1080, 0);
    ctx.stroke();
  }

  const blob = dataUrlToBlob(canvas.toDataURL("image/png"));
  const url = URL.createObjectURL(blob);
  const asset: Asset = {
    id: uid("asset"),
    kind: "image",
    name: "Neon Mesh",
    mime: "image/png",
    url,
    size: blob.size,
    generated: true,
  };
  return { asset, meta: loadImageMeta(url) };
}

const DEMO_AUDIO_SECONDS = 8;

/** Renders an 8s procedural music bed offline (fast, deterministic, no files). */
export async function generateDemoAudio(
  seconds = DEMO_AUDIO_SECONDS,
): Promise<{ asset: Asset; meta: LoadedMeta }> {
  const buffer = await renderDemoAudio(seconds);
  const wav = encodeWav(buffer);
  const url = URL.createObjectURL(wav);
  const asset: Asset = {
    id: uid("asset"),
    kind: "audio",
    name: "Procedural Beat",
    mime: "audio/wav",
    url,
    size: wav.size,
    generated: true,
    width: 0,
    height: 0,
    duration: buffer.duration,
    audioBuffer: buffer,
    waveform: computePeaks(buffer),
  };
  return { asset, meta: assetMetaPatch(asset) };
}

async function renderDemoAudio(seconds: number): Promise<AudioBuffer> {
  const ctx = getAudioContext();
  const sampleRate = ctx.sampleRate;
  const offline = new OfflineAudioContext(2, Math.ceil(sampleRate * seconds), sampleRate);

  const master = offline.createGain();
  master.gain.value = 0.8;
  master.connect(offline.destination);

  // Chord pad
  const chords = [
    [220, 277.18, 329.63],
    [196, 246.94, 293.66],
    [174.61, 220, 261.63],
    [196, 246.94, 329.63],
  ];
  chords.forEach((chord, i) => {
    const start = i * (seconds / 4);
    chord.forEach((freq, j) => {
      const osc = offline.createOscillator();
      const gain = offline.createGain();
      osc.type = j === 0 ? "sawtooth" : "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.045, start + 0.35);
      gain.gain.linearRampToValueAtTime(0, start + seconds / 4);
      osc.connect(gain).connect(master);
      osc.start(start);
      osc.stop(start + seconds / 4 + 0.05);
    });
  });

  // Kick + hat pattern
  const beat = 60 / 112;
  for (let i = 0; i * beat < seconds; i++) {
    const t = i * beat;
    const kick = offline.createOscillator();
    const kg = offline.createGain();
    kick.frequency.setValueAtTime(140, t);
    kick.frequency.exponentialRampToValueAtTime(46, t + 0.16);
    kg.gain.setValueAtTime(0.5, t);
    kg.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    kick.connect(kg).connect(master);
    kick.start(t);
    kick.stop(t + 0.26);

    if (i % 2 === 1) {
      const noise = offline.createBufferSource();
      const buf = offline.createBuffer(1, Math.floor(sampleRate * 0.06), sampleRate);
      const data = buf.getChannelData(0);
      for (let s = 0; s < data.length; s++) data[s] = (Math.random() * 2 - 1) * (1 - s / data.length);
      noise.buffer = buf;
      const ng = offline.createGain();
      ng.gain.value = 0.12;
      noise.connect(ng).connect(master);
      noise.start(t);
    }
  }

  return offline.startRendering();
}

/** Records a short animated canvas clip into a real video file (no deps). */
export async function generateDemoVideo(seconds = 3): Promise<{ asset: Asset; meta: Promise<LoadedMeta> } | null> {
  if (typeof MediaRecorder === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d")!;
  if (!canvas.captureStream) return null;

  let stream: MediaStream;
  try {
    stream = canvas.captureStream(30);
  } catch {
    return null;
  }

  const mime = pickRecorderMime();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6_000_000 } : undefined);
  } catch {
    return null;
  }

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime || "video/webm" }));
  });

  recorder.start(120);
  const start = performance.now();

  await new Promise<void>((resolve) => {
    const tick = () => {
      const t = (performance.now() - start) / 1000;
      drawDemoFrame(ctx, t, canvas.width, canvas.height);
      if (t >= seconds) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });

  recorder.stop();
  const blob = await done;
  stream.getTracks().forEach((track) => track.stop());
  if (!blob.size) return null;

  const url = URL.createObjectURL(blob);
  const asset: Asset = {
    id: uid("asset"),
    kind: "video",
    name: "Motion Demo",
    mime: blob.type || "video/webm",
    url,
    size: blob.size,
    generated: true,
  };
  return { asset, meta: loadVideoMeta(url) };
}

export function pickRecorderMime(): string {
  const candidates = [
    "video/mp4;codecs=avc1.4d002a,mp4a.40.2",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "video/webm";
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "video/webm";
}

/** Same idea as `pickRecorderMime`, for an audio-only capture (mic dubbing). */
export function pickAudioRecorderMime(): string {
  const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "audio/webm";
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "audio/webm";
}

function drawDemoFrame(ctx: CanvasRenderingContext2D, t: number, w: number, h: number) {
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, `hsl(${(t * 40) % 360}, 70%, 22%)`);
  grad.addColorStop(1, `hsl(${(t * 40 + 90) % 360}, 70%, 38%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  for (let i = 0; i < 6; i++) {
    const phase = t * 1.4 + i * 0.9;
    const x = w / 2 + Math.cos(phase) * (w * 0.28);
    const y = h / 2 + Math.sin(phase * 1.3) * (h * 0.28);
    const r = 60 + Math.sin(phase * 2) * 30;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${(i * 60 + t * 60) % 360}, 90%, 65%, 0.5)`;
    ctx.fill();
  }

  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = "700 64px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("SOLOMAN EDITOR", w / 2, h / 2 - 24);
  ctx.font = "400 28px Inter, system-ui, sans-serif";
  ctx.fillText("generated demo clip", w / 2, h / 2 + 40);
}

/* ------------------------------------------------------------------ *
 * WAV encoding (for generated audio)
 * ------------------------------------------------------------------ */

export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const length = buffer.length * channels * 2 + 44;
  const out = new ArrayBuffer(length);
  const view = new DataView(out);
  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, length - 8, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, length - 44, true);

  let offset = 44;
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  for (let i = 0; i < buffer.length; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([out], { type: "audio/wav" });
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(",");
  const mime = /:(.*?);/.exec(head)?.[1] ?? "application/octet-stream";
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
