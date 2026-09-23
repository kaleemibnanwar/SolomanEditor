/**
 * THE BROADCAST STUDIO — a separate mode from the editor.
 *
 * Destinations on the left; the console on the right. For the Timeline source,
 * the console IS the editor: the real Stage (live preview) and the real layered
 * Timeline (b-roll tracks/clips), whose per-row eye toggle decides what is on air
 * — the same `layer.hidden` flag the compositor and the capture engine both honor.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  FileVideo,
  Film,
  KeyRound,
  Link2,
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
import Stage from "@/components/editor/Stage";
import Timeline from "@/components/editor/Timeline";
import {
  PLATFORM_DEFAULTS,
  STREAM_PLATFORMS,
  STREAM_PROTOCOLS,
  deleteStreamConfig,
  ingestUrl,
  listStreamConfigs,
  saveStreamConfig,
  type StreamConfig,
  type StreamProtocol,
} from "@/lib/broadcast";
import { startTimelinePush, stopTimelinePush } from "@/lib/broadcastController";
import { NO_BROADCAST_STATUS, broadcastBridge, subscribeBroadcastStatus, type BroadcastStatus } from "@/lib/broadcastHost";
import { cn } from "@/lib/utils";

type SourceKind = "file" | "url" | "timeline";

const EMPTY_DRAFT = {
  name: "",
  platform: "YouTube",
  protocol: "rtmp" as StreamProtocol,
  address: "",
  streamKey: "",
  username: "",
  password: "",
};

const SOURCE_OPTIONS: { kind: SourceKind; label: string; icon: ReactNode }[] = [
  { kind: "file", label: "File", icon: <FileVideo className="h-3.5 w-3.5" /> },
  { kind: "url", label: "URL", icon: <Link2 className="h-3.5 w-3.5" /> },
  { kind: "timeline", label: "Timeline", icon: <Film className="h-3.5 w-3.5" /> },
];

export default function BroadcastStudio() {
  const [configs, setConfigs] = useState<StreamConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [sourceKind, setSourceKind] = useState<SourceKind>("file");
  const [sourceValue, setSourceValue] = useState("");
  const [loop, setLoop] = useState(true);
  const [transcode, setTranscode] = useState(true);
  const [status, setStatus] = useState<BroadcastStatus>(NO_BROADCAST_STATUS);
  const [ffmpeg, setFfmpeg] = useState<{ available: boolean; version: string | null }>({ available: false, version: null });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showAuth, setShowAuth] = useState(false);

  const bridge = useMemo(() => broadcastBridge(), []);

  const reload = async () => setConfigs(await listStreamConfigs());

  useEffect(() => {
    void reload();
    const unsubscribe = subscribeBroadcastStatus(setStatus);
    void bridge?.probe().then(setFfmpeg).catch(() => {});
    return unsubscribe;
  }, [bridge]);

  const selected = configs.find((c) => c.id === selectedId) ?? null;
  const liveConfigId = status.running && status.label ? (configs.find((c) => c.name === status.label)?.id ?? null) : null;

  const select = (config: StreamConfig) => {
    setSelectedId(config.id);
    setDraft({
      name: config.name,
      platform: config.platform ?? "Custom server",
      protocol: config.protocol,
      address: config.address,
      streamKey: config.streamKey,
      username: config.username ?? "",
      password: config.password ?? "",
    });
    setShowAuth(!!config.username);
    setSaved(false);
  };

  const newConfig = () => {
    setSelectedId(null);
    setDraft(EMPTY_DRAFT);
    setShowAuth(false);
    setSaved(false);
  };

  const applyPlatformDefault = (platform: string) => {
    const preset = PLATFORM_DEFAULTS.find((p) => p.platform === platform);
    setDraft((d) => ({ ...d, platform, ...(preset ? { protocol: preset.protocol, address: preset.address } : {}) }));
  };

  const persist = async () => {
    if (!draft.name.trim() || !draft.address.trim()) return;
    setBusy(true);
    try {
      const config = await saveStreamConfig({ id: selectedId ?? undefined, ...draft });
      setSelectedId(config.id);
      await reload();
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    await deleteStreamConfig(selected.id);
    setSelectedId(null);
    setDraft(EMPTY_DRAFT);
    await reload();
  };

  const start = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      if (sourceKind === "timeline") {
        await startTimelinePush(selected.id, { loop, transcode });
        setStatus((await bridge?.status()) ?? NO_BROADCAST_STATUS);
      } else if (bridge) {
        const next = await bridge.start({
          url: ingestUrl(selected),
          protocol: selected.protocol,
          source: { kind: sourceKind as "file" | "url", value: sourceValue },
          loop,
          transcode,
          label: selected.name,
        });
        setStatus(next);
      }
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      await stopTimelinePush();
      if (bridge) setStatus((await bridge.stop()) ?? NO_BROADCAST_STATUS);
    } finally {
      setBusy(false);
    }
  };

  const canStart =
    selected &&
    (sourceKind === "timeline" ? true : sourceValue.trim().length > 0) &&
    (sourceKind === "timeline" ? true : ffmpeg.available) &&
    !busy;

  return (
    <div className="flex min-h-0 flex-1">
      <DestinationsRail
        configs={configs}
        selectedId={selectedId}
        liveConfigId={liveConfigId}
        onSelect={select}
        onNew={newConfig}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <BroadcastHeader
          selected={selected}
          sourceKind={sourceKind}
          setSourceKind={setSourceKind}
          loop={loop}
          setLoop={setLoop}
          transcode={transcode}
          setTranscode={setTranscode}
          status={status}
          ffmpeg={ffmpeg}
          busy={busy}
          canStart={!!canStart}
          onStart={() => void start()}
          onStop={() => void stop()}
        />

        {sourceKind === "timeline" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1">
              <Stage />
            </div>
            <Timeline />
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-4 overflow-y-auto p-5 [scrollbar-width:thin]">
            <StatusBanner status={status} ffmpeg={ffmpeg} target={selected} />
            {!bridge && <NoDesktopBanner />}

            <DestinationCard
              draft={draft}
              setDraft={setDraft}
              isNew={!selected}
              saved={saved}
              busy={busy}
              showAuth={showAuth}
              setShowAuth={setShowAuth}
              onPlatform={applyPlatformDefault}
              onSave={() => void persist()}
              onDelete={selected ? () => void remove() : undefined}
            />

            <SourceInputCard sourceKind={sourceKind} sourceValue={sourceValue} setSourceValue={setSourceValue} />
          </div>
        )}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Destinations rail
 * ------------------------------------------------------------------ */

