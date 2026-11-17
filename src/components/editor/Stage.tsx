/**
 * THE STAGE — live preview plus direct manipulation.
 *
 * The canvas draws the composition at full project resolution through the
 * shared compositor, and a DOM overlay on top provides selection boxes, handles,
 * marquee selection and snap guides. All pointer math happens in project pixels
 * via a single view scale, so dragging behaves identically at any zoom level.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { drawFrame, DEFAULT_WRAP_RATIO } from "@/lib/compositor";
import {
  boundsIntersect,
  boundsOf,
  corners,
  evaluatedBox,
  handlesOf,
  pivotFor,
  rotatePoint,
  pointInBox,
  snapBox,
  snapTargets,
  type Box,
  type Guide,
  type HandleId,
  type Point,
} from "@/lib/geometry";
import { layerEnd, orderedLayers, topFirstLayers } from "@/lib/project";
import { clamp } from "@/lib/time";
import { editor, editorStore, useEditor } from "@/store/editorStore";
import type { Layer, LayerId } from "@/types/editor";
import { importFiles } from "@/lib/importFiles";
import { useDrag } from "@/lib/mediaDrag";

const MIN_SCALE = 0.02;
const MAX_SCALE = 40;
const SNAP_PX = 9;

interface BoxEntry {
  id: LayerId;
  box: Box;
  layer: Layer;
}

type Drag =
  | { kind: "none" }
  | {
      kind: "move";
      start: Point;
      origins: { id: LayerId; x: number; y: number }[];
      primary: Box;
      targets: { x: number[]; y: number[] };
      tolerance: number;
      recorded: boolean;
    }
  | {
      kind: "resize";
      id: LayerId;
      handle: HandleId;
      pivot: Point;
      d0: number;
      scale0: number;
      scaleX0: number;
      scaleY0: number;
      cx0: number;
      cy0: number;
      rotation0: number;
      origin: Point;
      recorded: boolean;
    }
  | {
      kind: "rotate";
      id: LayerId;
      cx: number;
      cy: number;
      rotation0: number;
      angle0: number;
      recorded: boolean;
    }
  | { kind: "marquee"; start: Point; additive: boolean };

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const angleOf = (from: Point, to: Point) => (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;

const tabForLayer = (layer: Layer | undefined): "transform" | "text" | "audio" | "effect" =>
  layer?.type === "text" ? "text" : layer?.type === "audio" ? "audio" : layer?.type === "effect" ? "effect" : "transform";

export default function Stage() {
  const settings = useEditor((s) => s.project.settings);
  const project = useEditor((s) => s.project);
  const assets = useEditor((s) => s.assets);
  const selection = useEditor((s) => s.selection);
  const currentTime = useEditor((s) => s.currentTime);
  const snapEnabled = useEditor((s) => s.ui.snapEnabled);
  const showGrid = useEditor((s) => s.ui.showGrid);
  const showSafeArea = useEditor((s) => s.ui.showSafeArea);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<Drag>({ kind: "none" });
  const boxesRef = useRef<BoxEntry[]>([]);
  const seekRef = useRef(0);

  const [scale, setScale] = useState(0.5);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<{ a: Point; b: Point } | null>(null);
  const [dropping, setDropping] = useState(false);
  const [cursor, setCursor] = useState("default");
  const cursorRef = useRef("default");

  /* Cursor feedback is state, not a read of the drag ref: a ref mutation cannot
     repaint the frame it happened in, so the cursor would never change. */
  const showCursor = useCallback((next: string) => {
    if (cursorRef.current === next) return;
    cursorRef.current = next;
    setCursor(next);
  }, []);

  /* True while a library item is being dragged over the stage. The ring is the
     same one the OS-file drop shows: either way the drop lands at the playhead,
     so it should not read as two different gestures. */
  const overStage = useDrag((state) => state?.target?.surface === "stage");

  /* ---------------- viewport sizing ---------------- */

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const pad = 56;
      const next = Math.min(
        (rect.width - pad) / settings.width,
        (rect.height - pad) / settings.height,
      );
      if (Number.isFinite(next) && next > 0) setScale(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [settings.width, settings.height]);

  /* ---------------- canvas rendering ---------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // The canvas is sized to the project, so one draw call == one export frame.
    canvas.width = settings.width;
    canvas.height = settings.height;

    let raf = 0;
    const draw = () => {
      raf = 0;
      const st = editorStore.getState();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      drawFrame({
        ctx,
        settings: st.project.settings,
        layers: orderedLayers(st.project),
        assets: st.assets,
        time: st.currentTime,
        // In image mode the canvas is a single still, so entry animations render
        // settled — otherwise a "typewriter" or "slide up" title is blank at t=0.
        animationComplete: st.ui.mode === "image",
      });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };

    const unsubscribe = editorStore.subscribe(schedule);
    // Media readiness changes (a poster frame arriving) must repaint too.
    const timer = window.setInterval(schedule, 500);
    schedule();
    return () => {
      unsubscribe();
      window.clearInterval(timer);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [settings.width, settings.height]);

  /* ---------------- boxes for the current time ---------------- */

  const boxes = useMemo<BoxEntry[]>(() => {
    const out: BoxEntry[] = [];
    for (const layer of orderedLayers(project)) {
      if (layer.type === "audio" || layer.hidden) continue;
      if (currentTime < layer.startTime - 1e-6 || currentTime >= layerEnd(layer) - 1e-6) continue;
      const box = evaluatedBox(layer, assets, settings, currentTime);
      if (box) out.push({ id: layer.id, box, layer });
    }
    return out;
  }, [project, assets, settings, currentTime]);

  boxesRef.current = boxes;

  const selectedBoxes = useMemo(
    () => boxes.filter((b) => selection.includes(b.id)),
    [boxes, selection],
  );
  const handleBox = selection.length === 1 ? selectedBoxes[0] : undefined;

  /* ---------------- pointer helpers ---------------- */

  const toProject = useCallback((clientX: number, clientY: number): Point => {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return { x: 0, y: 0 };
    const st = editorStore.getState();
    return {
      x: ((clientX - rect.left) / rect.width) * st.project.settings.width,
      y: ((clientY - rect.top) / rect.height) * st.project.settings.height,
    };
  }, []);

  const beginMove = useCallback(
    (start: Point, hitId: LayerId) => {
      const st = editorStore.getState();
      const ids = st.selection.includes(hitId) ? st.selection : [hitId];
      const origins = ids
        .map((id) => st.project.layers[id])
        .filter(Boolean)
        .map((l) => ({ id: l.id, x: l.transform.x, y: l.transform.y }));
      const primary = boxesRef.current.find((b) => b.id === ids[ids.length - 1])?.box;
      if (!primary) return;
      dragRef.current = {
        kind: "move",
        start,
        origins,
        primary,
        targets: snapTargets(
          boxesRef.current.filter((b) => !ids.includes(b.id)),
          st.project.settings,
        ),
        tolerance: SNAP_PX / Math.max(0.05, scale),
        recorded: false,
      };
    },
    [scale],
  );

  const beginResize = useCallback((id: LayerId, handle: HandleId, box: Box, p: Point) => {
    const pivot = pivotFor(box, handle);
    const d0 = dist(pivot, p);
    if (d0 < 1e-3) return;
    dragRef.current = {
      kind: "resize",
      id,
      handle,
      pivot,
      d0,
      scale0: box.scale,
      scaleX0: box.scaleX ?? 1,
      scaleY0: box.scaleY ?? 1,
      cx0: box.cx,
      cy0: box.cy,
      rotation0: box.rotation,
      origin: p,
      recorded: false,
    };
  }, []);

  const beginRotate = useCallback((id: LayerId, box: Box, p: Point) => {
    dragRef.current = {
      kind: "rotate",
      id,
      cx: box.cx,
      cy: box.cy,
      rotation0: editorStore.getState().project.layers[id]?.transform.rotation ?? 0,
      angle0: angleOf({ x: box.cx, y: box.cy }, p),
      recorded: false,
    };
  }, []);

  /** Records the pre-drag project into history exactly once per gesture. */
  const recordOnce = (drag: Drag) => {
    if ("recorded" in drag && !drag.recorded) {
      editor().pushHistory();
      drag.recorded = true;
    }
  };

  /* ---------------- global drag listeners ---------------- */

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (drag.kind === "none") return;
      const p = toProject(e.clientX, e.clientY);

      if (drag.kind === "move") {
        let dx = p.x - drag.start.x;
        let dy = p.y - drag.start.y;
        if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return;
        if (snapEnabled) {
          const snapped = snapBox(drag.primary, dx, dy, drag.targets, drag.tolerance);
          dx = snapped.x - drag.primary.cx;
          dy = snapped.y - drag.primary.cy;
          setGuides(snapped.guides);
        }
        recordOnce(drag);
        for (const o of drag.origins) {
          editor().updateLayerTransform(o.id, { x: o.x + dx, y: o.y + dy }, false);
        }
        return;
      }

      if (drag.kind === "resize") {
        const localP = rotatePoint(p, drag.pivot, -drag.rotation0);
        const localOrigin = rotatePoint(drag.origin, drag.pivot, -drag.rotation0);
        
        let ratioX = 1;
        let ratioY = 1;

        if (["e", "w"].includes(drag.handle)) {
          const d1 = Math.abs(localP.x - drag.pivot.x);
          const d0 = Math.max(0.001, Math.abs(localOrigin.x - drag.pivot.x));
          ratioX = d1 / d0;
        } else if (["n", "s"].includes(drag.handle)) {
          const d1 = Math.abs(localP.y - drag.pivot.y);
          const d0 = Math.max(0.001, Math.abs(localOrigin.y - drag.pivot.y));
          ratioY = d1 / d0;
        } else {
          // corners scale uniformly
          const d1 = dist(drag.pivot, p);
          ratioX = ratioY = d1 / drag.d0;
        }

        const layer = editorStore.getState().project.layers[drag.id];
        const isTextSide = layer?.type === "text" && layer.text && ["e", "w"].includes(drag.handle);

        const localC0 = rotatePoint({ x: drag.cx0, y: drag.cy0 }, drag.pivot, -drag.rotation0);
        const localC1 = {
          x: drag.pivot.x + (localC0.x - drag.pivot.x) * ratioX,
          y: drag.pivot.y + (localC0.y - drag.pivot.y) * ratioY
        };
        const newCenter = rotatePoint(localC1, drag.pivot, drag.rotation0);

        if (isTextSide) {
          const oldBoxWidth = layer.text!.boxWidth ?? (editorStore.getState().project.settings.width * DEFAULT_WRAP_RATIO);
          const newBoxWidth = Math.max(10, oldBoxWidth * ratioX);
          
          recordOnce(drag);
          editor().updateLayer(drag.id, { text: { ...layer.text!, boxWidth: newBoxWidth } });
          editor().updateLayerTransform(
            drag.id,
            { x: newCenter.x, y: newCenter.y },
            false
          );
          return;
        }

        const nextScale = clamp(drag.scale0 * (ratioX === ratioY ? ratioX : 1), MIN_SCALE, MAX_SCALE);
        let nextScaleX = drag.scaleX0;
        let nextScaleY = drag.scaleY0;

        if (ratioX !== ratioY) {
          if (["e", "w"].includes(drag.handle)) {
             nextScaleX = Math.max(0.01, drag.scaleX0 * ratioX);
          } else {
             nextScaleY = Math.max(0.01, drag.scaleY0 * ratioY);
          }
        }

        recordOnce(drag);
        editor().updateLayerTransform(
          drag.id,
          {
            scale: nextScale,
            scaleX: nextScaleX,
            scaleY: nextScaleY,
            x: newCenter.x,
            y: newCenter.y,
          },
          false,
        );
        return;
      }

      if (drag.kind === "rotate") {
        const delta = angleOf({ x: drag.cx, y: drag.cy }, p) - drag.angle0;
        let rotation = drag.rotation0 + delta;
        if (e.shiftKey) rotation = Math.round(rotation / 15) * 15;
        else if (snapEnabled) {
          const nearest90 = Math.round(rotation / 90) * 90;
          if (Math.abs(rotation - nearest90) < 5) rotation = nearest90;
        }
        recordOnce(drag);
        editor().updateLayerTransform(drag.id, { rotation }, false);
        return;
      }

      if (drag.kind === "marquee") {
        setMarquee({ a: drag.start, b: p });
        const rect = boundsOf([drag.start, p]);
        const hits = boxesRef.current
          .filter((b) => !b.layer.locked && boundsIntersect(boundsOf(corners(b.box)), rect))
          .map((b) => b.id);
        editor().select(drag.additive ? [...new Set([...editorStore.getState().selection, ...hits])] : hits);
      }
    };

    const onUp = () => {
      const drag = dragRef.current;
      if (drag.kind === "none") return;
      dragRef.current = { kind: "none" };
      setGuides([]);
      setMarquee(null);
      showCursor("default");
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [toProject, snapEnabled, showCursor]);

  /** Layer under the pointer, if any — shared by hover, click and double-click. */
  const hitTest = useCallback((p: Point): BoxEntry | undefined => {
    const st = editorStore.getState();
    return topFirstLayers(st.project)
      .map((layer) => boxesRef.current.find((b) => b.id === layer.id))
      .find((entry): entry is BoxEntry => !!entry && !entry.layer.locked && pointInBox(p, entry.box));
  }, []);

  /* ---------------- overlay pointer down ---------------- */

  const onOverlayPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = toProject(e.clientX, e.clientY);
    const st = editorStore.getState();

    const hit = hitTest(p);

    if (hit) {
      const already = st.selection.includes(hit.id);
      if (e.shiftKey) {
        editor().toggleSelect(hit.id);
        if (already) return;
      } else if (!already) {
        editor().select([hit.id]);
      }
      showCursor("grabbing");
      beginMove(p, hit.id);
      return;
    }

    if (!e.shiftKey) editor().clearSelection();
    dragRef.current = { kind: "marquee", start: p, additive: e.shiftKey };
    setMarquee({ a: p, b: p });
    e.preventDefault();
  };

  const onOverlayPointerMove = (e: React.PointerEvent) => {
    if (dragRef.current.kind !== "none") return;
    showCursor(hitTest(toProject(e.clientX, e.clientY)) ? "move" : "default");
  };

  const onOverlayDoubleClick = (e: React.PointerEvent | React.MouseEvent) => {
    const hit = hitTest(toProject(e.clientX, e.clientY));
    if (!hit) return;
    editor().select([hit.id]);
    editor().setUi({ inspectorTab: tabForLayer(hit.layer) });
  };

  /* ---------------- media drop ---------------- */

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) await importFiles(files, { addToTimeline: true });
  };

  const displayW = Math.round(settings.width * scale);
  const displayH = Math.round(settings.height * scale);

  return (
    <div
      ref={wrapRef}
      className="studio-stage-dots relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
      /* The frame is a drop surface too: a media drop anywhere over it becomes a
         new layer at the playhead, centred on the canvas. */
      data-drop="stage"
      onDragOver={(e) => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <div
        className="relative border border-[#44464b] shadow-[0_18px_70px_rgba(0,0,0,0.55)]"
        style={{ width: displayW, height: displayH, cursor }}
      >
        <canvas ref={canvasRef} className="block h-full w-full bg-black" />

        <div
          ref={overlayRef}
          className="absolute inset-0"
          style={{ touchAction: "none" }}
          onPointerDown={onOverlayPointerDown}
          onPointerMove={onOverlayPointerMove}
          onPointerLeave={() => showCursor("default")}
          onDoubleClick={onOverlayDoubleClick}
        >
          {/* safe area + thirds */}
          {showSafeArea && (
            <div className="pointer-events-none absolute" style={{ inset: "5%" }}>
              <div className="h-full w-full border border-dashed border-white/25" />
            </div>
          )}
          {showGrid && (
            <div className="pointer-events-none absolute inset-0">
              {[1, 2].map((i) => (
                <div key={`v${i}`} className="absolute top-0 h-full w-px bg-white/15" style={{ left: `${(i * 100) / 3}%` }} />
              ))}
              {[1, 2].map((i) => (
                <div key={`h${i}`} className="absolute left-0 h-px w-full bg-white/15" style={{ top: `${(i * 100) / 3}%` }} />
              ))}
            </div>
          )}

          {/* selected layer outlines */}
          {selectedBoxes.map(({ id, box, layer }) => (
            <SelectionOutline key={id} box={box} scale={scale} label={layer.name} primary={selection.length === 1} />
          ))}

          {/* handles for a single selection */}
          {handleBox && (
            <>
              {handlesOf(handleBox.box).map((h) => (
                <Handle
                  key={h.id}
                  handle={h.id}
                  point={h.point}
                  scale={scale}
                  rotation={handleBox.box.rotation}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    const p = toProject(e.clientX, e.clientY);
                    if (h.id === "rotate") beginRotate(handleBox.id, handleBox.box, p);
                    else beginResize(handleBox.id, h.id, handleBox.box, p);
                  }}
                />
              ))}
            </>
          )}

          {/* snap guides */}
          {guides.map((g, i) =>
            g.axis === "x" ? (
              <div
                key={`gx${i}`}
                className="pointer-events-none absolute top-0 h-full w-px bg-km-accent/90"
                style={{ left: g.position * scale }}
              />
            ) : (
              <div
                key={`gy${i}`}
                className="pointer-events-none absolute left-0 h-px w-full bg-km-accent/90"
                style={{ top: g.position * scale }}
              />
            ),
          )}

          {/* marquee */}
          {marquee && (
            <div
              className="pointer-events-none absolute border border-km-accent bg-km-accent/15"
              style={{
                left: Math.min(marquee.a.x, marquee.b.x) * scale,
                top: Math.min(marquee.a.y, marquee.b.y) * scale,
                width: Math.abs(marquee.b.x - marquee.a.x) * scale,
                height: Math.abs(marquee.b.y - marquee.a.y) * scale,
              }}
            />
          )}

          {project.layerIds.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm font-medium text-white/80">Drop video, image or audio here</p>
              <p className="text-xs text-white/45">or add a layer from the left panel</p>
            </div>
          )}
        </div>
      </div>

      {(dropping || overStage) && (
        <div className="pointer-events-none absolute inset-3 rounded-xl border-2 border-dashed border-km-accent bg-km-accent/10" />
      )}

      <div className="pointer-events-none absolute bottom-2 left-3 text-[11px] text-km-faint">
        {settings.width} × {settings.height} · {Math.round(scale * 100)}%
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Presentational bits
 * ------------------------------------------------------------------ */

