/**
 * Playback glue: keeps <video> elements on the playhead and schedules audio
 * buffers through the Web Audio graph.
 *
 * Audio is scheduled (not polled) so the mix stays locked to the timeline rather
 * than to frame timing, and gain envelopes are baked from the same
 * `evaluateGain` used by the exporter.
 */
import { evaluateGain } from "@/lib/anim";
import { getAudioContext, resumeAudioContext } from "@/lib/media";
import { layerEnd, orderedLayers } from "@/lib/project";
import type { Asset, Layer, Project } from "@/types/editor";

const DRIFT_LIMIT = 0.3;

/* ------------------------------------------------------------------ *
 * Capture mode (export)
 * ------------------------------------------------------------------ */

/**
 * While exporting, the playhead is driven by a wall clock rather than by these
 * elements, so an exact seek every frame would fight the very playback it is
 * sampling — the element lands a frame late, gets re-seeked, and never fully
 * decodes, which is how a video ends up captured as a placeholder. Capture mode
 * therefore lets the elements play and only corrects them, with one addition the
 * preview does not need: a stall guard, because an element that has stopped
 * advancing would otherwise be captured as a frozen frame.
 */
let capturing = false;

interface CaptureTrack {
  seen: number;
  changedAt: number;
  nudgedAt: number;
}

const captureTracks = new Map<HTMLVideoElement, CaptureTrack>();

/** Enables capture-mode video sync for an export. */
export function beginMediaCapture() {
  capturing = true;
  captureTracks.clear();
}

/** Restores precise (paused) sync and stops every element. */
export function endMediaCapture() {
  capturing = false;
  captureTracks.clear();
}

/** Whether an export/broadcast capture is in progress (drives capture-mode sync). */
export const isCapturing = () => capturing;

function syncCaptureVideo(el: HTMLVideoElement, desired: number) {
  const now = performance.now();
  let track = captureTracks.get(el);
  if (!track) {
    track = { seen: el.currentTime, changedAt: now, nudgedAt: 0 };
    captureTracks.set(el, track);
  }

  if (Math.abs(el.currentTime - track.seen) > 0.004) {
    track.seen = el.currentTime;
    track.changedAt = now;
  }

  const drift = Math.abs(el.currentTime - desired);
  const stalled = el.readyState >= 2 && now - track.changedAt > 400;
  if ((drift > DRIFT_LIMIT || stalled) && now - track.nudgedAt > 240 && Number.isFinite(desired)) {
    try {
      el.currentTime = desired;
      track.seen = desired;
      track.changedAt = now;
      track.nudgedAt = now;
    } catch {
      /* seeking before metadata — the next frame retries */
    }
  }

  // Attempt to play even before the element reports current data: a paused
  // element that has not decoded yet stays blank otherwise, and `play()` simply
  // resolves once it has. Without this an unready clip at export start never
  // starts decoding and is captured as a placeholder for the whole run.
  if (el.paused) void el.play().catch(() => undefined);
}

/* ------------------------------------------------------------------ *
 * Output mute (shared by the video elements and the audio master gain)
 * ------------------------------------------------------------------ */

let muted = false;
let masterGain: GainNode | null = null;

export function setOutputMuted(value: boolean) {
  muted = value;
  if (masterGain) masterGain.gain.value = value ? 0 : 1;
}

export const isOutputMuted = () => muted;

/* ------------------------------------------------------------------ *
 * Video element sync
 * ------------------------------------------------------------------ */

/**
 * Aligns every video layer's element with `time`.
 * While playing we only correct large drift to avoid stutter; while paused we
 * seek precisely so scrubbing shows the right frame.
 */
