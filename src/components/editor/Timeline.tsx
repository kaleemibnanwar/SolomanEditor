/**
 * THE TIMELINE.
 *
 * One ROW PER TRACK, read top to bottom as back to front. The main layer always
 * owns the top row — `withTrackOrder` hoists it there — so the rows below it are
 * the ones that draw over the picture. Beyond the rails there is a scrubbable
 * ruler, a draggable playhead, trim/move/split interactions and a zoom control.
 * The rows area is the master scroller; the ruler and the track rails are
 * translated from its scroll offsets so everything stays aligned.
 *
 * Two structural decisions worth knowing before editing:
 *
 *  1. Every clip is rendered as a SIBLING, in one flat list, positioned with
 *     `top: rowIndex * ROW_H`. Nesting clips inside their track's row div would
 *     read more naturally but would remount the clip the moment a vertical drag
 *     moved it to another track — and a remounted clip loses the drag it is in
 *     the middle of. Flat + `top` keeps the component instance alive.
 *
 *  2. A junction is drawn by its own component (see `TimelineJunction`) rather
 *     than by either clip, because it belongs to neither: it is the seam.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Grid3x3,
  Lock,
  Magnet,
  Maximize2,
  MoreVertical,
  Plus,
  Scan,
  Scissors,
  Trash2,
  Unlock,
  ZoomIn,
  ZoomOut,
  Eye,
  EyeOff,
} from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import TimelineClip from "@/components/editor/TimelineClip";
import TimelineJunction from "@/components/editor/TimelineJunction";
import { bondHoldsLastFrame, junctionIndex, junctionsOnTrack, maxBondDuration } from "@/lib/bonds";
import { layerEnd } from "@/lib/project";
import { layersOnTrack, topFirstTracks } from "@/lib/tracks";
import { DEFAULT_SHAPE_STYLE } from "@/lib/library";
import { clamp } from "@/lib/time";
import { importFromInput } from "@/lib/importFiles";
import { dropPreview, sameDropPreview, useDrag } from "@/lib/mediaDrag";
import { editor, editorStore, timelineDuration, useEditor } from "@/store/editorStore";
import { shallowArrayEqual } from "@/store/createStore";
import type { Layer, LayerId, Track } from "@/types/editor";

const ROW_H = 36;
const RULER_H = 28;
const RAIL_W = 142;
const MIN_PPS = 12;
const MAX_PPS = 900;

export default function Timeline() {
  const project = useEditor((s) => s.project);
  const assets = useEditor((s) => s.assets);
  const selection = useEditor((s) => s.selection, shallowArrayEqual);
  const currentTime = useEditor((s) => s.currentTime);
  const pps = useEditor((s) => s.pixelsPerSecond);
  const fps = useEditor((s) => s.project.settings.fps);
  const duration = useEditor(timelineDuration);

  /**
   * The whole row model, derived once per project change: which clips sit on
   * each track, in the order they should be drawn, and every join between them.
   */
  const rows = useMemo(() => {
    return topFirstTracks(project).map((track) => {
      const clips = layersOnTrack(project, track.id)
        .slice()
        // Left to right, so an incoming clip is drawn over the one it overlaps.
        .sort((a, b) => a.startTime - b.startTime);
      const junctions = junctionsOnTrack(project, track.id);
      return { track, clips, junctions, joins: junctionIndex(junctions) };
    });
  }, [project]);

  /** Flat clip list + the row each one sits on, so clips stay siblings. */
  const { clips, rowOf } = useMemo(() => {
    const flat: Layer[] = [];
    const index = new Map<LayerId, number>();
    rows.forEach((row, i) => {
      for (const layer of row.clips) {
        flat.push(layer);
        index.set(layer.id, i);
      }
    });
    return { clips: flat, rowOf: index };
  }, [rows]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ left: 0, top: 0 });
  const [viewportWidth, setViewportWidth] = useState(900);

  /**
   * Where an in-flight drag would land. Read through `sameDropPreview` so this
   * component — and every clip under it — only re-renders when the ghost
   * actually moves a frame or a row, rather than on every pointer event.
   */
  const preview = useDrag(dropPreview, sameDropPreview);

  const contentWidth = Math.max(duration * pps + 320, viewportWidth);
  // One spare row's worth of height so the rail's "Add track" button has room.
  const contentHeight = (rows.length + 1) * ROW_H;

  /* measure the viewport so the ruler always spans the full width */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* keep the playhead in view during playback */
  useEffect(() => {
    return editorStore.subscribe(() => {
      const st = editorStore.getState();
      if (!st.isPlaying) return;
      const el = scrollRef.current;
      if (!el) return;
      const x = st.currentTime * st.pixelsPerSecond;
      if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 90) {
        el.scrollLeft = Math.max(0, x - el.clientWidth * 0.35);
      }
    });
  }, []);

  /* scrubbing on the ruler */
  const startScrub = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = scrollRef.current;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const timeFrom = (clientX: number) =>
      Math.max(0, (clientX - rect.left + (el?.scrollLeft ?? 0)) / pps);
    editor().setCurrentTime(timeFrom(e.clientX));
    const onMove = (ev: PointerEvent) => editor().setCurrentTime(timeFrom(ev.clientX));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const playheadX = currentTime * pps;

  return (
    <section className="flex h-[245px] shrink-0 flex-col border-t border-km-border bg-km-panel">
      <TimelineToolbar rowCount={rows.length} />

      <div className="flex min-h-0 flex-1">
        {/* track rails */}
        <div className="flex shrink-0 flex-col border-r border-km-border bg-km-panel2" style={{ width: RAIL_W }}>
          <div className="flex shrink-0 items-center px-2" style={{ height: RULER_H }}>
            <span className="text-[10px] font-medium uppercase tracking-wider text-km-faint">Layers</span>
            <span className="ml-auto text-[10px] text-km-faint">
              {rows.length} {rows.length === 1 ? "track" : "tracks"}
            </span>
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden">
            <div className="absolute inset-x-0 top-0" style={{ transform: `translateY(${-view.top}px)` }}>
              {rows.map((row) => (
                <TrackRail key={row.track.id} track={row.track} clips={row.clips} />
              ))}
              <AddTrackRow />
            </div>
          </div>
        </div>

        {/* ruler + rows */}
        <div className="relative min-w-0 flex-1">
          <div className="relative overflow-hidden bg-km-panel2" style={{ height: RULER_H }}>
            <div
              className="absolute inset-y-0 left-0"
              style={{ width: contentWidth, transform: `translateX(${-view.left}px)` }}
            >
              <Ruler width={contentWidth} pps={pps} />
            </div>
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-km-accent"
              style={{ left: playheadX - view.left }}
            >
              <div className="absolute -left-[5px] top-0 h-3.5 w-[11px] rounded-b-sm bg-km-accent shadow" />
            </div>
            <div className="absolute inset-0 z-30 cursor-ew-resize" onPointerDown={startScrub} />
          </div>

          <div
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              setView({ left: el.scrollLeft, top: el.scrollTop });
            }}
            className="km-scroll absolute inset-x-0 bottom-0 overflow-auto"
            data-timeline-viewport
            /* Declares this scroller as the drop surface media can be dragged
               onto. The scale and row height ride along as data because
               `lib/mediaDrag` hit-tests from the event coordinates and has to
               convert them itself — see that module's `resolveTarget`. */
            data-drop="timeline"
            data-pps={pps}
            data-row-h={ROW_H}
            style={{ top: RULER_H }}
          >
            <div className="relative" style={{ width: contentWidth, height: contentHeight }}>
              {/* alternating row backgrounds, one per track */}
              {rows.map((row, i) => (
                <div
                  key={`bg-${row.track.id}`}
                  className={`absolute left-0 ${i % 2 ? "bg-white/[0.015]" : ""}`}
                  style={{ top: i * ROW_H, height: ROW_H, width: contentWidth }}
                >
                  <div className="absolute inset-x-0 bottom-0 h-px bg-km-border/50" />
                </div>
              ))}

              {/* junctions sit between clips, so they draw under them */}
              {rows.flatMap((row, i) =>
                row.junctions.map((junction) => (
                  <TimelineJunction
                    key={`j:${junction.from}:${junction.to}`}
                    junction={junction}
                    top={i * ROW_H}
                    rowHeight={ROW_H}
                    pps={pps}
                    fromName={project.layers[junction.from]?.name ?? "Clip"}
                    toName={project.layers[junction.to]?.name ?? "Clip"}
                    maxDuration={maxBondDuration(project, junction.from, junction.to)}
                    holdsLastFrame={(() => {
                      const from = project.layers[junction.from];
                      const asset = from?.assetId ? assets[from.assetId] : undefined;
                      return !!from && bondHoldsLastFrame(from, asset?.duration);
                    })()}
                    highlighted={
                      selection.includes(junction.from) || selection.includes(junction.to)
                    }
                  />
                )),
              )}

              {/* clips — flat siblings, positioned by their track's display row */}
              {clips.map((layer) => {
                const join = rows[rowOf.get(layer.id) ?? 0]?.joins.get(layer.id);
                return (
                  <div
                    key={layer.id}
                    className="pointer-events-none absolute left-0"
                    style={{ top: (rowOf.get(layer.id) ?? 0) * ROW_H, height: ROW_H, width: contentWidth }}
                  >
                    <TimelineClip
                      layer={layer}
                      pps={pps}
                      rowIndex={rowOf.get(layer.id) ?? 0}
                      rowCount={rows.length}
                      rowHeight={ROW_H}
                      selected={selection.includes(layer.id)}
                      dimmed={currentTime < layer.startTime || currentTime >= layerEnd(layer)}
                      fps={fps}
                      assets={assets}
                      junctionIn={join?.in}
                      junctionOut={join?.out}
                    />
                  </div>
                );
              })}

              {rows.length === 0 && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-km-faint">
                  No layers yet — add media, text, a sticker or an effect track.
                </div>
              )}

              {/* where the dragged clip would land, drawn under the clips so it
                  reads as a space being opened rather than an object on top */}
              {preview && preview.trackId !== undefined && preview.row !== undefined && (
                <div
                  className="pointer-events-none absolute rounded-md border border-dashed border-km-accent bg-km-accent/20"
                  style={{
                    top: preview.row * ROW_H + 3,
                    left: preview.time * pps,
                    width: Math.max(6, preview.duration * pps),
                    height: ROW_H - 6,
                  }}
                />
              )}

              <div
                className="pointer-events-none absolute top-0 z-40 w-px bg-km-accent"
                style={{ left: playheadX, height: contentHeight }}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Toolbar
 * ------------------------------------------------------------------ */

