/**
 * THE BROADCASTER — re-streams a file (or URL) to a live ingest endpoint.
 *
 * Browsers cannot open an RTMP/SRT socket, and the renderer is sandboxed with no
 * Node. This module runs in the main process and drives ffmpeg, which is the one
 * tool that already speaks every ingest protocol (RTMP/RTMPS, SRT, RTSP) and can
 * pace a file out as if it were live with `-re`.
 *
 * Security shape mirrors `media.read`: one narrow capability. This module can
 * only spawn ffmpeg pointed at a URL it was handed, read the file it was told to
 * read, and stop the children it spawned. It never logs the stream key, and the
 * status it reports carries a label and protocol — never the ingest URL.
 *
 * Degradation is explicit. No ffmpeg on PATH (or `FFMPEG_PATH`) means `probe()`
 * reports `available: false` and `start()` refuses with a clear message — the
 * same "not available rather than pretending" rule the renderer hosts follow.
 *
 * MULTI-TARGET: several pushes can run at once (the same timeline feed going to
 * YouTube *and* Facebook, or two files to two encoders). Each `start()` spawns
 * its own ffmpeg child, so one failing ingest can never take the others down, and
 * `writeChunk` fans a timeline chunk out to every live timeline session.
 */
"use strict";

const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs/promises");

/* ------------------------------------------------------------------ *
 * ffmpeg discovery
 * ------------------------------------------------------------------ */

const ffmpegPath = () => process.env.FFMPEG_PATH?.trim() || "ffmpeg";

function probeFfmpeg() {
  return new Promise((resolve) => {
    execFile(ffmpegPath(), ["-version"], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve({ available: false, version: null });
      const first = String(stdout).split("\n")[0] ?? "";
      resolve({ available: true, version: first.trim() });
    });
  });
}

let nvencSupported = null;
async function checkNvenc() {
  if (nvencSupported !== null) return nvencSupported;
  return new Promise((resolve) => {
    execFile(ffmpegPath(), [
      "-v", "error",
      "-f", "lavfi",
      "-i", "color=c=black:s=256x256:d=1",
      "-c:v", "h264_nvenc",
      "-f", "null",
      "-"
    ], { timeout: 3000 }, (error) => {
      nvencSupported = !error;
      resolve(nvencSupported);
    });
  });
}

