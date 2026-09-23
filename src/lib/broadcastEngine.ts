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
import { editor, editorStore } from "@/store/editorStore";

const LEAD = 0.06;
/** Live pushes want a steady, modest bitrate — not the 12 Mbps of an archive. */
const STREAM_VIDEO_BPS = 5_000_000;

export interface TimelineBroadcastOptions {
  loop: boolean;
  /** Rows to drop from the broadcast ("specific components" off). */
  hiddenTrackIds?: Set<string>;
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
    options.onError("This browser cannot record a live stream (no MediaRecorder MP4/WebM support).");
    return { stop: () => {} };
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
    options.onError("The browser refused to create a render surface.");
    return { stop: cleanup };
  }

  const drawAt = (time: number) => {
    const live = editorStore.getState();
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    drawFrame({ ctx: fctx, settings: live.project.settings, layers: visibleLayers(), assets: live.assets, time });
  };

  if (!frame.captureStream) {
    options.onError("This browser cannot capture the canvas for streaming.");
    return { stop: cleanup };
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

    try {
      recorder = new MediaRecorder(combined, {
        mimeType: mime.mime,
        videoBitsPerSecond: STREAM_VIDEO_BPS,
        audioBitsPerSecond: 192_000,
      });
    } catch {
      recorder = new MediaRecorder(combined, { videoBitsPerSecond: STREAM_VIDEO_BPS, audioBitsPerSecond: 192_000 });
    }

    // Preserve chunk order: each Blob's bytes resolve in a chained promise.
    let chain: Promise<void> = Promise.resolve();
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      chain = chain.then(async () => {
        const buffer = new Uint8Array(await event.data.arrayBuffer());
        if (!stopped) options.onChunk(buffer);
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

    const tick = () => {
      if (stopped) return;
      if (document.hidden) {
        options.onError("Streaming stopped: the tab went to the background.");
        cleanup();
        return;
      }
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
      editor().setCurrentTime(Math.min(time, duration));
      drawAt(time);
      raf = requestAnimationFrame(tick);
    };
    tick();
  };

  void run();
  return { stop: cleanup };
}