function TimelineToolbar({ rowCount }: { rowCount: number }) {
  const pps = useEditor((s) => s.pixelsPerSecond);
  const snapEnabled = useEditor((s) => s.ui.snapEnabled);
  const showGrid = useEditor((s) => s.ui.showGrid);
  const showSafeArea = useEditor((s) => s.ui.showSafeArea);
  const duration = useEditor(timelineDuration);
  const selection = useEditor((s) => s.selection, shallowArrayEqual);

  const zoomToFit = () => {
    const el = document.querySelector("[data-timeline-viewport]") as HTMLElement | null;
    const width = el?.clientWidth ?? 900;
    editor().setZoom(clamp((width - 40) / Math.max(1, duration), MIN_PPS, MAX_PPS));
  };

  return (
    <div className="flex h-[43px] shrink-0 items-center gap-1.5 border-b border-km-border px-[15px]">
      <ToolButton
        title="Split at playhead (S)"
        onClick={() => {
          const count = editor().splitAtPlayhead();
          if (!count) toast.info("Move the playhead over a clip to split it");
        }}
      >
        <Scissors className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        title="Duplicate (Ctrl+D)"
        disabled={!selection.length}
        onClick={() => editor().duplicateLayers(selection)}
      >
        <Copy className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        title="Delete (Del)"
        disabled={!selection.length}
        onClick={() => editor().removeLayers(selection)}
      >
        <Trash2 className="h-4 w-4" />
      </ToolButton>

      <Divider />

      {/* Z-order is per track, so these shuffle a clip within its own row. */}
      <ToolButton
        title="Bring forward within its track"
        disabled={!selection.length}
        onClick={() => selection.forEach((id) => editor().nudgeLayerZ(id, "up"))}
      >
        <ArrowUp className="h-4 w-4" />
      </ToolButton>
      <ToolButton
        title="Send backward within its track"
        disabled={!selection.length}
        onClick={() => selection.forEach((id) => editor().nudgeLayerZ(id, "down"))}
      >
        <ArrowDown className="h-4 w-4" />
      </ToolButton>

      <Divider />

      <ToolToggle
        title="Snapping"
        active={snapEnabled}
        onClick={() => editor().setUi({ snapEnabled: !snapEnabled })}
      >
        <Magnet className="h-4 w-4" />
      </ToolToggle>
      <ToolToggle title="Grid" active={showGrid} onClick={() => editor().setUi({ showGrid: !showGrid })}>
        <Grid3x3 className="h-4 w-4" />
      </ToolToggle>
      <ToolToggle
        title="Safe area"
        active={showSafeArea}
        onClick={() => editor().setUi({ showSafeArea: !showSafeArea })}
      >
        <Scan className="h-4 w-4" />
      </ToolToggle>

      <div className="ml-auto flex items-center gap-2">
        <span className="hidden text-[11px] text-km-faint lg:inline">
          {rowCount} {rowCount === 1 ? "track" : "tracks"}
        </span>
        <ZoomOut className="h-4 w-4 text-km-faint" />
        <input
          type="range"
          min={MIN_PPS}
          max={MAX_PPS}
          step={1}
          value={Math.round(pps)}
          onChange={(e) => editor().setZoom(Number(e.target.value))}
          className="w-28 cursor-pointer accent-km-accent"
          title="Timeline zoom"
        />
        <ZoomIn className="h-4 w-4 text-km-faint" />
        <ToolButton title="Fit timeline" onClick={zoomToFit}>
          <Maximize2 className="h-4 w-4" />
        </ToolButton>
      </div>
    </div>
  );
}