function SelectionOutline({
  box,
  scale,
  label,
  primary,
}: {
  box: Box;
  scale: number;
  label: string;
  primary: boolean;
}) {
  return (
    <div
      className="pointer-events-none absolute"
      style={{
        left: (box.cx - box.w / 2) * scale,
        top: (box.cy - box.h / 2) * scale,
        width: box.w * scale,
        height: box.h * scale,
        transform: `rotate(${box.rotation}deg)`,
        transformOrigin: "center",
      }}
    >
      <div className={`h-full w-full border ${primary ? "border-km-accent" : "border-km-accent/60"}`} />
      <span className="absolute -top-6 left-0 max-w-full truncate rounded bg-km-accent px-1.5 py-0.5 text-[10px] font-medium text-km-bg">
        {label}
      </span>
    </div>
  );
}

const HANDLE_CURSOR: Record<HandleId, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
  rotate: "grab",
};

function Handle({
  handle,
  point,
  scale,
  rotation,
  onPointerDown,
}: {
  handle: HandleId;
  point: Point;
  scale: number;
  rotation: number;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  const isRotate = handle === "rotate";
  const size = isRotate ? 18 : 13;
  return (
    <div
      role="button"
      tabIndex={-1}
      onPointerDown={onPointerDown}
      className={
        isRotate
          ? "absolute flex items-center justify-center rounded-full border-2 border-white bg-km-accent text-[9px] text-km-bg"
          : "absolute rounded-sm border-2 border-white bg-km-accent"
      }
      style={{
        left: point.x * scale,
        top: point.y * scale,
        width: size,
        height: size,
        transform: `translate(-50%, -50%) rotate(${-rotation}deg)`,
        cursor: HANDLE_CURSOR[handle],
        touchAction: "none",
      }}
    >
      {isRotate ? "↻" : null}
    </div>
  );
}