function DestinationsRail({
  configs,
  selectedId,
  liveConfigId,
  onSelect,
  onNew,
}: {
  configs: StreamConfig[];
  selectedId: string | null;
  liveConfigId: string | null;
  onSelect: (config: StreamConfig) => void;
  onNew: () => void;
}) {
  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-r border-km-border bg-km-panel">
      <div className="flex items-center justify-between border-b border-km-border px-4 py-3">
        <div>
          <p className="text-[13px] font-semibold tracking-tight text-km-text">Destinations</p>
          <p className="text-[10.5px] text-km-faint">Where your stream goes</p>
        </div>
        <Button size="sm" onClick={onNew} className="h-7 gap-1 bg-km-accent px-2.5 text-[11px] text-white hover:bg-km-accent2">
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
            <p className="text-[11px] leading-relaxed text-km-faint">
              Add a YouTube channel, Twitch stream, hardware encoder, or any RTMP/SRT server.
            </p>
            <Button size="sm" variant="ghost" onClick={onNew} className="mt-1 h-7 gap-1 text-[11px] text-km-accent hover:bg-km-raised hover:text-km-accent">
              <Plus className="h-3 w-3" />
              Create one
            </Button>
          </div>
        ) : (
          configs.map((config) => {
            const isSelected = selectedId === config.id;
            const isLive = liveConfigId === config.id;
            return (
              <button
                key={config.id}
                type="button"
                onClick={() => onSelect(config)}
                className={cn(
                  "group relative mx-1.5 flex items-start gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition",
                  isSelected ? "bg-km-raised" : "hover:bg-km-track",
                )}
              >
                <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md bg-km-track">
                  <Server className="h-3.5 w-3.5 text-km-dim" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-medium text-km-text">{config.name}</span>
                    {isLive && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-red-500" />}
                  </span>
                  <span className="mt-0.5 block truncate text-[10.5px] text-km-faint">
                    {config.platform ?? "Custom"} · {config.protocol.toUpperCase()}
                  </span>
                </span>
                {isSelected && <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-km-accent" />}
              </button>
            );
          })
        )}
      </div>

      <div className="border-t border-km-border px-4 py-2.5">
        <p className="text-[10px] leading-relaxed text-km-faint">Stream keys stay on this device and are never shown in plain text.</p>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ *
 * Header — destination + source + go live
 * ------------------------------------------------------------------ */

function BroadcastHeader({
  selected,
  sourceKind,
  setSourceKind,
  loop,
  setLoop,
  transcode,
  setTranscode,
  status,
  ffmpeg,
  busy,
  canStart,
  onStart,
  onStop,
}: {
  selected: StreamConfig | null;
  sourceKind: SourceKind;
  setSourceKind: (kind: SourceKind) => void;
  loop: boolean;
  setLoop: (loop: boolean) => void;
  transcode: boolean;
  setTranscode: (transcode: boolean) => void;
  status: BroadcastStatus;
  ffmpeg: { available: boolean; version: string | null };
  busy: boolean;
  canStart: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const live = status.running;
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-km-border bg-km-panel px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <Radio className={cn("h-4 w-4 shrink-0", live ? "animate-pulse text-red-400" : "text-km-dim")} />
        <div className="min-w-0">
          <p className="truncate text-[12.5px] font-medium text-km-text">{selected?.name ?? "No destination"}</p>
          <p className="truncate text-[10px] text-km-faint">
            {selected ? `${selected.protocol.toUpperCase()}${selected.platform ? ` · ${selected.platform}` : ""}` : "Pick one on the left"}
          </p>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-1 rounded-lg border border-km-border bg-km-track p-1">
        {SOURCE_OPTIONS.map((option) => (
          <button
            key={option.kind}
            type="button"
            onClick={() => setSourceKind(option.kind)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] transition",
              sourceKind === option.kind ? "bg-km-raised font-medium text-km-text" : "text-km-dim hover:text-km-text",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-[11px] text-km-dim" title={sourceKind === "timeline" ? "Loop the whole timeline" : "Loop the file until stopped"}>
          <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} className="accent-[#6366f1]" />
          Loop
        </label>
        {sourceKind !== "timeline" ? (
          <label className="flex items-center gap-1.5 text-[11px] text-km-dim" title="Re-encode to H.264/AAC">
            <input type="checkbox" checked={transcode} onChange={(e) => setTranscode(e.target.checked)} className="accent-[#6366f1]" />
            Transcode
          </label>
        ) : (
          <span className="flex items-center gap-1 text-[10px] text-km-faint" title="The live timeline is always encoded to H.264/AAC for ingest">
            H.264/AAC
          </span>
        )}
        <span className={cn("flex items-center gap-1 text-[10px]", ffmpeg.available ? "text-km-faint" : "text-amber-400")}>
          <Wifi className="h-3 w-3" />
          {ffmpeg.available ? "" : "ffmpeg"}
        </span>

        {live ? (
          <Button size="sm" onClick={onStop} disabled={busy} className="h-8 gap-1.5 bg-red-500 px-3 text-[12px] text-white hover:bg-red-600">
            <Square className="h-3.5 w-3.5" />
            Stop
          </Button>
        ) : (
          <Button size="sm" onClick={onStart} disabled={!canStart} className="h-8 gap-1.5 bg-km-accent px-3 text-[12px] text-white hover:bg-km-accent2">
            <Play className="h-3.5 w-3.5" />
            {sourceKind === "timeline" ? "Go live" : "Start"}
          </Button>
        )}
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ *
 * Status banner (file/url console)
 * ------------------------------------------------------------------ */

function StatusBanner({
  status,
  ffmpeg,
  target,
}: {
  status: BroadcastStatus;
  ffmpeg: { available: boolean; version: string | null };
  target: StreamConfig | null;
}) {
  const live = status.running;
  return (
    <section className="overflow-hidden rounded-xl border border-km-border bg-km-panel">
      <div className="flex items-center gap-3 px-4 py-3.5">
        <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-full", live ? "bg-red-500/15" : status.error ? "bg-amber-500/15" : "bg-km-raised")}>
          <Radio className={cn("h-5 w-5", live ? "animate-pulse text-red-400" : status.error ? "text-amber-400" : "text-km-dim")} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-[13.5px] font-semibold tracking-tight text-km-text">{live ? "On air" : status.error ? "Stream stopped" : "Ready"}</p>
            {live && <span className="rounded bg-red-500/20 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-red-300">LIVE</span>}
          </div>
          <p className="truncate text-[11px] text-km-dim">
            {live
              ? `${status.label ?? "stream"} → ${(status.protocol ?? "").toUpperCase()}`
              : status.error
                ? status.error
                : target
                  ? `Pointing at "${target.name}"`
                  : "Pick a destination, then a source, then go live."}
          </p>
          {live && (
            <p className="mt-0.5 font-mono text-[10.5px] text-km-faint">
              {[status.time && `t ${status.time}`, status.bitrate, status.speed, status.fps && `${status.fps} fps`].filter(Boolean).join(" · ") || "starting…"}
              {status.uptime > 0 && ` · up ${Math.floor(status.uptime / 60)}m ${status.uptime % 60}s`}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function NoDesktopBanner() {
  return (
    <section className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
      <Wifi className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
      <p className="text-[11.5px] leading-relaxed text-km-dim">
        Broadcasting needs the desktop app and ffmpeg — a browser can't open an RTMP/SRT socket. Destinations still save here
        and are ready the moment you run the desktop build.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Destination form
 * ------------------------------------------------------------------ */

function DestinationCard({
  draft,
  setDraft,
  isNew,
  saved,
  busy,
  showAuth,
  setShowAuth,
  onPlatform,
  onSave,
  onDelete,
}: {
  draft: typeof EMPTY_DRAFT;
  setDraft: (updater: (d: typeof EMPTY_DRAFT) => typeof EMPTY_DRAFT) => void;
  isNew: boolean;
  saved: boolean;
  busy: boolean;
  showAuth: boolean;
  setShowAuth: (show: boolean) => void;
  onPlatform: (platform: string) => void;
  onSave: () => void;
  onDelete?: () => void;
}) {
  const patch = (partial: Partial<typeof EMPTY_DRAFT>) => setDraft((d) => ({ ...d, ...partial }));
  const valid = draft.name.trim().length > 0 && draft.address.trim().length > 0;

  return (
    <section className="rounded-xl border border-km-border bg-km-panel">
      <header className="flex items-center justify-between border-b border-km-border px-4 py-3">
        <div>
          <p className="text-[13px] font-semibold tracking-tight text-km-text">{isNew ? "New destination" : "Destination"}</p>
          <p className="text-[10.5px] text-km-faint">The ingest server and stream key</p>
        </div>
        <span className="rounded bg-km-track px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wide text-km-faint">{draft.protocol}</span>
      </header>

      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <Input
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="YouTube — main channel"
              className="h-9 border-km-border bg-km-track text-[12.5px] text-km-text focus-visible:ring-1 focus-visible:ring-km-accent"
            />
          </Field>
          <Field label="Platform (presets the server)">
            <select
              value={draft.platform}
              onChange={(e) => onPlatform(e.target.value)}
              className="h-9 w-full rounded-md border border-km-border bg-km-track px-2 text-[12.5px] text-km-text outline-none focus:ring-1 focus:ring-km-accent"
            >
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
            <select
              value={draft.protocol}
              onChange={(e) => patch({ protocol: e.target.value as StreamProtocol })}
              className="h-9 w-full rounded-md border border-km-border bg-km-track px-2 text-[12.5px] text-km-text outline-none focus:ring-1 focus:ring-km-accent"
            >
              {STREAM_PROTOCOLS.map((protocol) => (
                <option key={protocol.value} value={protocol.value} className="bg-km-panel2">
                  {protocol.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Server address (without the key)">
            <Input
              value={draft.address}
              onChange={(e) => patch({ address: e.target.value })}
              placeholder="rtmp://a.rtmp.youtube.com/live2"
              className="h-9 border-km-border bg-km-track font-mono text-[12px] text-km-text focus-visible:ring-1 focus-visible:ring-km-accent"
            />
          </Field>
        </div>

        <Field label="Stream key">
          <div className="flex items-center gap-2">
            <KeyRound className="h-3.5 w-3.5 shrink-0 text-km-faint" />
            <Input
              value={draft.streamKey}
              onChange={(e) => patch({ streamKey: e.target.value })}
              placeholder="abcd-1234-…"
              className="h-9 border-km-border bg-km-track font-mono text-[12px] text-km-text focus-visible:ring-1 focus-visible:ring-km-accent"
            />
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
                <Input
                  value={draft.username}
                  onChange={(e) => patch({ username: e.target.value })}
                  placeholder="optional"
                  className="h-8 border-km-border bg-km-panel text-[12px] text-km-text focus-visible:ring-1 focus-visible:ring-km-accent"
                />
              </Field>
              <Field label="Password">
                <Input
                  type="password"
                  value={draft.password}
                  onChange={(e) => patch({ password: e.target.value })}
                  placeholder="optional"
                  className="h-8 border-km-border bg-km-panel text-[12px] text-km-text focus-visible:ring-1 focus-visible:ring-km-accent"
                />
              </Field>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={onSave} disabled={busy || !valid} className="h-8 gap-1.5 bg-km-accent px-3 text-[12px] text-white hover:bg-km-accent2">
            {saved ? <Check className="h-3.5 w-3.5" /> : null}
            {saved ? "Saved" : isNew ? "Save destination" : "Update destination"}
          </Button>
          {onDelete && (
            <Button size="sm" variant="ghost" onClick={onDelete} className="h-8 gap-1 px-2.5 text-[11.5px] text-km-dim hover:bg-km-raised hover:text-red-300">
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * File/URL source input
 * ------------------------------------------------------------------ */

function SourceInputCard({
  sourceKind,
  sourceValue,
  setSourceValue,
}: {
  sourceKind: "file" | "url";
  sourceValue: string;
  setSourceValue: (value: string) => void;
}) {
  return (
    <section className="rounded-xl border border-km-border bg-km-panel">
      <header className="border-b border-km-border px-4 py-3">
        <p className="text-[13px] font-semibold tracking-tight text-km-text">Source</p>
        <p className="text-[10.5px] text-km-faint">What goes on air</p>
      </header>
      <div className="p-4">
        <Field label={sourceKind === "file" ? "Video file on this computer" : "Video URL (http(s))"}>
          <Input
            value={sourceValue}
            onChange={(e) => setSourceValue(e.target.value)}
            placeholder={sourceKind === "file" ? "/home/me/video.mp4" : "https://example.com/video.mp4"}
            className="h-9 border-km-border bg-km-track font-mono text-[12px] text-km-text focus-visible:ring-1 focus-visible:ring-km-accent"
          />
        </Field>
      </div>
    </section>
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