function ToolButton({
  children,
  title,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded-md text-km-dim transition hover:bg-km-raised hover:text-km-text disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function ToolToggle({
  children,
  title,
  active,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`grid h-8 w-8 place-items-center rounded-md transition hover:bg-km-raised ${
        active ? "bg-km-accent/15 text-km-accent" : "text-km-dim hover:text-km-text"
      }`}
    >
      {children}
    </button>
  );
}

const Divider = () => <div className="mx-1 h-5 w-px bg-km-border" />;

/* ------------------------------------------------------------------ *
 * Ruler
 * ------------------------------------------------------------------ */

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

function chooseStep(pps: number): number {
  const target = 96 / pps;
  return STEPS.find((s) => s >= target) ?? 900;
}

function label(t: number, step: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (step < 1) return `${m}:${s.toFixed(1).padStart(4, "0")}`;
  return `${m}:${Math.round(s).toString().padStart(2, "0")}`;
}

function Ruler({ width, pps }: { width: number; pps: number }) {
  const step = chooseStep(pps);
  const minor = step / 5;
  const ticks: { x: number; major: boolean; label?: string }[] = [];
  const maxTicks = 1400;

  for (let i = 0; i * minor * pps <= width && ticks.length < maxTicks; i++) {
    const t = i * minor;
    const major = i % 5 === 0;
    ticks.push({ x: t * pps, major, label: major ? label(t, step) : undefined });
  }

  return (
    <div className="absolute inset-0">
      {ticks.map((tick, i) => (
        <div
          key={i}
          className={tick.major ? "absolute bottom-0 w-px bg-km-border" : "absolute bottom-0 w-px bg-km-border/50"}
          style={{ left: tick.x, height: tick.major ? 10 : 5 }}
        />
      ))}
      {ticks
        .filter((t) => t.label)
        .map((tick, i) => (
          <span
            key={`l${i}`}
            className="absolute top-0.5 select-none font-mono text-[9.5px] leading-none text-km-faint"
            style={{ left: tick.x + 3 }}
          >
            {tick.label}
          </span>
        ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Track rail
 * ------------------------------------------------------------------ */

/**
 * One rail entry per track. The eye and padlock act on every clip on the row at
 * once — a track is a unit, and "hide this row" is the thing people reach for,
 * not "hide clip 3 of 7".
 */
function TrackRail({ track, clips }: { track: Track; clips: Layer[] }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(track.name);

  const selection = useEditor((s) => s.selection, shallowArrayEqual);
  const anySelected = clips.some((c) => selection.includes(c.id));
  const allHidden = clips.length > 0 && clips.every((c) => c.hidden);
  const allLocked = clips.length > 0 && clips.every((c) => c.locked);

  const startRename = () => {
    setDraft(track.name);
    setRenaming(true);
  };

  const commitRename = () => {
    setRenaming(false);
    const next = draft.trim();
    if (next && next !== track.name) editor().renameTrack(track.id, next);
  };

  const selectRow = () => editor().select(clips.map((c) => c.id));

  return (
    <div
      onPointerDown={(e) => {
        if (renaming) return;
        if (e.shiftKey) clips.forEach((c) => editor().toggleSelect(c.id));
        else if (clips.length) editor().select(clips.map((c) => c.id));
        else editor().clearSelection();
      }}
      className={`group flex items-center gap-1.5 border-b border-km-border/60 px-2 transition ${
        anySelected ? "bg-km-accent/12" : "hover:bg-white/[0.03]"
      }`}
      /* A row is a drop surface of its own: it is the only way to reach a track
         with no clip on it to aim at. A drop here lands on this track at the
         playhead, since the rail has no time axis to read a position from. */
      data-drop="track"
      data-track-id={track.id}
      style={{ height: ROW_H }}
    >
      <span
        className={`h-7 w-1 shrink-0 rounded-full ${
          track.main ? "bg-km-accent" : track.id ? "bg-km-border2" : "bg-km-border"
        }`}
        style={track.main ? undefined : { backgroundColor: "rgba(148,163,184,0.35)" }}
      />

      <div className="min-w-0 flex-1">
        {renaming ? (
          <Input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setRenaming(false);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="h-6 border-km-border bg-km-track px-1 text-[11.5px] text-km-text focus-visible:ring-1 focus-visible:ring-km-accent"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={startRename}
            title={`${track.name} — double-click to rename`}
            className={`block w-full truncate text-left text-[11px] ${
              anySelected ? "text-km-text" : "text-km-dim"
            }`}
          >
            {track.name}
          </button>
        )}
        <div className="flex items-center gap-1 truncate text-[10px] text-km-faint">
          {track.main && (
            <span className="rounded-sm bg-km-accent/20 px-1 text-[8.5px] font-semibold uppercase tracking-wide text-km-accent">
              Main
            </span>
          )}
          <span>
            {clips.length} {clips.length === 1 ? "clip" : "clips"}
          </span>
        </div>
      </div>

      <button
        type="button"
        title={allHidden ? "Show every clip on this track" : "Hide every clip on this track"}
        disabled={!clips.length}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => editor().updateLayers(clips.map((c) => c.id), { hidden: !allHidden })}
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-km-faint transition hover:bg-km-raised hover:text-km-text disabled:opacity-30"
      >
        {allHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        title={allLocked ? "Unlock this track" : "Lock this track"}
        disabled={!clips.length}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => editor().updateLayers(clips.map((c) => c.id), { locked: !allLocked })}
        className={`grid h-6 w-6 shrink-0 place-items-center rounded transition hover:bg-km-raised disabled:opacity-30 ${
          allLocked ? "text-km-accent" : "text-km-faint hover:text-km-text"
        }`}
      >
        {allLocked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="Track options"
            onPointerDown={(e) => e.stopPropagation()}
            className="grid h-6 w-5 shrink-0 place-items-center rounded text-km-faint transition hover:bg-km-raised hover:text-km-text"
          >
            <MoreVertical className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuItem disabled={track.main} onClick={() => editor().setMainTrack(track.id)}>
            Set as main layer
          </DropdownMenuItem>
          <DropdownMenuItem onClick={startRename}>Rename track…</DropdownMenuItem>
          <DropdownMenuItem disabled={!clips.length} onClick={selectRow}>
            Select every clip
          </DropdownMenuItem>
          {!track.main && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-red-300 focus:text-red-200"
                onClick={() => {
                  if (!clips.length || confirm(`Delete “${track.name}” and its ${clips.length} clip(s)?`)) {
                    editor().removeTrack(track.id);
                  }
                }}
              >
                Delete track{clips.length ? ` (${clips.length})` : ""}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * The rail's foot. An explicit "empty track" is the deliberate way to make a
 * row; importing media does not need one, because `placeLayer` homes video onto
 * the main layer and gives everything else its own row.
 */
function AddTrackRow() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 border-b border-km-border/60 px-2 text-[11px] text-km-dim transition hover:bg-white/[0.03] hover:text-km-text"
          style={{ height: ROW_H }}
        >
          <span className="grid h-6 w-6 place-items-center rounded bg-km-raised text-km-accent">
            <Plus className="h-3.5 w-3.5" />
          </span>
          Add track
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem onClick={() => editor().addTrack()}>Empty track</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-km-faint">New layer</DropdownMenuLabel>
        <DropdownMenuItem onClick={() => editor().addTextLayer()}>Text</DropdownMenuItem>
        <DropdownMenuItem onClick={() => editor().addStickerLayer({ ...DEFAULT_SHAPE_STYLE, glyph: "⭐" })}>
          Sticker
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wide text-km-faint">
          From the library
        </DropdownMenuLabel>
        <DropdownMenuItem onClick={() => editor().setUi({ libraryTab: "shape" })}>Shapes…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => editor().setUi({ libraryTab: "sticker" })}>Stickers…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => editor().setUi({ libraryTab: "effect" })}>Effects…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => editor().setUi({ libraryTab: "background" })}>Backgrounds…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => void importFromInput({ addToTimeline: true })}>Import media…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