/** `30/1` → 30, `30000/1001` → ~29.97, else null. */
function parseFrameRate(rate) {
  if (!rate) return null;
  const parts = String(rate).split("/");
  if (parts.length === 2) {
    const n = Number(parts[0]);
    const d = Number(parts[1]);
    if (Number.isFinite(n) && Number.isFinite(d) && d > 0) return n / d;
  }
  const n = Number(rate);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Probes a local file's video size + frame rate, or null when it can't. */
function probeSource(value) {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", value],
      { timeout: 6000 },
      (error, stdout) => {
        if (error) return resolve(null);
        try {
          const info = JSON.parse(stdout);
          const stream = info.streams?.[0];
          if (!stream?.width || !stream?.height) return resolve(null);
          resolve({ width: stream.width, height: stream.height, fps: parseFrameRate(stream.r_frame_rate) });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** Longest gap between keyframes in the first 12s, or null. >4s means a bad GOP. */
function probeKeyframeInterval(value) {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=flags,pts_time", "-of", "csv=p=0", "-read_intervals", "%+20", value],
      { timeout: 8000 },
      (error, stdout) => {
        if (error) return resolve(null);
        // CSV is `pts_time,flags` — the keyframe flag is 'K' in the flags column.
        const keyTimes = [];
        for (const line of String(stdout).split("\n")) {
          const parts = line.split(",");
          if (parts.length < 2) continue;
          const time = Number(parts[0]);
          if (Number.isFinite(time) && parts[1].charAt(0) === "K") keyTimes.push(time);
        }
        keyTimes.sort((a, b) => a - b);
        if (keyTimes.length === 0) return resolve(null);
        // One keyframe in the 20s window means the GOP is longer than 20s — bad.
        if (keyTimes.length === 1) return resolve(20);
        let maxGap = 0;
        for (let i = 1; i < keyTimes.length; i++) maxGap = Math.max(maxGap, keyTimes[i] - keyTimes[i - 1]);
        resolve(maxGap);
      },
    );
  });
}

/** The same bitrate ladder the renderer uses, so file streams match content size. */
function bitrateFor(height, fps) {
  const ladder =
    height >= 2160 ? { p30: 27_000_000, p60: 35_000_000 }
    : height >= 1440 ? { p30: 12_000_000, p60: 16_000_000 }
    : height >= 1080 ? { p30: 6_000_000, p60: 9_000_000 }
    : height >= 720 ? { p30: 4_000_000, p60: 6_000_000 }
    : { p30: 3_000_000, p60: 5_000_000 };
  return (fps ?? 30) >= 50 ? ladder.p60 : ladder.p30;
}

/* ------------------------------------------------------------------ *
 * The session
 * ------------------------------------------------------------------ */

/** The output muxer for a protocol. SRT is transport-agnostic → MPEG-TS. */
function muxerFor(protocol) {
  switch (protocol) {
    case "rtmp":
    case "rtmps":
      return "flv";
    case "srt":
      return "mpegts";
    case "rtsp":
      return "rtsp";
    default:
      return null; // custom — let ffmpeg infer from the URL
  }
}

/**
 * Live ingest wants a hard CBR bitrate. A bare `-b:v` is only a *target*: x264
 * freely undershoots on static or low-motion content (a title card, a logo, a
 * still) down to a few hundred Kbps — exactly the "current bitrate (431 Kbps) is
 * lower than recommended" warning. The switch that actually pins the rate is
 * `nal-hrd=cbr`, which makes x264 pad with filler NAL units up to the target
 * (`minrate` alone does nothing for x264). `maxrate` = target keeps it CBR,
 * `bufsize` is the 2-second VBV buffer, and the GOP follows `fps` so keyframes
 * land on the 2-second cadence the platform expects.
 *
 * Deliberately no `-tune zerolatency` — that flag drops B-frames and rate-control
 * lookahead to shave latency, which only matters for interactive use. A
 * pre-recorded broadcast keeps OBS's B-frames + lookahead instead, so the same
 * bitrate encodes visibly better quality.
 */
function addVideoEncoder(args, { targetBps, fps, isLive, useNvenc }) {
  const target = Number(targetBps) > 0 ? Number(targetBps) : 8_000_000;
  const bufsize = Math.round(target * 2);
  const outputFps = Number(fps) > 0 ? Math.round(Number(fps)) : 30;
  const gop = Math.round(outputFps * 2);

  if (useNvenc) {
    // Hardware-accelerated NVIDIA encoder
    args.push(
      "-c:v", "h264_nvenc",
      "-r", `${outputFps}`,
      "-preset", isLive ? "p1" : "p4", // p1 is fastest/lowest latency
      "-b:v", `${target}`,
      "-maxrate", `${target}`,
      "-bufsize", `${bufsize}`,
      "-g", `${gop}`,
      "-rc", "cbr",
      "-zerolatency", isLive ? "1" : "0",
      "-pix_fmt", "yuv420p"
    );
  } else {
    // CPU-based libx264 encoder
    args.push(
      "-c:v", "libx264",
      "-r", `${outputFps}`,
      "-preset", isLive ? "ultrafast" : "veryfast",
      "-threads", "0" // explicitly use all available CPU cores
    );
    if (isLive) {
      args.push("-tune", "zerolatency");
    }
    args.push(
      "-profile:v", "high",
      "-b:v", `${target}`,
      "-maxrate", `${target}`,
      "-bufsize", `${bufsize}`,
      "-g", `${gop}`,
      "-keyint_min", `${gop}`,
      "-sc_threshold", "0",
      "-bf", isLive ? "0" : "2",
      "-x264-params", "nal-hrd=cbr",
      "-pix_fmt", "yuv420p"
    );
  }
}

function buildArgs({ url, protocol, source, loop, transcode, videoBitrate, fps, useNvenc }) {
  const args = ["-hide_banner", "-loglevel", "info"];

  // Live ingest (YouTube, Twitch, RTMP generally) only accepts H.264 + AAC, so
  // the DEFAULT is to transcode. Stream-copy is the fast path for a source the
  // caller already knows is H.264/AAC.
  const addEncoder = (copyVideo, copyAudio) => {
    if (copyVideo) {
      args.push("-c:v", "copy");
    } else {
      addVideoEncoder(args, { targetBps: videoBitrate, fps, isLive: source.kind === "timeline", useNvenc });
    }
    if (copyAudio) {
      args.push("-c:a", "copy");
    } else {
      // 48 kHz stereo — the same rate Web Audio / Opus run at — so the pipeline
      // never resamples 48→44.1 kHz (the source of a "gi-gir-ch" digital buzz).
      args.push("-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "128k");
    }
  };

  if (source.kind === "timeline") {
    // The renderer streams a live WebM/Matroska (or fragmented mp4) over IPC into
    // stdin. No `-re`: the chunks arrive in real time already.
    const fmt = source.format === "webm" ? "matroska" : "mp4";
    args.push("-f", fmt, "-i", "pipe:0");
    if (source.copySafe) {
      // Fragmented MP4: the MediaRecorder already produced H.264 + AAC, so stream-
      // copy it straight into the push — one encode, and AAC stays AAC (no
      // Opus→AAC hop). This is the OBS-style "encode once" path.
      args.push("-c:v", "copy", "-c:a", "copy");
    } else {
      // WebM (VP8/9 + Opus) from the pipe must be transcoded to H.264/AAC.
      addEncoder(false, false);
    }
  } else {
    if (loop) args.push("-stream_loop", "-1");
    args.push("-re", "-i", source.value);
    // Audio is always transcoded to AAC (sources may be PCM/Opus); video copy
    // only when the caller is confident it is already H.264.
    addEncoder(!transcode, false);
  }

  // A bounded muxing queue is the classic fix for "Too many packets buffered for
  // output stream" — the most common RTMP/YouTube failure under `-c copy`.
  args.push("-max_muxing_queue_size", "1024");
  // Fail on a dead connection (15s read/write timeout) instead of hanging
  // forever, so the reconnect path kicks in. (`-rtmp_live` is input-only and
  // would be ignored on the output, so it is deliberately omitted.)
  args.push("-rw_timeout", "15000000");

  const muxer = muxerFor(protocol);
  if (muxer) {
    args.push("-f", muxer);
    // Live FLV is not seekable: don't let the muxer try to rewrite the
    // duration/filesize at close — that seek is exactly the "Error closing file:
    // Input/output error" thrown when the RTMP socket has already dropped.
    if (muxer === "flv") args.push("-flvflags", "no_duration_filesize");
  }
  args.push(url);
  return args;
}

/** Parse ffmpeg's status line (`frame=… time=… bitrate=… speed=…`). */
function parseProgress(line) {
  const grab = (key) => {
    const match = line.match(new RegExp(`${key}=\\s*([^\\s]+)`));
    return match ? match[1] : null;
  };
  const fps = grab("fps");
  return {
    time: grab("time"),
    bitrate: grab("bitrate"),
    speed: grab("speed"),
    fps: fps ? Number.parseFloat(fps) : null,
  };
}

/** How much stdin may back up before a push is declared stuck. */
const MAX_PIPE_BACKLOG = 16 * 1024 * 1024; // 16 MiB

/** No progress for this long means the source has stopped producing frames. */
const STALL_TIMEOUT_MS = 30_000;

/**
 * Live bitrate adaptation (the OBS "dynamically change bitrate" idea): when the
 * output runs slower than real-time, the uplink is the bottleneck, not the CPU.
 * Step the bitrate down *before* the connection drops, instead of waiting for a
 * broken pipe. `speed` is ffmpeg's `speed=Nx`; a sustained sub-1.0 streak is
 * congestion.
 */
const CONGESTION_SPEED = 0.85;
const CONGESTION_STREAK = 8;

/** Reconnect policy: how many times, how long to wait, how far to step down. */
const RECONNECT_RETRIES = 8;
const RECONNECT_DELAY_MS = 3000;
const RECONNECT_BITRATE_STEP = 0.7;
const RECONNECT_MIN_BPS = 1_000_000;

/** x264/aac print a wall of summary stats at the end; those are not the error. */
const NOISE_LINE = /Weighted P-Frames|kb\/s:|Qavg:|Conversion failed/i;
const errorLike = (line) =>
  !NOISE_LINE.test(line) &&
  /error|failed|broken pipe|connection|timed? ?out|refused|denied|invalid|malformed|unable|no such|eof|not connected|i\/o|write|network|could not|cannot|address already in use/i.test(line);

class BroadcastSession {
  constructor({ onStatus }) {
    this.onStatus = onStatus;
    this.child = null;
    this.sourceKind = null;
    this.canAdapt = false;
    this.starting = false;
    this.retryTimer = null;
    this.stallTimer = null;
    this.launchArgs = null;
    this.targetBps = 8_000_000;
    this.retries = 0;
    this.maxRetries = 0;
    this.lastErrorLine = null;
    this.tail = [];
    this.state = this.empty();
  }

  empty() {
    return {
      id: null,
      running: false,
      reconnecting: false,
      label: null,
      protocol: null,
      loop: false,
      transcode: false,
      startedAt: null,
      time: null,
      bitrate: null,
      speed: null,
      fps: null,
      error: null,
      note: null,
    };
  }

  status() {
    const uptime = this.state.startedAt ? Math.round((Date.now() - this.state.startedAt) / 1000) : 0;
    return { ...this.state, uptime, tail: this.tail };
  }

  emit() {
    this.onStatus(this.status());
  }

  /** True while a child is running, reconnecting, or still probing before spawn. */
  isActive() {
    return this.state.running || this.starting;
  }

  /** Kills the child (if any) and lands on a terminal state, then emits. */
  settle(error) {
    this.clearTimers();
    const child = this.child;
    this.child = null;
    if (child) {
      child.on("error", () => {});
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
      child.kill("SIGKILL");
    }
    this.state = { ...this.state, running: false, reconnecting: false, error: error ?? null };
    this.emit();
  }

  /** Lands on a terminal state without killing anything (the child already exited). */
  finish(error) {
    this.clearTimers();
    this.state = { ...this.state, running: false, reconnecting: false, error: error ?? (this.state.error ?? null) };
    this.emit();
  }

  clearTimers() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  async start({ id, url, protocol, source, loop, transcode, label, videoBitrate, fps, useNvenc }) {
    if (this.child) throw new Error("A broadcast is already running — stop it first.");
    if (!url || typeof url !== "string") throw new Error("No ingest URL was given.");
    if (!source) throw new Error("No source was given.");
    if (source.kind !== "timeline" && !source.value) throw new Error("No source file or URL was given.");

    // Only timeline pushes read stdin; file/URL pushes must never have a chunk
    // written at them (their stdin is never consumed and would just back up).
    this.sourceKind = source.kind;
    // Timeline pushes are bounded by the browser's render loop (which often drops
    // below 60fps), so ffmpeg's `speed` metric reflects CPU/rendering lag, not
    // network congestion. Rely on the pipe backlog to detect network drops instead.
    // For files and URLs, `-re` limits speed to 1.0x, so any network buffering
    // drops it below 0.85 and incorrectly triggers a restart from 0:00.
    this.canAdapt = false;

    // `starting` is true while the probes below run, so a stop() arriving during
    // them can cancel this start before it spawns anything.
    this.starting = true;
    try {
      const ffmpeg = await probeFfmpeg();
      if (!ffmpeg.available) {
        throw new Error("ffmpeg is not installed — set FFMPEG_PATH, or install ffmpeg, to broadcast.");
      }

      if (source.kind === "file") {
        let stat;
        try {
          stat = await fs.stat(source.value);
        } catch {
          throw new Error(`No file at "${source.value}".`);
        }
        if (!stat.isFile()) throw new Error(`"${source.value}" is not a regular file.`);
      }

      // Probe file sources so the bitrate and GOP match the content's real size and
      // frame rate (a 720p file shouldn't be pushed at a 1080p bitrate, and a 60fps
      // file needs a 2s GOP of 120 frames, not 60).
      let effectiveFps = fps;
      let effectiveBps = Number(videoBitrate) > 0 ? Number(videoBitrate) : null;
      let note = null;
      if (source.kind === "file") {
        const probed = await probeSource(source.value);
        if (probed) {
          if (!effectiveFps && probed.fps) effectiveFps = probed.fps;
          if (effectiveBps === null) effectiveBps = bitrateFor(probed.height, probed.fps ?? 30);
        }
      }

      // Stream-copying a file preserves its own keyframe interval, but YouTube
      // requires keyframes every ≤4s. If the source's GOP is longer, re-encode
      // instead so keyframes land every 2s — this is exactly the "keyframe
      // frequency is 11.3 seconds" rejection.
      let effectiveTranscode = !!transcode;
      if (source.kind === "file" && !transcode) {
        const gop = await probeKeyframeInterval(source.value);
        if (gop !== null && gop > 4) {
          effectiveTranscode = true;
          note = `source keyframes are ${gop.toFixed(1)}s apart — re-encoding to 2s keyframes`;
        }
      }

      // A stop() during the probes above must not let the spawn happen anyway.
      if (!this.starting) return this.status();

      this.launchArgs = { url, protocol, source, loop: !!loop, transcode: effectiveTranscode, label, fps: effectiveFps, useNvenc };
      this.targetBps = effectiveBps ?? 8_000_000;
      this.retries = 0;

      // Auto-reconnect:
      // Timeline has its own reconnect controller in the frontend.
      // URLs (like IP cameras) should always reconnect on drop.
      // Files should reconnect if they are looped, otherwise a drop ruins the linear playback.
      if (source.kind === "timeline") {
        this.maxRetries = 0;
      } else if (source.kind === "url") {
        this.maxRetries = RECONNECT_RETRIES;
      } else {
        this.maxRetries = loop ? RECONNECT_RETRIES : 0;
      }

      this.state = {
        ...this.empty(),
        id,
        running: true,
        label: label || "stream",
        protocol,
        loop: !!loop,
        transcode: effectiveTranscode,
        startedAt: Date.now(),
        ffmpeg: ffmpeg.version,
        note,
      };

      this.launch();
      return this.status();
    } finally {
      this.starting = false;
    }
  }

  /** Spawns ffmpeg for the current target bitrate and wires it up. */
  launch() {
    const args = buildArgs({ ...this.launchArgs, videoBitrate: this.targetBps });
    const child = spawn(ffmpegPath(), args, { stdio: ["pipe", "ignore", "pipe"] });
    this.child = child;
    if (child.stdin) {
      child.stdin.on("error", () => {
        // Ignore EPIPE errors on stdin; the child 'exit' or 'error' events will handle the teardown.
      });
    }
    this.lastErrorLine = null;
    this.tail = [];
    this.state = { ...this.state, reconnecting: false, error: null };

    // A stream that stops making progress (the source stalled or ended) reports
    // "no data" on the ingest side with no ffmpeg error at all — arm a guard so
    // it fails loudly instead of hanging silently. Armed on first progress, so a
    // slow initial connect is never mistaken for a stall.
    const armStallGuard = () => {
      if (this.stallTimer) clearTimeout(this.stallTimer);
      this.stallTimer = setTimeout(() => {
        if (this.child === child && this.state.running && !this.state.reconnecting) {
          this.handleFailure("The stream stalled — the source stopped producing frames.");
        }
      }, STALL_TIMEOUT_MS);
    };

    let buffer = "";
    let slowStreak = 0;
    child.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.search(/[\r\n]/)) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (this.child !== child) return; // a newer child has replaced this one
        if (!line) continue;
        this.tail.push(line);
        if (this.tail.length > 40) this.tail.shift();
        if (errorLike(line)) this.lastErrorLine = line;
        if (line.includes("time=")) {
          const progress = parseProgress(line);
          this.state = { ...this.state, ...progress, error: null };
          armStallGuard();
          // Live bitrate adaptation: sustained sub-real-time output means the
          // uplink is the bottleneck, so step down before the pipe breaks.
          if (this.canAdapt) {
            const speed = Number.parseFloat(progress.speed);
            // Ignore congestion for the first 10 seconds of output while x264 fills its lookahead buffer.
            const uptime = this.state.startedAt ? (Date.now() - this.state.startedAt) / 1000 : 0;
            if (Number.isFinite(speed) && speed > 0 && speed < CONGESTION_SPEED && uptime > 10) {
              slowStreak += 1;
              if (slowStreak >= CONGESTION_STREAK) {
                slowStreak = 0;
                this.stepDown("network congestion — the output can't keep up");
              }
            } else {
              slowStreak = 0;
            }
          }
          this.emit();
        }
      }
    });

    // A spawn failure is permanent (bad binary, missing path) — do not retry.
    child.on("error", (error) => {
      if (this.child !== child) return;
      this.child = null;
      this.finish(error.message);
    });

    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (code === 0 || code === null) {
        this.finish(null);
        return;
      }
      const detail = this.lastErrorLine || this.tail.filter((line) => !NOISE_LINE.test(line)).slice(-4).join(" · ");
      this.handleFailure(`ffmpeg exited with code ${code}${detail ? ` — ${detail}` : ""}.`);
    });

    this.emit();
  }

  /**
   * Lower the bitrate ~20% and reconnect. Used on a non-zero exit AND on live
   * congestion (the child is still running then, so it is killed first).
   */
  stepDown(reason) {
    if (this.retries >= this.maxRetries) {
      // Giving up must kill the child too: `stepDown` is also reached with the
      // child still alive (a stall or congestion), and `finish` would leave that
      // ffmpeg running with no one able to reach it — an orphaned push.
      this.settle(reason);
      return;
    }
    this.retries += 1;
    this.targetBps = Math.max(RECONNECT_MIN_BPS, Math.round(this.targetBps * RECONNECT_BITRATE_STEP));
    this.state = {
      ...this.state,
      reconnecting: true,
      error: `${reason} — lowering bitrate to ${Math.round(this.targetBps / 1000)} Kbps (attempt ${this.retries}/${this.maxRetries})`,
    };
    this.emit();
    // Kill the child, marking it stale first so its own exit handler is a no-op.
    const child = this.child;
    this.child = null;
    if (child) {
      child.on("error", () => {});
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
      child.kill("SIGKILL");
    }
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.retryTimer = setTimeout(() => this.launch(), RECONNECT_DELAY_MS);
  }

  /** A non-zero exit: reconnect (stepping the bitrate down) or give up. */
  handleFailure(error) {
    this.stepDown(error);
  }

  /** Write a MediaRecorder chunk to ffmpeg's stdin (timeline broadcasts). */
  writeChunk(chunk) {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) return;
    try {
      const ok = child.stdin.write(Buffer.from(chunk));
      // If the ingest cannot keep up, stdin backs up without bound — that is how
      // a live push quietly OOMs or freezes the whole app. Bound it and fail
      // loudly instead of pretending the stream is healthy.
      if (!ok && child.stdin.writableLength > MAX_PIPE_BACKLOG) {
        this.settle("The ingest is not keeping up — the stream was stopped to protect the app.");
      }
    } catch {
      /* a closed pipe — the child is gone */
    }
  }

  stop() {
    // Always settle: even between reconnect attempts (`child` is null there), a
    // stop must cancel the pending retry timer, not let it relaunch a stream the
    // user just asked to stop. Clearing `starting` also cancels an in-flight
    // `start()` that is still probing, so it never spawns after a stop.
    this.starting = false;
    this.settle(null);
    return this.status();
  }
}

