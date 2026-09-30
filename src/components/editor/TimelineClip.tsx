/**
 * A single clip on the timeline: move (drag body), trim (drag edges), vertical
 * drag to move it between tracks, plus keyframe markers and an audio waveform.
 *
 * All drags work from an origin snapshot and are recorded into history once per
 * gesture, so undo restores the clip exactly where it started.
 */
import { useRef } from "react";
import { CornerDownRight, CornerRightUp, Link2 } from "lucide-react";
import {
  LAYER_COLORS,
  MIN_LAYER_DURATION,
  collectSnapTargets,
  layerEnd,
  snapValue,
} from "@/lib/project";
import { isNoopTransition, transitionDef } from "@/lib/transitions";
import { trackAtRow } from "@/lib/tracks";
import { clamp, snapToFrame } from "@/lib/time";
import { editor, editorStore } from "@/store/editorStore";
import type { Asset, Layer } from "@/types/editor";
import type { Junction } from "@/lib/bonds";

const EDGE_PX = 10;
const SNAP_PX = 8;

interface Props {
  layer: Layer;
  pps: number;
  rowIndex: number;
  rowCount: number;
  rowHeight: number;
  selected: boolean;
  dimmed: boolean;
  fps: number;
  assets: Record<string, Asset>;
  /** The junction on this clip's left edge, when it joins the clip before it. */
  junctionIn?: Junction;
  /** The junction on this clip's right edge, when it joins the clip after it. */
  junctionOut?: Junction;
}

type Drag =
  | { kind: "none" }
  | {
      kind: "move";
      startX: number;
      startY: number;
      origins: { id: string; startTime: number }[];
      targets: number[];
      recorded: boolean;
      rowIndex: number;
    }
  | {
      kind: "trim";
      edge: "start" | "end";
      startX: number;
      origin: { startTime: number; duration: number; inPoint: number };
      hasSource: boolean;
      sourceDuration: number;
      targets: number[];
      recorded: boolean;
    };

