/**
 * THE TIMELINE BROADCAST ENGINE.
 *
 * Broadcast the COMPOSED timeline — every layer, headline, sticker, effect and
 * transition — as a live stream. This is `runExportJob` pointed at a network
 * socket instead of a file: it drives the playhead, draws each frame through the
 * same compositor the preview uses, mixes the audio, and feeds a MediaRecorder
 * whose chunks are handed back to the caller (which forwards them to ffmpeg over
 * IPC). Where export stops at the end and downloads a Blob, this loops the
 * playhead and keeps producing chunks until stopped.
 *
 * "Broadcast specific components" is `hiddenTrackIds`: layers on a hidden row are
 * filtered out of BOTH the frame and the audio plan, so a headline row can be
 * dropped from air without mutating the project.
 */
import { drawFrame } from "@/lib/compositor";
import { planExportedVoices, preferredStreamMime, startExportedVoices, type ScheduledVoice } from "@/lib/exporter";
import { resumeAudioContext } from "@/lib/media";
import { beginMediaCapture, endMediaCapture, isOutputMuted, setOutputMuted } from "@/lib/playback";
import { orderedLayers, projectDuration } from "@/lib/project";
import { recommendStreamBitrate } from "@/lib/broadcast";
import { editor, editorStore } from "@/store/editorStore";

const LEAD = 0.06;
/** How often the store's playhead (and the React panels) sync during a live push. */
const STORE_SYNC_MS = 120;

export interface TimelineBroadcastOptions {
  loop: boolean;
  /** Rows to drop from the broadcast ("specific components" off). */
  hiddenTrackIds?: Set<string>;
  /** Target video bitrate in bps. Omit for the resolution-aware "auto" value. */
  videoBitrate?: number;
  onChunk: (chunk: Uint8Array) => void;
  onError: (message: string) => void;
  /** Called exactly once when the capture ends, however it ended. */
  onStopped?: () => void;
}

export interface TimelineBroadcastSession {
  stop: () => void;
}