/* ------------------------------------------------------------------ *
 * The manager (one per main process)
 * ------------------------------------------------------------------ */

let nextId = 1;

/** Build the singleton. `onStatus` is wired to the renderer by `main.cjs`. */
function createBroadcast(onStatus) {
  const sessions = new Map();

  const list = () => [...sessions.values()].map((session) => session.status());

  return {
    probe: probeFfmpeg,

    status: () => list(),

    start: async (payload) => {
      // A finished session lingers so its error stays readable; starting a fresh
      // run clears the previous batch out of the way.
      for (const [id, session] of sessions) {
        if (!session.isActive()) sessions.delete(id);
      }

      const useNvenc = await checkNvenc();
      const id = `bc-${nextId++}`;
      const session = new BroadcastSession({ onStatus });
      // Register before the awaited start so a stop() that lands during the (up
      // to ~20s) probe phase can still find and cancel it — otherwise the push
      // spawns after the user has already stopped.
      sessions.set(id, session);
      try {
        return await session.start({ ...(payload ?? {}), id, useNvenc });
      } catch (error) {
        sessions.delete(id);
        throw error;
      }
    },

    stop: (id) => {
      if (id) {
        const session = sessions.get(id);
        if (session && session.isActive()) session.stop();
        // Do not delete it here. Let start() clean up finished sessions so the error stays visible.
      } else {
        for (const session of sessions.values()) {
          if (session.isActive()) session.stop();
        }
      }
      return list();
    },

    /** Fan a timeline chunk out to every live timeline session. */
    writeChunk: (chunk) => {
      for (const session of sessions.values()) {
        if (session.sourceKind === "timeline" && session.status().running) session.writeChunk(chunk);
      }
    },
  };
}

module.exports = { createBroadcast, probeFfmpeg };
