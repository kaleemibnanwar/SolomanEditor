/**
 * Drag-to-place for media.
 *
 * This is a POINTER drag, not HTML5 drag-and-drop, and that is the whole point:
 * a pointer drag fires no `dragenter`/`drop` events at all, so nothing has to be
 * gated off while it runs (the stage can keep its OS-file drop ring, a slider
 * can keep working, and a drop surface never has to call `preventDefault`). The
 * module also owns the ghost and the live drop preview, so a surface takes part
 * by declaring WHAT it is with a `data-drop` attribute and nothing else — there
 * is no per-surface event plumbing to keep in sync.
 *
 *   [data-drop="timeline"]  data-pps  data-row-h        the timeline scroller
 *   [data-drop="track"]     data-track-id               one rail row
 *   [data-drop="stage"]                                 the canvas
 *
 * The drop point is found by hit-testing `document.elementFromPoint`, which is
 * why the ghost has to be `pointer-events-none`: anything drawn under the
 * cursor that can be hit would become the answer instead of the surface below.
 *
 * Dragging only *arms* on pointerdown; it becomes a drag after `DRAG_THRESHOLD`
 * pixels of travel. A press that never travels is still a click, which is how
 * the library cards keep their "click to add at the playhead" behaviour without
 * a separate hit region.
 */
import { createStore, useStore } from "@/store/createStore";
import { editor } from "@/store/editorStore";
import { mediaLayerDefaults } from "@/lib/project";
import { importStock, type StockItem } from "@/lib/stock";
import { snapToFrame } from "@/lib/time";
import { trackAtRow, trackRowIndex } from "@/lib/tracks";
import type { Asset, TrackId } from "@/types/editor";

/* ------------------------------------------------------------------ *
 * Payload
 * ------------------------------------------------------------------ */

/**
 * What is being carried. `media` is the asset kind rather than the stock kind
 * so one field covers both sources — the ghost tints off it and nothing else
 * needs to know where the payload came from.
 */
interface DragBase {
  label: string;
  thumb?: string;
  media: Asset["kind"];
  /** projected timeline length, for the drop preview only */
  duration: number;
}

export type DragPayload =
  | (DragBase & { type: "asset"; assetId: string })
  | (DragBase & { type: "stock"; item: StockItem });

export interface DragTarget {
  surface: "timeline" | "track" | "stage";
  /** timeline seconds, frame-snapped; the playhead for the stage and rail */
  time?: number;
  /** display row the pointer is over, top-first */
  row?: number;
  /** the track that row belongs to; absent when the row is off the end */
  trackId?: TrackId;
}

export interface DragState {
  payload: DragPayload;
  x: number;
  y: number;
  target: DragTarget | null;
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

/** Fallback row height; the timeline publishes its real one via `data-row-h`. */
const ROW_FALLBACK = 46;

const dragStore = createStore<{ drag: DragState | null }>(() => ({ drag: null }));

export function dragState(): DragState | null {
  return dragStore.getState().drag;
}

/**
 * Read a slice of the in-flight drag. Callers see the drag itself, not the
 * store's wrapper, so a surface only has to know what it cares about.
 */
export function useDrag<S>(
  selector: (state: DragState | null) => S,
  isEqual?: (a: S, b: S) => boolean,
): S {
  return useStore(dragStore, (state) => selector(state.drag), isEqual);
}

/* ------------------------------------------------------------------ *
 * Payloads
 * ------------------------------------------------------------------ */

/**
 * A library asset. The length comes from `mediaLayerDefaults` rather than being
 * guessed here, so the preview promises exactly what the drop will produce.
 */
export function assetPayload(asset: Asset): DragPayload {
  return {
    type: "asset",
    assetId: asset.id,
    label: asset.name,
    thumb: asset.thumbnail,
    media: asset.kind,
    duration: mediaLayerDefaults(asset, editor().project.settings, 0).duration,
  };
}

/**
 * A stock search result. Nothing has been downloaded yet, so the length is the
 * same rule applied to the item's own metadata — close enough for a preview,
 * and the real clip gets its true duration from the file once it lands.
 */
export function stockPayload(item: StockItem): DragPayload {
  return {
    type: "stock",
    item,
    label: item.title,
    thumb: item.thumbUrl,
    media: item.kind,
    duration: item.kind === "image" ? 5 : Math.min(item.duration ?? 5, 60),
  };
}

/* ------------------------------------------------------------------ *
 * Hit-testing
 * ------------------------------------------------------------------ */

function resolveTarget(x: number, y: number): DragTarget | null {
  const zone = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]");
  if (!zone) return null;

