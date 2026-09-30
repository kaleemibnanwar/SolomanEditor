/**
 * THE BROADCAST STUDIO — a separate mode from the editor.
 *
 * Destinations on the left (saved RTMP/SRT configs); a list of independent
 * STREAMS on the right. Each stream is its own (source → destinations) pair, so
 * several can run at once: one video file to YouTube + Facebook, another to a
 * second channel and a hardware encoder, the live timeline to a third — all
 * simultaneous. A stream's destinations are ticked per-stream; starting one does
 * not disturb the others, and each is stoppable on its own.
 *
 * The composed timeline is a special case: there is one editor, so at most one
 * timeline stream runs at a time, and the live Stage + Timeline are shown beneath
 * the list so the piece stays editable while it is on air.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  FileVideo,
  Film,
  KeyRound,
  Link2,
  MonitorPlay,
  Play,
  Plus,
  Radio,
  Server,
  Square,
  Trash2,
  Wifi,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import Stage from "@/components/editor/Stage";
import Timeline from "@/components/editor/Timeline";
import {
  PLATFORM_DEFAULTS,
  STREAM_PLATFORMS,
  STREAM_PROTOCOLS,
  deleteStreamConfig,
  listStreamConfigs,
  saveStreamConfig,
  type StreamConfig,
  type StreamProtocol,
} from "@/lib/broadcast";
import { startSourcePush, startTimelinePush, stopTimelinePush, setTimelineSessionsListener } from "@/lib/broadcastController";
import { broadcastBridge, subscribeBroadcastStatus, type BroadcastStatus } from "@/lib/broadcastHost";
import { uid } from "@/lib/time";
import { cn } from "@/lib/utils";

type SourceKind = "file" | "url" | "timeline";

/** A local draft of one (source → destinations) broadcast, before it is started. */
interface StreamDraft {
  id: string;
  sourceKind: SourceKind;
  sourceValue: string;
  configIds: string[];
  loop: boolean;
  transcode: boolean;
  /** Target bitrate in Mbps as typed; "" = auto. */
  bitrate: string;
}

const SOURCE_OPTIONS: { kind: SourceKind; label: string; icon: ReactNode }[] = [
  { kind: "file", label: "File", icon: <FileVideo className="h-3.5 w-3.5" /> },
  { kind: "url", label: "URL", icon: <Link2 className="h-3.5 w-3.5" /> },
  { kind: "timeline", label: "Timeline", icon: <Film className="h-3.5 w-3.5" /> },
];

const newStream = (): StreamDraft => ({
  id: uid("stream"),
  sourceKind: "file",
  sourceValue: "",
  configIds: [],
  loop: true,
  transcode: true,
  bitrate: "",
});

let cachedStreams: StreamDraft[] = [];
let cachedStreamSessions: Record<string, string[]> = {};

