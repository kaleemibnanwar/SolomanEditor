/**
 * THE EXPORT ENGINE.
 *
 * Export is a realtime capture: the renderer drives the store playhead (so the
 * preview doubles as an export monitor), draws each frame through the SAME
 * compositor the preview uses, and records the canvas plus a separately mixed
 * audio graph into a real file.
 *
 * Why realtime? Browsers can only mux video they are actually producing.
 * `MediaRecorder` timestamps by wall clock, so a fast offscreen render would
 * produce a file that plays at the wrong speed. Rendering in realtime keeps
 * picture, sound and container timing identical — at the cost of asking the
 * user to leave the tab in the foreground while it runs.
 */
import { toast } from "sonner";
import { evaluateGain } from "@/lib/anim";
import { drawFrame } from "@/lib/compositor";
import { computePeaks, decodeAudioBuffer, getAudioContext, resumeAudioContext } from "@/lib/media";
import { beginMediaCapture, endMediaCapture, isOutputMuted, setOutputMuted } from "@/lib/playback";
import { layerEnd, orderedLayers, projectDuration } from "@/lib/project";
import { clamp, formatBytes, formatTimecode } from "@/lib/time";
import { editor, editorStore } from "@/store/editorStore";
import type { Asset, ExportJob, ExportOptions, Layer, Project } from "@/types/editor";

const LEAD = 0.06;

/* ------------------------------------------------------------------ *
 * Format support
 * ------------------------------------------------------------------ */

const MP4_CANDIDATES = [
  "video/mp4;codecs=avc1.4d002a,mp4a.40.2",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
];
const WEBM_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

function firstSupported(candidates: string[]): string | null {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return null;
  return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? null;
}

/** What this browser can actually write — used by the export dialog. */
export function exportSupport() {
  const mp4 = firstSupported(MP4_CANDIDATES);
  const webm = firstSupported(WEBM_CANDIDATES);
  return { mp4, webm, supported: !!mp4 || !!webm };
}

/**
 * The best container for LIVE streaming the composed canvas to ffmpeg.
 *
 * Prefer WebM (VP8/9 + Opus): Chrome's software H.264 encoder (OpenH264) cannot
 * hold 1080p30 in real time and collapses to a crawl (~1.6 fps), which is exactly
 * YouTube's "not receiving enough video". The VPx encoders keep up; the caller
 * transcodes to H.264/AAC for RTMP. MP4 (avc1 + mp4a) is the fallback — one
 * encode with no Opus→AAC hop, but only safe where hardware H.264 is available.
 */
export function preferredStreamMime(): { mime: string; copySafe: boolean } | null {
  const webm = firstSupported(WEBM_CANDIDATES);
  if (webm) return { mime: webm, copySafe: false };
  const mp4 = firstSupported(MP4_CANDIDATES);
  if (mp4) return { mime: mp4, copySafe: true };
  return null;
}

function chooseMime(format: ExportOptions["format"]): string {
  const { mp4, webm } = exportSupport();
  if (format === "mp4") {
    if (!mp4) throw new Error("This browser cannot record MP4 locally. Pick WebM, or export from Chrome.");
    return mp4;
  }
  if (format === "webm") return webm ?? "video/webm";
  // "auto" prefers WebM (VP8/9): the browser's software H.264 encoder (OpenH264)
  // cannot hold 1080p30 in real time and would drop frames in a realtime export.
  // MP4 remains available as an explicit choice where hardware H.264 exists.
  return webm ?? mp4 ?? "video/webm";
}

export const extensionFor = (mime: string) => (mime.includes("mp4") ? "mp4" : "webm");

const safeName = (name: string) =>
  (name.trim() || "octo-cut-export").replace(/[^\w\-. ]+/g, "").replace(/\s+/g, "-").slice(0, 64);

/* ------------------------------------------------------------------ *
 * Audio: decode once per asset, cache on the asset record
 * ------------------------------------------------------------------ */