export function startTimelineBroadcast(options: TimelineBroadcastOptions): TimelineBroadcastSession {
  const mime = preferredStreamMime();
  if (!mime) {
    throw new Error("This browser cannot record a live stream (no MediaRecorder MP4/WebM support).");
  }

  const wasMuted = isOutputMuted();
  const restoreTime = editorStore.getState().currentTime;

  let recorder: MediaRecorder | null = null;
  let canvasStream: MediaStream | null = null;
  let audioDest: MediaStreamAudioDestinationNode | null = null;
  let mix: GainNode | null = null;
  let voices: ScheduledVoice[] = [];
  let raf = 0;
  let stopped = false;

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    try {
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
      setOutputMuted(wasMuted);
      endMediaCapture();
      editor().setCurrentTime(Math.min(restoreTime, projectDuration(editor().project)));
    } finally {
      // `onStopped` stops ffmpeg — it must run even if a cleanup step threw,
      // otherwise the push keeps going after the renderer stops feeding it.
      options.onStopped?.();
    }
  };

  const snapshot = editorStore.getState();
  const project = snapshot.project;
  const projectW = project.settings.width;
  const projectH = project.settings.height;
  const fps = project.settings.fps;
  const duration = Math.max(0.5, projectDuration(project));
  const hiddenTracks = options.hiddenTrackIds;

  const visibleLayers = () =>
    orderedLayers(editor().project).filter(
      (layer) => !layer.hidden && (!hiddenTracks || !hiddenTracks.has(layer.trackId)),
    );

  const frame = document.createElement("canvas");
  frame.width = projectW;
  frame.height = projectH;
  const fctx = frame.getContext("2d", { alpha: false });
  if (!fctx) {
    // Throwing here (instead of returning a dead session) lets the controller
    // tear the already-started ffmpeg sinks down before the error surfaces.
    throw new Error("The browser refused to create a render surface.");
  }

  const drawAt = (time: number) => {
    const live = editorStore.getState();
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    drawFrame({ ctx: fctx, settings: live.project.settings, layers: visibleLayers(), assets: live.assets, time });
  };

  if (!frame.captureStream) {
    throw new Error("This browser cannot capture the canvas for streaming.");
  }

  const run = async () => {
    let audioCtx: AudioContext;
    let plans: Awaited<ReturnType<typeof planExportedVoices>> = [];
    try {
      audioCtx = await resumeAudioContext();
      audioDest = audioCtx.createMediaStreamDestination();
      mix = audioCtx.createGain();
      mix.gain.value = 1;
      mix.connect(audioDest);
      plans = await planExportedVoices(project, snapshot.assets, 0, duration, hiddenTracks);
    } catch (error) {
      options.onError(error instanceof Error ? error.message : "Audio setup failed.");
      cleanup();
      return;
    }

    // A stop during the (async) audio setup must not let the capture start anyway.
    if (stopped) return;

    canvasStream = frame.captureStream(fps);
    const tracks = [...canvasStream.getVideoTracks()];
    if (audioDest) tracks.push(...audioDest.stream.getAudioTracks());
    const combined = new MediaStream(tracks);

    // The capture and the ffmpeg re-encode share one target bitrate (the caller
    // passes the same number to both), so the two stages don't fight. Auto is
    // resolution- and fps-aware, not a flat 5 Mbps that YouTube flags as low.
    const videoBits = recommendStreamBitrate(projectW, projectH, fps, options.videoBitrate).video;

    try {
      recorder = new MediaRecorder(combined, {
        mimeType: mime.mime,
        videoBitsPerSecond: videoBits,
        audioBitsPerSecond: 192_000,
      });
    } catch {
      recorder = new MediaRecorder(combined, { videoBitsPerSecond: videoBits, audioBitsPerSecond: 192_000 });
    }

    // Preserve chunk order: each Blob's bytes resolve in a chained promise.
    // A rejection is caught inside the chain — one failed arrayBuffer() must not
    // permanently reject the chain and silently starve ffmpeg.
    let chain: Promise<void> = Promise.resolve();
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      chain = chain
        .then(async () => {
          const buffer = new Uint8Array(await event.data.arrayBuffer());
          if (!stopped) options.onChunk(buffer);
        })
        .catch((error) => {
          options.onError(`Chunk delivery failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    };
    recorder.start(250);

    setOutputMuted(true);
    beginMediaCapture();

    const anchor = performance.now();
    const lead = plans.length ? LEAD : 0;
    const wallStart = anchor + lead * 1000;
    const audioClock0 = audioCtx.currentTime + lead;
    let scheduledLoops = 0;

    const scheduleLoop = (n: number) => {
      while (scheduledLoops <= n && mix) {
        voices.push(...startExportedVoices(plans, mix, audioClock0 + scheduledLoops * duration));
        scheduledLoops += 1;
      }
    };
    scheduleLoop(0);

    let lastSyncAt = 0;
    const tick = () => {
      if (stopped) return;
      // In Electron with backgroundThrottling: false, requestAnimationFrame continues
      // running at full speed even when the window is minimized or hidden.
      // Therefore, we do not need to stop the stream when document.hidden is true.
      const elapsed = (performance.now() - wallStart) / 1000;
      let time: number;
      if (options.loop) {
        const loopIndex = Math.floor(Math.max(0, elapsed) / duration);
        scheduleLoop(loopIndex);
        time = Math.max(0, elapsed) % duration;
      } else {
        if (elapsed >= duration) {
          cleanup();
          return;
        }
        time = Math.max(0, elapsed);
      }
      drawAt(time);
      // The composed frame above is the thing actually going on air; the store's
      // playhead only exists so the preview and panels follow along. Driving the
      // whole React tree at 60fps while also composing + encoding is what made a
      // live push laggy, so the store syncs at a modest cadence instead.
      const now = performance.now();
      if (now - lastSyncAt >= STORE_SYNC_MS) {
        lastSyncAt = now;
        editor().setCurrentTime(Math.min(time, duration));
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  };

  void run();
  return { stop: cleanup };
}