export function syncVideoLayers(
  project: Project,
  assets: Record<string, Asset>,
  time: number,
  isPlaying: boolean,
  lastSeekRef?: { current: number },
) {
  for (const layer of orderedLayers(project)) {
    if (layer.type !== "video" || !layer.assetId) continue;
    const asset = assets[layer.assetId];
    const el = asset?.el;
    if (!(el instanceof HTMLVideoElement)) continue;

    const visible = !layer.hidden && time >= layer.startTime - 0.02 && time < layerEnd(layer);
    const gain = visible ? evaluateGain(layer, time - layer.startTime) : 0;
    const volume = Math.max(0, Math.min(1, gain));

    if (!visible) {
      if (!el.paused) el.pause();
      continue;
    }

    const desired = Math.min(
      layer.inPoint + Math.max(0, time - layer.startTime),
      Math.max(0, (asset.duration ?? el.duration ?? 0) - 0.05),
    );

    const drift = Math.abs(el.currentTime - desired);
    if (capturing) {
      syncCaptureVideo(el, desired);
    } else {
      const shouldSeek = isPlaying
        ? drift > DRIFT_LIMIT && (!lastSeekRef || performance.now() - lastSeekRef.current > 240)
        : drift > 1 / 90;
      if (shouldSeek && Number.isFinite(desired)) {
        try {
          el.currentTime = desired;
          if (lastSeekRef) lastSeekRef.current = performance.now();
        } catch {
          /* seeking before metadata — next frame will retry */
        }
      }
      if (isPlaying && el.paused && el.readyState >= 2) {
        void el.play().catch(() => undefined);
      }
      if (!isPlaying && !el.paused) el.pause();
    }
    el.volume = muted ? 0 : volume;
    el.muted = muted || volume === 0;
  }
}

/** Pauses every media element (used when playback stops or export takes over). */
export function pauseAllMedia(assets: Record<string, Asset>) {
  for (const asset of Object.values(assets)) {
    const el = asset.el;
    if (el instanceof HTMLVideoElement && !el.paused) el.pause();
  }
}

/* ------------------------------------------------------------------ *
 * Audio scheduling
 * ------------------------------------------------------------------ */

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

const GAIN_STEP = 0.05;

/** Bakes a sampled gain envelope from the layer's keyframed volume + fades. */
export function scheduleGain(
  param: AudioParam,
  layer: Layer,
  startLocal: number,
  duration: number,
  when: number,
) {
  const steps = Math.max(2, Math.min(600, Math.round(duration / GAIN_STEP)));
  for (let i = 0; i <= steps; i++) {
    const lt = startLocal + (duration * i) / steps;
    const value = Math.max(0, evaluateGain(layer, lt));
    param.setValueAtTime(value, when + (duration * i) / steps);
  }
  param.setValueAtTime(0, when + duration + 0.001);
}

export class AudioScheduler {
  private voices: Voice[] = [];
  private master: GainNode | null = null;
  private scheduled = false;

  get isActive() {
    return this.scheduled;
  }

  /** (Re)schedules every audio layer relative to `time` seconds on the timeline. */
  start(project: Project, assets: Record<string, Asset>, time: number) {
    this.stop();
    const ctx = getAudioContext();
    void resumeAudioContext();
    if (!this.master) {
      this.master = ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(ctx.destination);
    }
    masterGain = this.master;
    this.master.gain.value = muted ? 0 : 1;

    const base = ctx.currentTime + 0.08;
    for (const layer of orderedLayers(project)) {
      if (layer.type !== "audio" || !layer.assetId || layer.hidden) continue;
      const buffer = assets[layer.assetId]?.audioBuffer;
      if (!buffer) continue;
      const end = layerEnd(layer);
      if (end <= time || layer.startTime >= time + 3600) continue;

      const elapsed = Math.max(0, time - layer.startTime);
      const offset = layer.inPoint + elapsed;
      const duration = layer.duration - elapsed;
      if (duration <= 0.02) continue;
      if (offset >= buffer.duration - 0.01) continue;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain).connect(this.master);

      const when = base + Math.max(0, layer.startTime - time);
      scheduleGain(gain.gain, layer, elapsed, duration, when);
      try {
        source.start(when, offset, Math.min(duration, buffer.duration - offset));
        this.voices.push({ source, gain });
      } catch {
        /* offset outside the buffer — skip this voice */
      }
    }
    this.scheduled = true;
  }

  stop() {
    for (const voice of this.voices) {
      try {
        voice.source.onended = null;
        voice.source.stop();
      } catch {
        /* already stopped */
      }
      try {
        voice.source.disconnect();
        voice.gain.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.voices = [];
    this.scheduled = false;
  }
}