const decodeFailed = new Set<string>();
const decoding = new Map<string, Promise<AudioBuffer | null>>();

/**
 * Audio buffers are decoded lazily at export time rather than on import, so
 * dropping a large video never blocks the editor.
 */
export async function ensureAudioBuffer(asset: Asset): Promise<AudioBuffer | null> {
  if (asset.audioBuffer) return asset.audioBuffer;
  if (decodeFailed.has(asset.id)) return null;
  const inflight = decoding.get(asset.id);
  if (inflight) return inflight;

  const task = decodeAudioBuffer(asset.url)
    .then((buffer) => {
      editor().updateAsset(asset.id, { audioBuffer: buffer, waveform: computePeaks(buffer, 600) });
      return buffer;
    })
    .catch(() => {
      // Silent video files legitimately have no decodable audio track.
      decodeFailed.add(asset.id);
      return null;
    })
    .finally(() => decoding.delete(asset.id));

  decoding.set(asset.id, task);
  return task;
}

export interface ScheduledVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export interface VoicePlan {
  layer: Layer;
  buffer: AudioBuffer;
  /** where in the source buffer playback begins */
  offset: number;
  /** how long this voice plays for */
  duration: number;
  /** layer-local time the voice begins at, for the gain envelope */
  startLocal: number;
  /** seconds after the top of the range that it sounds */
  delay: number;
}

/**
 * Works out every audible span in the export range first. Decoding is async, so
 * it cannot happen inline with the scheduling — and the scheduling itself has to
 * be one synchronous pass so every voice shares an identical time origin.
 */
export async function planExportedVoices(
  project: Project,
  assets: Record<string, Asset>,
  rangeStart: number,
  rangeEnd: number,
  hiddenTrackIds?: Set<string>,
): Promise<VoicePlan[]> {
  const plans: VoicePlan[] = [];

  const audible = orderedLayers(project).filter(
    (layer) =>
      !layer.hidden &&
      (layer.type === "audio" || layer.type === "video") &&
      !!layer.assetId &&
      (!hiddenTrackIds || !hiddenTrackIds.has(layer.trackId)),
  );

  for (const layer of audible) {
    const asset = assets[layer.assetId!];
    if (!asset) continue;
    const buffer = await ensureAudioBuffer(asset);
    if (!buffer || buffer.duration <= 0.02) continue;

    const from = Math.max(rangeStart, layer.startTime);
    const to = Math.min(rangeEnd, layerEnd(layer));
    const span = to - from;
    if (span <= 0.02) continue;

    const startLocal = from - layer.startTime;
    const offset = layer.inPoint + startLocal;
    const available = buffer.duration - offset;
    if (available <= 0.02) continue;

    plans.push({
      layer,
      buffer,
      offset,
      duration: Math.min(span, available),
      startLocal,
      delay: from - rangeStart,
    });
  }

  return plans;
}

/**
 * Creates the buffer sources for a plan, all positioned relative to ONE moment on
 * the audio clock. A voice that does not begin at the top of the range starts
 * that much later — which is the whole difference between a mix and a pile-up.
 */
export function startExportedVoices(plans: VoicePlan[], mix: GainNode, origin: number): ScheduledVoice[] {
  const audioCtx = getAudioContext();
  const voices: ScheduledVoice[] = [];

  for (const plan of plans) {
    const source = audioCtx.createBufferSource();
    source.buffer = plan.buffer;
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(mix);

    const when = origin + plan.delay;
    // Bake the gain envelope from the same evaluator the preview uses.
    const steps = clamp(Math.round(plan.duration * 20), 2, 96);
    for (let i = 0; i <= steps; i++) {
      const t = (plan.duration * i) / steps;
      gain.gain.setValueAtTime(Math.max(0, evaluateGain(plan.layer, plan.startLocal + t)), when + t);
    }
    gain.gain.setValueAtTime(0, when + plan.duration + 0.001);

    try {
      source.start(when, plan.offset, plan.duration);
      voices.push({ source, gain });
    } catch {
      /* offset past the end of the decoded track — nothing to play */
    }
  }

  return voices;
}