export default function TimelineClip({
  layer,
  pps,
  rowIndex,
  rowCount,
  rowHeight,
  selected,
  dimmed,
  fps,
  assets,
  junctionIn,
  junctionOut,
}: Props) {
  const dragRef = useRef<Drag>({ kind: "none" });
  const width = Math.max(6, layer.duration * pps);
  const left = layer.startTime * pps;
  const asset = layer.assetId ? assets[layer.assetId] : undefined;

  const recordOnce = () => {
    if ("recorded" in dragRef.current && !dragRef.current.recorded) {
      editor().pushHistory();
      dragRef.current.recorded = true;
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const st = editorStore.getState();
    const already = st.selection.includes(layer.id);
    if (e.shiftKey) editor().toggleSelect(layer.id);
    else if (!already) editor().select([layer.id]);

    if (layer.locked) return;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const roomy = width > EDGE_PX * 3;
    const mode: "start" | "end" | "move" =
      offsetX < EDGE_PX && roomy
        ? "start"
        : offsetX > rect.width - EDGE_PX && roomy && canTrimEnd
          ? "end"
          : "move";

    const ids = editorStore.getState().selection.includes(layer.id)
      ? editorStore.getState().selection
      : [layer.id];

    if (mode === "move") {
      dragRef.current = {
        kind: "move",
        startX: e.clientX,
        startY: e.clientY,
        rowIndex,
        origins: ids
          .map((id) => st.project.layers[id])
          .filter(Boolean)
          .map((l) => ({ id: l.id, startTime: l.startTime })),
        targets: collectSnapTargets(st.project, ids),
        recorded: false,
      };
    } else {
      dragRef.current = {
        kind: "trim",
        edge: mode,
        startX: e.clientX,
        origin: { startTime: layer.startTime, duration: layer.duration, inPoint: layer.inPoint },
        hasSource: layer.type === "video" || layer.type === "audio",
        sourceDuration: asset?.duration ?? 0,
        targets: collectSnapTargets(st.project, [layer.id]),
        recorded: false,
      };
    }

    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (drag.kind === "none") return;
      const dt = (ev.clientX - drag.startX) / pps;

      if (drag.kind === "move") {
        const dx = ev.clientX - drag.startX;
        const dy = ev.clientY - drag.startY;

        // Horizontal movement shifts the clip(s) along the timeline.
        if (Math.abs(dx) >= 2) {
          const primary = drag.origins.find((o) => o.id === layer.id) ?? drag.origins[0];
          const raw = Math.max(0, primary.startTime + dt);
          const tol = SNAP_PX / pps;
          const startSnap = snapValue(raw, drag.targets, tol);
          const endSnap = snapValue(raw + layer.duration, drag.targets, tol);
          const startDist = startSnap.target === null ? Infinity : Math.abs(startSnap.value - raw);
          const endDist = endSnap.target === null ? Infinity : Math.abs(endSnap.value - (raw + layer.duration));
          let next =
            startDist <= endDist ? startSnap.value : endSnap.value - layer.duration;
          next = Math.max(0, snapToFrame(next, fps));
          const delta = next - primary.startTime;
          recordOnce();
          editor().setLayersStart(
            drag.origins.map((o) => [o.id, o.startTime + delta]),
            false,
          );
        }

        // Vertical drag moves the clip to another track — independent of any
        // horizontal movement, so a clean vertical drag alone works.
        const rows = Math.round(dy / rowHeight);
        if (rows !== 0) {
          recordOnce();
          const targetRow = clamp(drag.rowIndex + rows, 0, Math.max(0, rowCount - 1));
          // Read the live project rather than the pointerdown snapshot: this
          // gesture may already have moved the clip once, and the snapshot is
          // a track behind by now.
          const live = editorStore.getState().project;
          const current = live.layers[layer.id];
          const track = trackAtRow(live, targetRow);
          if (track && current && current.trackId !== track.id) {
            editor().moveLayerToTrack(layer.id, track.id, false);
          }
          drag.rowIndex = targetRow;
          drag.startY = ev.clientY;
        }
        return;
      }

      // trim
      const { origin } = drag;
      const tol = SNAP_PX / pps;
      if (drag.edge === "start") {
        let nextStart = clamp(origin.startTime + dt, 0, origin.startTime + origin.duration - MIN_LAYER_DURATION);
        let nextIn = origin.inPoint;
        if (drag.hasSource && drag.sourceDuration) {
          const consumed = clamp(origin.inPoint + (nextStart - origin.startTime), 0, drag.sourceDuration - MIN_LAYER_DURATION);
          nextStart = origin.startTime + (consumed - origin.inPoint);
          nextIn = consumed;
        }
        const snap = snapValue(nextStart, drag.targets, tol);
        if (snap.target !== null) {
          const shift = snap.value - nextStart;
          nextStart += shift;
          if (drag.hasSource && drag.sourceDuration) nextIn += shift;
        }
        recordOnce();
        editor().updateLayer(
          layer.id,
          {
            startTime: Math.max(0, nextStart),
            inPoint: Math.max(0, nextIn),
            duration: layerEnd(layer) - Math.max(0, nextStart),
          },
          false,
        );
        return;
      }

      let nextEnd = Math.max(origin.startTime + MIN_LAYER_DURATION, origin.startTime + origin.duration + dt);
      if (drag.hasSource && drag.sourceDuration) {
        nextEnd = Math.min(nextEnd, origin.startTime + (drag.sourceDuration - origin.inPoint));
      }
      const snap = snapValue(nextEnd, drag.targets, tol);
      if (snap.target !== null) nextEnd = snap.value;
      recordOnce();
      editor().updateLayer(layer.id, { duration: nextEnd - origin.startTime }, false);
    };

    const onUp = () => {
      dragRef.current = { kind: "none" };
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onDoubleClick = () => {
    editor().select([layer.id]);
    editor().setUi({
      inspectorTab:
        layer.type === "text"
          ? "text"
          : layer.type === "audio"
            ? "audio"
            : layer.type === "effect"
              ? "effect"
              : "transform",
    });
  };

  /* a badge deep-links straight to that edge's controls in the Inspector */
  const openTransition = (edge: "in" | "out") => {
    editor().select([layer.id]);
    editor().setUi({ transitionEdge: edge, inspectorTab: "transition" });
  };

  const color = LAYER_COLORS[layer.type];
  const hasWave = (layer.type === "audio" || layer.type === "video") && (asset?.waveform?.length ?? 0) > 0;
  const hasFilm = (layer.type === "video" || layer.type === "image") && !!asset?.thumbnail;
  const keyframeTimes = selected
    ? [...new Set(layer.keyframes.map((k) => Math.round(k.time * 1000) / 1000))]
    : [];
  /* A bond genuinely overlaps this clip with its neighbour, so the incoming
     ramp is as long as the overlap — which can exceed the old "half the clip"
     cap. Showing the true width is what makes the seam legible. */
  const fadeInW = junctionIn?.bonded
    ? Math.min(width, junctionIn.overlap * pps)
    : layer.transitionIn.type !== "none"
      ? Math.min(width * 0.5, layer.transitionIn.duration * pps)
      : 0;
  const fadeOutW = layer.transitionOut.type !== "none" ? Math.min(width * 0.5, layer.transitionOut.duration * pps) : 0;

  /* A bond is a real transition, so each edge still earns a badge — but the
     out-edge badge points at the junction, not at a clip-edge transition. */
  const inDef = isNoopTransition(layer.transitionIn) ? undefined : transitionDef(layer.transitionIn.type);
  const outDef = isNoopTransition(layer.transitionOut) ? undefined : transitionDef(layer.transitionOut.type);
  const nameFits = width >= (inDef && outDef ? 150 : 80);
  const inBond = !!junctionIn?.bonded;
  const outBond = !!junctionOut?.bonded;

  /* The outgoing side of a bond must not be trimmed: its tail IS the overlap,
     and shortening it here would quietly leave the incoming clip ramping over
     nothing. Bond length is edited in the junction popover instead. */
  const canTrimEnd = !outBond;

  return (
    <div
      role="button"
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      className={`group pointer-events-auto absolute top-1 overflow-hidden rounded-md border transition-shadow ${
        selected ? "border-km-accent shadow-[0_0_0_1px_rgba(59,130,246,0.7)]" : "border-black/40"
      } ${dimmed ? "opacity-45" : ""}`}
      style={{
        left,
        width,
        height: rowHeight - 8,
        backgroundColor: `${color}33`,
        cursor: layer.locked ? "default" : "grab",
      }}
      title={`${layer.name} · ${layer.duration.toFixed(2)}s`}
    >
      {hasFilm && (
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            backgroundImage: `url(${asset!.thumbnail})`,
            backgroundSize: "auto 100%",
            backgroundRepeat: "repeat-x",
          }}
        />
      )}
      <div className="pointer-events-none absolute inset-0" style={{ backgroundColor: `${color}26` }} />

      {hasWave && (
        <Waveform
          peaks={asset!.waveform!}
          inPoint={layer.inPoint}
          duration={layer.duration}
          sourceDuration={asset!.duration || 1}
          width={width}
          height={rowHeight - 8}
          color={color}
        />
      )}

      {/* transition ramps */}
      {fadeInW > 0 && (
        <div
          className="pointer-events-none absolute left-0 top-0 h-full"
          style={{ width: fadeInW, background: "linear-gradient(90deg, rgba(0,0,0,0.65), rgba(0,0,0,0))" }}
        />
      )}
      {fadeOutW > 0 && (
        <div
          className="pointer-events-none absolute right-0 top-0 h-full"
          style={{ width: fadeOutW, background: "linear-gradient(270deg, rgba(0,0,0,0.65), rgba(0,0,0,0))" }}
        />
      )}

      {/* transition badges — one per edge, click to edit that edge */}
      {(inDef || inBond) && (
        <TransitionBadge
          edge="in"
          label={inDef?.label ?? "Bond"}
          bonded={inBond}
          showLabel={nameFits}
          onClick={() => openTransition("in")}
        />
      )}
      {(outDef || outBond) && (
        <TransitionBadge
          edge="out"
          label={outDef?.label ?? "Bond"}
          bonded={outBond}
          showLabel={nameFits}
          onClick={() => openTransition("out")}
        />
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 px-1.5 py-0.5">
        <span className="truncate text-[11px] font-medium text-white drop-shadow">{layer.name}</span>
        <span className="shrink-0 font-mono text-[10px] text-white/70">{layer.duration.toFixed(1)}s</span>
      </div>

      {keyframeTimes.map((t) => (
        <span
          key={t}
          className="pointer-events-none absolute bottom-4 h-2 w-2 rotate-45 border border-white/70 bg-km-accent"
          style={{ left: Math.max(1, t * pps - 4) }}
        />
      ))}

      {layer.hidden && <div className="pointer-events-none absolute inset-0 bg-black/55" />}

      {!layer.locked && (
        <>
          <div
            className="absolute inset-y-0 left-0 w-2.5 cursor-ew-resize bg-white/0 transition group-hover:bg-white/20"
            title="Trim start"
          />
          {canTrimEnd && (
            <div
              className="absolute inset-y-0 right-0 w-2.5 cursor-ew-resize bg-white/0 transition group-hover:bg-white/20"
              title="Trim end"
            />
          )}
        </>
      )}
    </div>
  );
}

function TransitionBadge({
  edge,
  label,
  bonded,
  showLabel,
  onClick,
}: {
  edge: "in" | "out";
  label: string;
  bonded?: boolean;
  showLabel: boolean;
  onClick: () => void;
}) {
  const Icon = bonded ? Link2 : edge === "in" ? CornerDownRight : CornerRightUp;
  return (
    <button
      type="button"
      title={
        bonded
          ? `Bonded to the neighbouring clip (${label}) — click to edit the bond`
          : `${label} — ${edge === "in" ? "enter" : "exit"} transition. Click to edit.`
      }
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`absolute bottom-0.5 z-10 flex max-w-[calc(100%-6px)] items-center gap-[3px] rounded-sm border border-white/15 bg-black/70 py-[1px] text-[9px] font-medium leading-none text-white/90 backdrop-blur-sm transition hover:border-km-accent hover:bg-km-accent ${
        edge === "in" ? "left-0.5" : "right-0.5"
      }`}
      style={{ paddingLeft: 3, paddingRight: showLabel ? 4 : 3 }}
    >
      <Icon className="h-2.5 w-2.5 shrink-0" />
      {showLabel && <span className="truncate">{label}</span>}
    </button>
  );
}

function Waveform({
  peaks,
  inPoint,
  duration,
  sourceDuration,
  width,
  height,
  color,
}: {
  peaks: number[];
  inPoint: number;
  duration: number;
  sourceDuration: number;
  width: number;
  height: number;
  color: string;
}) {
  const buckets = Math.max(2, Math.min(160, Math.round(width / 3)));
  const startFrac = clamp(inPoint / sourceDuration, 0, 1);
  const endFrac = clamp((inPoint + duration) / sourceDuration, 0, 1);
  const mid = height / 2;
  const top: string[] = [];
  const bottom: string[] = [];

  for (let i = 0; i < buckets; i++) {
    const frac = startFrac + ((endFrac - startFrac) * i) / (buckets - 1);
    const peak = peaks[Math.min(peaks.length - 1, Math.floor(frac * peaks.length))] ?? 0;
    const amp = Math.max(0.5, peak * (height * 0.42));
    const x = ((width * i) / (buckets - 1)).toFixed(1);
    top.push(`${x},${(mid - amp).toFixed(1)}`);
    bottom.push(`${x},${(mid + amp).toFixed(1)}`);
  }

  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
    >
      <polyline points={top.join(" ")} fill="none" stroke={color} strokeWidth={1} opacity={0.95} />
      <polyline points={bottom.reverse().join(" ")} fill="none" stroke={color} strokeWidth={1} opacity={0.95} />
    </svg>
  );
}