  const project = editor().project;

  if (zone.dataset.drop === "timeline") {
    const rect = zone.getBoundingClientRect();
    const pps = Number(zone.dataset.pps);
    const rowH = Number(zone.dataset.rowH) || ROW_FALLBACK;
    // No scale published yet: fall back to the playhead rather than dropping
    // the clip at an invented time.
    const raw = pps > 0 ? (x - rect.left + zone.scrollLeft) / pps : editor().currentTime;
    const time = snapToFrame(Math.max(0, raw), project.settings.fps || 30);
    const row = Math.max(0, Math.floor((y - rect.top + zone.scrollTop) / rowH));
    // A row past the last track leaves the choice to `placeLayer`.
    return { surface: "timeline", time, row, trackId: trackAtRow(project, row)?.id };
  }

  if (zone.dataset.drop === "track") {
    const trackId = zone.dataset.trackId;
    if (!trackId || !project.tracks[trackId]) return null;
    // A rail drop lands at the playhead, so the row is the row that was dropped
    // on rather than wherever the cursor is — the two are the same here.
    return { surface: "track", time: editor().currentTime, row: trackRowIndex(project, trackId), trackId };
  }

  if (zone.dataset.drop === "stage") return { surface: "stage", time: editor().currentTime };
  return null;
}

/* ------------------------------------------------------------------ *
 * Dropping
 * ------------------------------------------------------------------ */

function drop(payload: DragPayload, target: DragTarget): void {
  if (payload.type === "asset") {
    editor().addMediaLayer(payload.assetId, target.time, target.trackId);
    return;
  }
  // An explicit track is honoured exactly; without one the import places the
  // clip itself, which is what a drop onto the canvas or an appending row means.
  void importStock(payload.item, {
    addToTimeline: true,
    startTime: target.time,
    trackId: target.trackId,
    silent: false,
  });
}

/**
 * Eats the click the browser synthesises after a drag, so releasing over a clip
 * does not also select it. Capture phase, because the click has to be stopped
 * before anything underneath sees it.
 */
const CLICK_SWALLOW_MS = 400;

function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", swallow, true), CLICK_SWALLOW_MS);
}

/* ------------------------------------------------------------------ *
 * Starting a drag
 * ------------------------------------------------------------------ */

const DRAG_THRESHOLD = 5;

/**
 * Arms a drag from a pointerdown. Nothing is shown until the pointer has moved
 * far enough to mean it, so an ordinary click keeps its own meaning.
 */
export function startMediaDrag(payload: DragPayload, event: React.PointerEvent): void {
  if (event.button !== 0 || !event.isPrimary) return;

  const startX = event.clientX;
  const startY = event.clientY;
  let active = false;

  const onMove = (e: PointerEvent) => {
    if (!active) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD) return;
      active = true;
      document.body.style.cursor = "grabbing";
    }
    dragStore.setState({
      drag: { payload, x: e.clientX, y: e.clientY, target: resolveTarget(e.clientX, e.clientY) },
    });
  };

  const onUp = (e: PointerEvent) => {
    stop();
    if (!active) return;
    const target = resolveTarget(e.clientX, e.clientY);
    dragStore.setState({ drag: null });
    swallowNextClick();
    if (target) drop(payload, target);
  };

  const onCancel = () => {
    stop();
    if (!active) return;
    dragStore.setState({ drag: null });
    swallowNextClick();
  };

  function stop() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
    document.body.style.cursor = "";
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}

/* ------------------------------------------------------------------ *
 * Live preview
 * ------------------------------------------------------------------ */

/** The clip the timeline draws under the cursor while a drag is overhead. */
export interface DropPreview {
  time: number;
  trackId?: TrackId;
  row?: number;
  duration: number;
  media: Asset["kind"];
}

/**
 * Derived from the drag store as a compact object, read through `sameDropPreview`
 * so the timeline only re-renders when the ghost actually moves — a plain
 * `Object.is` selector would re-render every clip on each pointer event.
 */
export function dropPreview(): DropPreview | null {
  const drag = dragState();
  const target = drag?.target;
  if (!drag || !target || target.surface === "stage") return null;
  return {
    time: target.time ?? 0,
    trackId: target.trackId,
    row: target.row,
    duration: drag.payload.duration,
    media: drag.payload.media,
  };
}

export function sameDropPreview(a: DropPreview | null, b: DropPreview | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.time === b.time &&
    a.trackId === b.trackId &&
    a.row === b.row &&
    a.duration === b.duration &&
    a.media === b.media
  );
}