/* ------------------------------------------------------------------ *
 * Job runner
 * ------------------------------------------------------------------ */

const canceled = new Set<string>();
let pumping = false;

export function cancelExportJob(id: string) {
  const job = editor().exportJobs.find((j) => j.id === id);
  if (!job) return;
  if (job.status === "queued") {
    editor().patchExportJob(id, { status: "canceled", message: "Canceled", progress: 0 });
    return;
  }
  canceled.add(id);
}

/** Processes queued exports one after another so the UI stays responsive. */
export async function pumpExportQueue() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const job = editor().exportJobs.find((j) => j.status === "queued");
      if (!job) break;
      await runExportJob(job);
    }
  } finally {
    pumping = false;
    editor().setUi({ exporting: false });
  }
}

function wait(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

export async function runExportJob(job: ExportJob) {
  const id = job.id;
  const options = job.options;
  const patch = (p: Partial<ExportJob>) => editor().patchExportJob(id, p);

  const wasMuted = isOutputMuted();
  const restoreTime = editorStore.getState().currentTime;
  let recorder: MediaRecorder | null = null;
  let canvasStream: MediaStream | null = null;
  let audioDest: MediaStreamAudioDestinationNode | null = null;
  let voices: ScheduledVoice[] = [];
  let raf = 0;

  try {
    editor().pause();
    editor().setUi({ exporting: true });
    patch({ status: "preparing", progress: 0, message: "Preparing the renderer…" });

    const state = editorStore.getState();
    const project = state.project;
    const projectW = project.settings.width;
    const projectH = project.settings.height;
    const projectEnd = projectDuration(project);

    const width = Math.max(64, Math.round(options.width));
    const height = Math.max(64, Math.round(options.height));

    const rangeStart = clamp(Math.min(options.rangeStart, options.rangeEnd - 0.1), 0, Math.max(0, projectEnd));
    const rangeEnd = Math.max(rangeStart + 0.1, options.rangeEnd);
    const total = rangeEnd - rangeStart;

    // The frame is composed at PROJECT resolution and scaled onto the capture
    // canvas. `renderInk` works in absolute project pixels, so composing straight
    // into a scaled context would displace every layer the moment the export size
    // differed from the project's — which is why a smaller export came out blank.
    const frame = document.createElement("canvas");
    frame.width = projectW;
    frame.height = projectH;
    const fctx = frame.getContext("2d", { alpha: false });
    if (!fctx) throw new Error("The browser refused to create a render surface.");

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("The browser refused to create a render surface.");

    const drawAt = (time: number) => {
      const live = editorStore.getState();
      fctx.setTransform(1, 0, 0, 1, 0, 0);
      drawFrame({
        ctx: fctx,
        settings: live.project.settings,
        layers: orderedLayers(live.project),
        assets: live.assets,
        time,
      });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(frame, 0, 0, projectW, projectH, 0, 0, width, height);
    };
    drawAt(rangeStart);

    if (!canvas.captureStream) throw new Error("This browser cannot capture the canvas for recording.");

    // ---- audio plan -------------------------------------------------
    const audioCtx = await resumeAudioContext();
    let mix: GainNode | null = null;
    let plans: VoicePlan[] = [];
    if (options.includeAudio) {
      patch({ message: "Decoding audio…", progress: 0.02 });
      audioDest = audioCtx.createMediaStreamDestination();
      mix = audioCtx.createGain();
      mix.gain.value = 1;
      mix.connect(audioDest);
      // Buffers must be decoded before the schedule can be built in one pass.
      plans = await planExportedVoices(project, state.assets, rangeStart, rangeEnd);
    }

    // ---- recorder --------------------------------------------------
    canvasStream = canvas.captureStream(options.fps);
    const tracks = [...canvasStream.getVideoTracks()];
    if (audioDest) tracks.push(...audioDest.stream.getAudioTracks());
    const combined = new MediaStream(tracks);

    const mime = chooseMime(options.format);
    const recorderOptions: MediaRecorderOptions = {
      videoBitsPerSecond: Math.round(options.bitrateMbps * 1_000_000),
      audioBitsPerSecond: 192_000,
    };
    try {
      recorder = new MediaRecorder(combined, { ...recorderOptions, mimeType: mime });
    } catch {
      recorder = new MediaRecorder(combined, recorderOptions);
    }

    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    const finished = new Promise<void>((resolve) => {
      recorder!.onstop = () => resolve();
    });

    // The preview and the file must not both play sound, and the video elements
    // have to run rather than being seeked frame by frame.
    setOutputMuted(true);
    beginMediaCapture();
    recorder.start(250);

    // Picture and sound share one origin: the audio clock's "now" at the moment
    // the recorder starts, plus a small lead so the first buffer is not scheduled
    // late. The render loop is anchored to the same instant, which is what keeps a
    // one-second voiceover one second long in the finished file.
    const anchor = performance.now();
    const lead = plans.length ? LEAD : 0;
    if (mix) voices = startExportedVoices(plans, mix, audioCtx.currentTime + lead);
    const wallStart = anchor + lead * 1000;

    patch({ status: "rendering", progress: 0.03, message: "Rendering…" });

    // ---- realtime render loop --------------------------------------
    await new Promise<void>((resolve, reject) => {
      const tick = () => {
        if (canceled.has(id)) {
          reject(new Error("Export canceled."));
          return;
        }
        // Negative during the audio lead-in, so the first frames hold on the
        // range's opening frame while the mix ramps up.
        const elapsed = (performance.now() - wallStart) / 1000;
        const time = clamp(rangeStart + Math.max(0, elapsed), rangeStart, rangeEnd);
        editor().setCurrentTime(time);
        drawAt(time);

        const ratio = Math.min(1, Math.max(0, elapsed) / total);
        patch({
          progress: Math.min(0.98, 0.03 + ratio * 0.95),
          message: `Rendering ${formatTimecode(time)} · ${Math.round(ratio * 100)}% of ${formatTimecode(total, false)}`,
        });

        if (elapsed >= total) {
          resolve();
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
    });

    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }

    patch({ status: "encoding", progress: 0.99, message: "Writing the file…" });
    await wait(160);
    recorder.stop();
    await finished;

    const blob = new Blob(chunks, { type: recorder.mimeType || mime });
    if (!blob.size) throw new Error("The recorder produced an empty file. Try a different format or bitrate.");

    const ext = extensionFor(blob.type || mime);
    const url = URL.createObjectURL(blob);
    const fileName = `${safeName(options.fileName)}.${ext}`;
    patch({
      status: "done",
      progress: 1,
      message: `Ready · ${formatBytes(blob.size)}`,
      resultUrl: url,
      resultName: fileName,
      resultSize: blob.size,
      mimeType: blob.type || mime,
    });

    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();

    toast.success("Export finished", { description: `${fileName} · ${formatBytes(blob.size)}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export failed";
    const isCancel = canceled.has(id);
    patch({ status: isCancel ? "canceled" : "error", message, error: isCancel ? undefined : message });
    if (isCancel) toast.info("Export canceled");
    else toast.error("Export failed", { description: message });
  } finally {
    if (raf) cancelAnimationFrame(raf);
    for (const voice of voices) {
      try {
        voice.source.stop();
        voice.source.disconnect();
        voice.gain.disconnect();
      } catch {
        /* already stopped */
      }
    }
    voices = [];
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        /* ignore */
      }
    }
    canvasStream?.getTracks().forEach((track) => track.stop());
    audioDest?.disconnect();
    canceled.delete(id);
    setOutputMuted(wasMuted);
    // Hand the video elements back to precise, paused sync.
    endMediaCapture();
    editor().setUi({ exporting: false });
    editor().setCurrentTime(Math.min(restoreTime, projectDuration(editor().project)));
  }
}


