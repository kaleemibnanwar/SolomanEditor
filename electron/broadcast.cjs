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
 * read, and stop the child it spawned. It never logs the stream key, and the
 * status it reports carries a label and protocol — never the ingest URL.
 *
 * Degradation is explicit. No ffmpeg on PATH (or `FFMPEG_PATH`) means `probe()`
 * reports `available: false` and `start()` refuses with a clear message — the
 * same "not available rather than pretending" rule the renderer hosts follow.
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

function buildArgs({ url, protocol, source, loop, transcode }) {
  const args = ["-hide_banner", "-loglevel", "info"];

  if (source.kind === "timeline") {
    // The renderer streams a fragmented mp4/webm over IPC into stdin. No `-re`:
    // the chunks arrive in real time already, and the container timestamps pace
    // the RTMP push.
    const fmt = source.format === "webm" ? "matroska" : "mp4";
    args.push("-f", fmt, "-i", "pipe:0");
    const copySafe = source.copySafe !== false && !transcode;
    if (copySafe) {
      args.push("-c:v", "copy", "-c:a", "copy");
    } else {
      args.push("-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-g", "60", "-pix_fmt", "yuv420p");
      args.push("-c:a", "aac", "-b:a", "160k");
    }
  } else {
    if (loop) args.push("-stream_loop", "-1");
    args.push("-re", "-i", source.value);

    if (transcode) {
      // Guaranteed H.264 + AAC, so any source plays on any platform. Slower.
      args.push("-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-g", "60", "-pix_fmt", "yuv420p");
      args.push("-c:a", "aac", "-b:a", "160k");
    } else {
      // Stream-copy the video, transcode only the audio to AAC for compatibility.
      args.push("-c:v", "copy", "-c:a", "aac", "-b:a", "160k");
    }
  }

  const muxer = muxerFor(protocol);
  if (muxer) args.push("-f", muxer);
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

class BroadcastSession {
  constructor({ onStatus }) {
    this.onStatus = onStatus;
    this.child = null;
    this.state = this.empty();
  }

  empty() {
    return {
      running: false,
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
    };
  }

  status() {
    const uptime = this.state.startedAt ? Math.round((Date.now() - this.state.startedAt) / 1000) : 0;
    return { ...this.state, uptime };
  }

  emit() {
    this.onStatus(this.status());
  }

  async start({ url, protocol, source, loop, transcode, label }) {
    if (this.child) throw new Error("A broadcast is already running — stop it first.");
    if (!url || typeof url !== "string") throw new Error("No ingest URL was given.");
    if (!source) throw new Error("No source was given.");
    if (source.kind !== "timeline" && !source.value) throw new Error("No source file or URL was given.");

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

    const args = buildArgs({ url, protocol, source, loop: !!loop, transcode: !!transcode });

    this.state = {
      ...this.empty(),
      running: true,
      label: label || "stream",
      protocol,
      loop: !!loop,
      transcode: !!transcode,
      startedAt: Date.now(),
      ffmpeg: ffmpeg.version,
    };

    const child = spawn(ffmpegPath(), args, { stdio: ["pipe", "ignore", "pipe"] });
    this.child = child;

    let buffer = "";
    child.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (this.child !== child) return; // a newer session has replaced this one
        if (line.includes("time=")) {
          const progress = parseProgress(line);
          this.state = { ...this.state, ...progress, error: null };
          this.emit();
        }
      }
    });

    const finish = (error) => {
      if (this.child !== child) return; // stale child — a new broadcast owns the session
      this.child = null;
      this.state = {
        ...this.state,
        running: false,
        error: error ?? (this.state.error ?? null),
      };
      this.emit();
    };
    child.on("error", (error) => finish(error.message));
    child.on("exit", (code) => {
      if (this.child !== child) return;
      if (code !== 0 && code !== null) finish(`ffmpeg exited with code ${code}.`);
      else finish(null);
    });

    this.emit();
  }

  /** Write a MediaRecorder chunk to ffmpeg's stdin (timeline broadcasts). */
  writeChunk(chunk) {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) return;
    try {
      child.stdin.write(Buffer.from(chunk));
    } catch {
      /* a closed pipe — the child is gone */
    }
  }

  stop() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.on("error", () => {});
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    child.kill("SIGKILL");
    this.state = { ...this.state, running: false, error: null };
    this.emit();
  }
}

/** Build the singleton. `onStatus` is wired to the renderer by `main.cjs`. */
function createBroadcast(onStatus) {
  const session = new BroadcastSession({ onStatus });
  return {
    probe: probeFfmpeg,
    status: () => session.status(),
    start: (payload) => session.start(payload ?? {}),
    stop: () => session.stop(),
    writeChunk: (chunk) => session.writeChunk(chunk),
  };
}

module.exports = { createBroadcast, probeFfmpeg };