export default function BroadcastStudio() {
  const [configs, setConfigs] = useState<StreamConfig[]>([]);
  const [streams, setStreams] = useState<StreamDraft[]>(cachedStreams);
  const [sessionsById, setSessionsById] = useState<Record<string, BroadcastStatus>>({});
  const [streamSessions, setStreamSessions] = useState<Record<string, string[]>>(cachedStreamSessions);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [ffmpeg, setFfmpeg] = useState<{ available: boolean; version: string | null }>({ available: false, version: null });
  const [destDialog, setDestDialog] = useState<{ open: boolean; id: string | null }>({ open: false, id: null });
  const [showEditor, setShowEditor] = useState(false);

  useEffect(() => {
    cachedStreams = streams;
  }, [streams]);

  useEffect(() => {
    cachedStreamSessions = streamSessions;
  }, [streamSessions]);

  const bridge = useMemo(() => broadcastBridge(), []);

  /** The timeline listener below is registered once; it reads this instead of a
   *  stale `streams` closure, so it always names the current timeline stream. */
  const streamsRef = useRef(streams);
  useEffect(() => {
    streamsRef.current = streams;
  }, [streams]);

  const reload = async () => setConfigs(await listStreamConfigs());

  useEffect(() => {
    void reload();
    const unsubscribe = subscribeBroadcastStatus((status) => {
      if (!status.id) return;
      setSessionsById((prev) => ({ ...prev, [status.id as string]: status }));
    });
    setTimelineSessionsListener((ids) => {
      setStreamSessions((prev) => {
        const streamId = streamsRef.current.find((s) => s.sourceKind === "timeline")?.id;
        if (!streamId) return prev;
        return { ...prev, [streamId]: ids };
      });
    });
    void bridge?.probe().then(setFfmpeg).catch(() => {});
    return () => {
      unsubscribe();
      setTimelineSessionsListener(null);
    };
    // `streams` deliberately not a dependency: editing a draft must not re-list
    // configs, re-subscribe to status, or re-probe ffmpeg on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  const isStreamLive = (streamId: string): boolean =>
    (streamSessions[streamId] ?? []).some((sid) => sessionsById[sid]?.running);

  const timelineLive = streams.some((s) => s.sourceKind === "timeline" && isStreamLive(s.id));
  const hasTimelineStream = streams.some((s) => s.sourceKind === "timeline");

  const sessionsFor = (streamId: string): BroadcastStatus[] =>
    (streamSessions[streamId] ?? [])
      .map((sid) => sessionsById[sid])
      .filter((s): s is BroadcastStatus => !!s);

  const setBusy = (streamId: string, on: boolean) =>
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(streamId);
      else next.delete(streamId);
      return next;
    });

  const updateStream = (streamId: string, patch: Partial<StreamDraft>) =>
    setStreams((prev) => prev.map((s) => (s.id === streamId ? { ...s, ...patch } : s)));

  const toggleDest = (streamId: string, configId: string) =>
    setStreams((prev) =>
      prev.map((s) => {
        if (s.id !== streamId) return s;
        const has = s.configIds.includes(configId);
        return { ...s, configIds: has ? s.configIds.filter((id) => id !== configId) : [...s.configIds, configId] };
      }),
    );

  const removeStream = (streamId: string) => {
    if (isStreamLive(streamId)) return;
    setStreams((prev) => prev.filter((s) => s.id !== streamId));
  };

  const bitrateBps = (value: string): number | undefined => {
    if (!value.trim()) return undefined;
    const n = Number.parseFloat(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 1_000_000) : undefined;
  };

  const startStream = async (streamId: string) => {
    const stream = streams.find((s) => s.id === streamId);
    if (!stream || !bridge) return;
    if (!stream.configIds.length) {
      setErrors((prev) => ({ ...prev, [streamId]: "Tick at least one destination." }));
      return;
    }
    if (stream.sourceKind !== "timeline" && !stream.sourceValue.trim()) {
      setErrors((prev) => ({ ...prev, [streamId]: stream.sourceKind === "file" ? "Give a file path." : "Give a URL." }));
      return;
    }

    setErrors((prev) => ({ ...prev, [streamId]: "" }));
    setBusy(streamId, true);
    try {
      const bps = bitrateBps(stream.bitrate);
      let sessionIds: string[];
      if (stream.sourceKind === "timeline") {
        const result = await startTimelinePush(stream.configIds, {
          loop: stream.loop,
          transcode: stream.transcode,
          videoBitrate: bps,
        });
        sessionIds = result.started.map((t) => t.sessionId).filter(Boolean);
        setShowEditor(true);
      } else {
        const statuses = await startSourcePush(
          stream.configIds,
          { kind: stream.sourceKind, value: stream.sourceValue },
          { loop: stream.loop, transcode: stream.transcode, videoBitrate: bps },
        );
        sessionIds = statuses.map((s) => s.id).filter((id): id is string => !!id);
      }
      // A re-start replaces this stream's previous sessions; drop the stale ones.
      const oldIds = streamSessions[streamId] ?? [];
      if (oldIds.length) {
        setSessionsById((prev) => {
          const next = { ...prev };
          for (const sid of oldIds) delete next[sid];
          return next;
        });
      }
      setStreamSessions((prev) => ({ ...prev, [streamId]: sessionIds }));
    } catch (error) {
      setErrors((prev) => ({ ...prev, [streamId]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(streamId, false);
    }
  };

  const stopStream = async (streamId: string) => {
    const stream = streams.find((s) => s.id === streamId);
    if (!stream) return;
    setBusy(streamId, true);
    try {
      if (stream.sourceKind === "timeline") {
        await stopTimelinePush();
      } else if (bridge) {
        const ids = streamSessions[streamId] ?? [];
        await Promise.all(ids.map((id) => bridge.stop(id)));
      }
      const done = streamSessions[streamId] ?? [];
      setStreamSessions((prev) => {
        const next = { ...prev };
        delete next[streamId];
        return next;
      });
      setSessionsById((prev) => {
        const next = { ...prev };
        for (const sid of done) delete next[sid];
        return next;
      });
    } catch (error) {
      setErrors((prev) => ({ ...prev, [streamId]: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(streamId, false);
    }
  };

  const stopAll = async () => {
    const liveStreams = streams.filter((s) => isStreamLive(s.id));
    await Promise.all(liveStreams.map((s) => stopStream(s.id)));
  };

  const anyLive = streams.some((s) => isStreamLive(s.id));

  const openEditDest = (id: string) => setDestDialog({ open: true, id });
  const openNewDest = () => setDestDialog({ open: true, id: null });

  return (
    <div className="flex min-h-0 flex-1">
      <DestinationsRail configs={configs} onAdd={openNewDest} onEdit={openEditDest} />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-km-border bg-km-panel px-4 py-2.5">
          <Radio className={cn("h-4 w-4 shrink-0", anyLive ? "animate-pulse text-red-400" : "text-km-dim")} />
          <div className="min-w-0">
            <p className="truncate text-[12.5px] font-medium text-km-text">Streams</p>
            <p className="truncate text-[10px] text-km-faint">
              {anyLive ? "Running — each stream is stoppable on its own" : "One source per stream, any destinations you tick"}
            </p>
          </div>

          <div className="ml-auto flex items-center gap-3">
            {hasTimelineStream && (
              <Button size="sm" variant="ghost" onClick={() => setShowEditor((v) => !v)} className="h-7 gap-1.5 px-2.5 text-[11px] text-km-dim hover:bg-km-raised hover:text-km-text">
                <MonitorPlay className="h-3.5 w-3.5" />
                {showEditor ? "Hide editor" : "Editor"}
              </Button>
            )}
            <span className={cn("flex items-center gap-1 text-[10px]", ffmpeg.available ? "text-km-faint" : "text-amber-400")}>
              <Wifi className="h-3 w-3" />
              {ffmpeg.available ? "" : "ffmpeg"}
            </span>
            {anyLive ? (
              <Button size="sm" onClick={() => void stopAll()} className="h-8 gap-1.5 bg-red-500 px-3 text-[12px] text-white hover:bg-red-600">
                <Square className="h-3.5 w-3.5" />
                Stop all
              </Button>
            ) : (
              <Button size="sm" onClick={() => setStreams((prev) => [...prev, newStream()])} className="h-8 gap-1.5 bg-km-accent px-3 text-[12px] text-white hover:bg-km-accent2">
                <Plus className="h-3.5 w-3.5" />
                Add stream
              </Button>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 [scrollbar-width:thin]">
          {streams.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-full bg-km-raised">
                <Radio className="h-6 w-6 text-km-dim" />
              </span>
              <p className="text-[13px] font-medium text-km-text">No streams yet</p>
              <p className="max-w-[46ch] text-[11px] leading-relaxed text-km-faint">
                Add a stream, pick a source (a file, a URL, or the live timeline) and tick the destinations it should reach.
                Add more streams to broadcast to different channels at the same time.
              </p>
              <Button size="sm" onClick={() => setStreams((prev) => [...prev, newStream()])} className="mt-2 h-8 gap-1.5 bg-km-accent px-3 text-[12px] text-white hover:bg-km-accent2">
                <Plus className="h-3.5 w-3.5" />
                Add stream
              </Button>
            </div>
          ) : (
            streams.map((stream) => (
              <StreamCard
                key={stream.id}
                stream={stream}
                configs={configs}
                sessions={sessionsFor(stream.id)}
                live={isStreamLive(stream.id)}
                busy={busyIds.has(stream.id)}
                error={errors[stream.id] ?? null}
                onChange={(patch) => updateStream(stream.id, patch)}
                onToggleDest={(configId) => toggleDest(stream.id, configId)}
                onStart={() => void startStream(stream.id)}
                onStop={() => void stopStream(stream.id)}
                onRemove={() => removeStream(stream.id)}
              />
            ))
          )}
        </div>

        {(showEditor || timelineLive) && hasTimelineStream && (
          <div className="flex h-[42%] min-h-[240px] shrink-0 flex-col border-t border-km-border">
            <Stage />
            <Timeline />
          </div>
        )}
      </main>

      {destDialog.open && (
        <DestinationDialog
          config={configs.find((c) => c.id === destDialog.id) ?? null}
          onClose={() => setDestDialog({ open: false, id: null })}
          onChanged={() => void reload()}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Destinations rail (config management)
 * ------------------------------------------------------------------ */

function DestinationsRail({
  configs,
  onAdd,
  onEdit,
}: {
  configs: StreamConfig[];
  onAdd: () => void;
  onEdit: (id: string) => void;
}) {
  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-km-border bg-km-panel">
      <div className="flex items-center justify-between border-b border-km-border px-4 py-3">
        <div>
          <p className="text-[13px] font-semibold tracking-tight text-km-text">Destinations</p>
          <p className="text-[10.5px] text-km-faint">The servers you push to</p>
        </div>
        <Button size="sm" onClick={onAdd} className="h-7 gap-1 bg-km-accent px-2.5 text-[11px] text-white hover:bg-km-accent2">
          <Plus className="h-3.5 w-3.5" />
          New
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto py-1.5 [scrollbar-width:thin]">
        {configs.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-km-raised">
              <Server className="h-5 w-5 text-km-dim" />
            </span>
            <p className="text-[12px] font-medium text-km-text">No destinations yet</p>
            <p className="text-[11px] leading-relaxed text-km-faint">Add a YouTube channel, Twitch stream, hardware encoder, or any RTMP/SRT server.</p>
            <Button size="sm" variant="ghost" onClick={onAdd} className="mt-1 h-7 gap-1 text-[11px] text-km-accent hover:bg-km-raised hover:text-km-accent">
              <Plus className="h-3 w-3" />
              Create one
            </Button>
          </div>
        ) : (
          configs.map((config) => (
            <div
              key={config.id}
              role="button"
              tabIndex={0}
              onClick={() => onEdit(config.id)}
              onKeyDown={(e) => e.key === "Enter" && onEdit(config.id)}
              className="group relative mx-1.5 flex cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition hover:bg-km-track"
            >
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-km-track">
                <Server className="h-3.5 w-3.5 text-km-dim" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-km-text">{config.name}</span>
                <span className="mt-0.5 block truncate text-[10.5px] text-km-faint">
                  {config.platform ?? "Custom"} · {config.protocol.toUpperCase()}
                </span>
              </span>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-km-border px-4 py-2.5">
        <p className="text-[10px] leading-relaxed text-km-faint">Stream keys stay on this device and are never shown in plain text.</p>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ *
 * One stream: source + destinations + start/stop
 * ------------------------------------------------------------------ */

function StreamCard({
  stream,
  configs,
  sessions,
  live,
  busy,
  error,
  onChange,
  onToggleDest,
  onStart,
  onStop,
  onRemove,
}: {
  stream: StreamDraft;
  configs: StreamConfig[];
  sessions: BroadcastStatus[];
  live: boolean;
  busy: boolean;
  error: string | null;
  onChange: (patch: Partial<StreamDraft>) => void;
  onToggleDest: (configId: string) => void;
  onStart: () => void;
  onStop: () => void;
  onRemove: () => void;
}) {
  const isTimeline = stream.sourceKind === "timeline";
  const canStart = stream.configIds.length > 0 && (isTimeline || stream.sourceValue.trim().length > 0) && !busy;

  return (
    <section className={cn("rounded-xl border bg-km-panel", live ? "border-red-500/40" : "border-km-border")}>
      <div className="flex flex-wrap items-center gap-2 border-b border-km-border/60 px-3.5 py-2.5">
        <div className="flex items-center gap-1 rounded-lg border border-km-border bg-km-track p-1">
          {SOURCE_OPTIONS.map((option) => (
            <button
              key={option.kind}
              type="button"
              onClick={() => onChange({ sourceKind: option.kind })}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] transition",
                stream.sourceKind === option.kind ? "bg-km-raised font-medium text-km-text" : "text-km-dim hover:text-km-text",
              )}
            >
              {option.icon}
              {option.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-km-dim" title={isTimeline ? "Loop the whole timeline" : "Loop the file until stopped"}>
            <input type="checkbox" checked={stream.loop} onChange={(e) => onChange({ loop: e.target.checked })} className="accent-[#6366f1]" />
            Loop
          </label>
          {!isTimeline && (
            <label className="flex items-center gap-1.5 text-[11px] text-km-dim" title="Re-encode to H.264/AAC">
              <input type="checkbox" checked={stream.transcode} onChange={(e) => onChange({ transcode: e.target.checked })} className="accent-[#6366f1]" />
              Transcode
            </label>
          )}
          <label className="flex items-center gap-1.5 text-[11px] text-km-dim" title="Target video bitrate in Mbps — leave blank to auto-match resolution and frame rate">
            <Input
              value={stream.bitrate}
              onChange={(e) => onChange({ bitrate: e.target.value })}
              placeholder="Mbps auto"
              className="h-7 w-20 border-km-border bg-km-track font-mono text-[11px] text-km-text focus-visible:ring-1 focus-visible:ring-km-accent"
            />
          </label>
          <Button size="sm" variant="ghost" onClick={onRemove} disabled={live} className="h-7 w-7 p-0 text-km-faint hover:bg-km-raised hover:text-red-300" title="Remove this stream">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="space-y-3 px-3.5 py-3">
        {isTimeline ? (
          <p className="text-[11.5px] leading-relaxed text-km-dim">
            Broadcasts the composed editor timeline — every layer, headline, sticker and effect, looping live. One timeline stream can run at a time.
          </p>
        ) : (
          <Input
            value={stream.sourceValue}
            onChange={(e) => onChange({ sourceValue: e.target.value })}
            placeholder={stream.sourceKind === "file" ? "/home/me/video.mp4" : "https://example.com/video.mp4"}
            className="h-9 border-km-border bg-km-track font-mono text-[12px] text-km-text focus-visible:ring-1 focus-visible:ring-km-accent"
          />
        )}

        {!isTimeline && !stream.transcode && (
          <p className="rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200">
            Stream-copy sends the source's own bitrate unchanged — a low-bitrate file will show "too low" on YouTube.
            Enable Transcode to re-encode to the target bitrate.
          </p>
        )}

        <div>
          <p className="mb-1.5 text-[10.5px] font-medium text-km-faint">Destinations</p>
          {configs.length === 0 ? (
            <p className="text-[11px] text-km-dim">No destinations yet — create one from the left rail first.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {configs.map((config) => {
                const ticked = stream.configIds.includes(config.id);
                return (
                  <button
                    key={config.id}
                    type="button"
                    onClick={() => onToggleDest(config.id)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition",
                      ticked ? "border-km-accent/60 bg-km-accent/15 text-km-text" : "border-km-border bg-km-track text-km-dim hover:text-km-text",
                    )}
                  >
                    <span className={cn("grid h-3 w-3 place-items-center rounded-sm border", ticked ? "border-km-accent bg-km-accent" : "border-km-faint")}>
                      {ticked && <Check className="h-2.5 w-2.5 text-white" />}
                    </span>
                    {config.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {sessions.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
              {sessions.map((session) => (
                <span
                  key={session.id}
                  title={session.note ?? session.error ?? undefined}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10.5px]",
                    session.running ? "border-red-500/30 bg-red-500/10 text-km-text" : "border-amber-500/30 bg-amber-500/10 text-km-text",
                  )}
                >
                  <Radio className={cn("h-3 w-3", session.running ? "animate-pulse text-red-400" : "text-amber-400")} />
                  <span className="max-w-[160px] truncate font-medium">{session.label ?? "stream"}</span>
                  {session.reconnecting ? (
                    <span className="font-mono text-amber-400">reconnecting…</span>
                  ) : session.running ? (
                    <span className="font-mono text-km-faint">
                      {[session.bitrate, session.fps && `${session.fps} fps`, `up ${Math.floor(session.uptime / 60)}m${session.uptime % 60}s`].filter(Boolean).join(" · ")}
                    </span>
                  ) : (
                    <span className="font-mono text-km-faint">{session.error ?? "stopped"}</span>
                  )}
                </span>
              ))}
            </div>
            <div className="flex flex-col gap-1.5 pt-1">
              {sessions.map((session) => (
                <details key={`logs-${session.id}`} className="rounded-lg border border-km-border/60 bg-km-track/50 group">
                  <summary className="flex cursor-pointer items-center justify-between px-3 py-2 text-[11px] font-medium text-km-dim transition hover:text-km-text">
                    <span>Logs: {session.label ?? "stream"}</span>
                    <span className="text-[10px] text-km-faint group-open:hidden">Show logs</span>
                    <span className="hidden text-[10px] text-km-faint group-open:block">Hide logs</span>
                  </summary>
                  <div className="border-t border-km-border/60 p-2">
                    <pre className="max-h-[240px] overflow-y-auto whitespace-pre-wrap text-[10.5px] font-mono leading-relaxed text-km-dim [scrollbar-width:thin]">
                      {session.tail?.length ? session.tail.join("\n") : "Waiting for ffmpeg output..."}
                    </pre>
                  </div>
                </details>
              ))}
            </div>
          </div>
        )}

        {error && <p className="text-[11px] text-amber-400">! {error}</p>}

        <div className="flex items-center gap-2">
          {live ? (
            <Button size="sm" onClick={onStop} disabled={busy} className="h-8 gap-1.5 bg-red-500 px-3 text-[12px] text-white hover:bg-red-600">
              <Square className="h-3.5 w-3.5" />
              Stop
            </Button>
          ) : (
            <Button size="sm" onClick={onStart} disabled={!canStart} className="h-8 gap-1.5 bg-km-accent px-3 text-[12px] text-white hover:bg-km-accent2">
              <Play className="h-3.5 w-3.5" />
              {isTimeline ? "Go live" : "Start"}
            </Button>
          )}
          <span className="text-[10px] text-km-faint">
            {stream.configIds.length} destination{stream.configIds.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Destination create/edit dialog
 * ------------------------------------------------------------------ */

const EMPTY_DRAFT = {
  name: "",
  platform: "YouTube",
  protocol: "rtmp" as StreamProtocol,
  address: "",
  streamKey: "",
  username: "",
  password: "",
};

function DestinationDialog({ config, onClose, onChanged }: { config: StreamConfig | null; onClose: () => void; onChanged: () => void }) {
  const [draft, setDraft] = useState(() =>
    config
      ? {
          name: config.name,
          platform: config.platform ?? "Custom server",
          protocol: config.protocol,
          address: config.address,
          streamKey: config.streamKey,
          username: config.username ?? "",
          password: config.password ?? "",
        }
      : { ...EMPTY_DRAFT },
  );
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showAuth, setShowAuth] = useState(!!config?.username);

  const patch = (partial: Partial<typeof EMPTY_DRAFT>) => setDraft((d) => ({ ...d, ...partial }));
  const applyPlatformDefault = (platform: string) => {
    const preset = PLATFORM_DEFAULTS.find((p) => p.platform === platform);
    setDraft((d) => ({ ...d, platform, ...(preset ? { protocol: preset.protocol, address: preset.address } : {}) }));
  };

  const persist = async () => {
    if (!draft.name.trim() || !draft.address.trim()) return;
    setBusy(true);
    try {
      await saveStreamConfig({ id: config?.id, ...draft });
      setSaved(true);
      onChanged();
      setTimeout(() => setSaved(false), 900);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!config) return;
    setBusy(true);
    try {
      await deleteStreamConfig(config.id);
      onChanged();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const valid = draft.name.trim().length > 0 && draft.address.trim().length > 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{config ? "Destination" : "New destination"}</DialogTitle>
          <DialogDescription>The ingest server and stream key. The key is stored on this device and never echoed back.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="YouTube — main channel" className="h-9 border-km-border bg-km-track text-[12.5px] text-km-text focus-visible:ring-1 focus-visible:ring-km-accent" />
            </Field>
            <Field label="Platform (presets the server)">
              <select value={draft.platform} onChange={(e) => applyPlatformDefault(e.target.value)} className="h-9 w-full rounded-md border border-km-border bg-km-track px-2 text-[12.5px] text-km-text outline-none focus:ring-1 focus:ring-km-accent">
                {STREAM_PLATFORMS.map((platform) => (
                  <option key={platform} value={platform} className="bg-km-panel2">
                    {platform}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-[130px_1fr] gap-3">
            <Field label="Protocol">
              <select value={draft.protocol} onChange={(e) => patch({ protocol: e.target.value as StreamProtocol })} className="h-9 w-full rounded-md border border-km-border bg-km-track px-2 text-[12.5px] text-km-text outline-none focus:ring-1 focus:ring-km-accent">
                {STREAM_PROTOCOLS.map((protocol) => (
                  <option key={protocol.value} value={protocol.value} className="bg-km-panel2">
                    {protocol.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Server address (without the key)">
              <Input value={draft.address} onChange={(e) => patch({ address: e.target.value })} placeholder="rtmp://a.rtmp.youtube.com/live2" className="h-9 border-km-border bg-km-track font-mono text-[12px] text-km-text focus-visible:ring-1 focus-visible:ring-km-accent" />
            </Field>
          </div>

          <Field label="Stream key">
            <div className="flex items-center gap-2">
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-km-faint" />
              <Input value={draft.streamKey} onChange={(e) => patch({ streamKey: e.target.value })} placeholder="abcd-1234-…" className="h-9 border-km-border bg-km-track font-mono text-[12px] text-km-text focus-visible:ring-1 focus-visible:ring-km-accent" />
            </div>
          </Field>

          <div className="rounded-lg border border-km-border/60 bg-km-track/50">
            <button type="button" onClick={() => setShowAuth(!showAuth)} className="flex w-full items-center justify-between px-3 py-2 text-[11.5px] text-km-dim transition hover:text-km-text">
              <span>Authentication (for servers or encoders that require login)</span>
              <span className="text-km-faint">{showAuth ? "Hide" : "Show"}</span>
            </button>
            {showAuth && (
              <div className="grid grid-cols-2 gap-3 px-3 pb-3">
                <Field label="Username">
                  <Input value={draft.username} onChange={(e) => patch({ username: e.target.value })} placeholder="optional" className="h-8 border-km-border bg-km-panel text-[12px] text-km-text focus-visible:ring-1 focus-visible:ring-km-accent" />
                </Field>
                <Field label="Password">
                  <Input type="password" value={draft.password} onChange={(e) => patch({ password: e.target.value })} placeholder="optional" className="h-8 border-km-border bg-km-panel text-[12px] text-km-text focus-visible:ring-1 focus-visible:ring-km-accent" />
                </Field>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" onClick={() => void persist()} disabled={busy || !valid} className="h-8 gap-1.5 bg-km-accent px-3 text-[12px] text-white hover:bg-km-accent2">
              {saved ? <Check className="h-3.5 w-3.5" /> : null}
              {saved ? "Saved" : config ? "Update" : "Save"}
            </Button>
            {config && (
              <Button size="sm" variant="ghost" onClick={() => void remove()} disabled={busy} className="h-8 gap-1 px-2.5 text-[11.5px] text-km-dim hover:bg-km-raised hover:text-red-300">
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ *
 * Field
 * ------------------------------------------------------------------ */

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10.5px] font-medium text-km-faint">{label}</span>
      {children}
    </label>
  );
}
