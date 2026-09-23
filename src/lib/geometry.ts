/**
 * Geometry helpers for on-canvas direct manipulation.
 *
 * Everything here works in PROJECT pixels (the coordinate space of the
 * composition, e.g. 1920x1080). The stage converts pointer positions into that
 * space with a single view scale, so the math never has to care about zoom.
 */
import { evaluateLayer } from "@/lib/anim";
import { getBaseSize } from "@/lib/compositor";
import { clamp } from "@/lib/time";
import type { Asset, Layer, ProjectSettings } from "@/types/editor";

export interface Box {
  /** centre in project pixels */
  cx: number;
  cy: number;
  /** width/height AFTER scale has been applied */
  w: number;
  h: number;
  rotation: number;
  /** scale that produced the size, used by the resize interaction */
  scale: number;
}

export interface Point {
  x: number;
  y: number;
}

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rotate";

/** The box a layer occupies at `time`, in project pixels. `null` for audio layers. */
export function evaluatedBox(
  layer: Layer,
  assets: Record<string, Asset>,
  settings: ProjectSettings,
  time: number,
): Box | null {
  if (layer.type === "audio") return null;
  const end = layer.startTime + Math.max(0.0001, layer.duration);
  const t = clamp(time, layer.startTime, end);
  const v = evaluateLayer(layer, t);
  const base = getBaseSize(layer, settings, assets);
  const scale = v.scale || 0.0001;
  return { cx: v.x, cy: v.y, w: base.width * scale, h: base.height * scale, rotation: v.rotation, scale };
}

export function rotatePoint(p: Point, origin: Point, deg: number): Point {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  return { x: origin.x + dx * cos - dy * sin, y: origin.y + dx * sin + dy * cos };
}

/** Corners in order: nw, ne, se, sw. */
export function corners(box: Box): Point[] {
  const hw = box.w / 2;
  const hh = box.h / 2;
  const origin = { x: box.cx, y: box.cy };
  return [
    { x: box.cx - hw, y: box.cy - hh },
    { x: box.cx + hw, y: box.cy - hh },
    { x: box.cx + hw, y: box.cy + hh },
    { x: box.cx - hw, y: box.cy + hh },
  ].map((p) => rotatePoint(p, origin, box.rotation));
}

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function boundsOf(points: Point[]): Bounds {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

export function boxBounds(box: Box): Bounds {
  return boundsOf(corners(box));
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

export function pointInBounds(p: Point, b: Bounds): boolean {
  return p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;
}

/** Precise hit test against the rotated rectangle. */
export function pointInBox(p: Point, box: Box): boolean {
  const local = rotatePoint(p, { x: box.cx, y: box.cy }, -box.rotation);
  return Math.abs(local.x - box.cx) <= box.w / 2 && Math.abs(local.y - box.cy) <= box.h / 2;
}

/** Handle anchor points in project coordinates. */
export function handlesOf(box: Box): { id: HandleId; point: Point }[] {
  const hw = box.w / 2;
  const hh = box.h / 2;
  const offsets: { id: HandleId; dx: number; dy: number }[] = [
    { id: "nw", dx: -hw, dy: -hh },
    { id: "n", dx: 0, dy: -hh },
    { id: "ne", dx: hw, dy: -hh },
    { id: "e", dx: hw, dy: 0 },
    { id: "se", dx: hw, dy: hh },
    { id: "s", dx: 0, dy: hh },
    { id: "sw", dx: -hw, dy: hh },
    { id: "w", dx: -hw, dy: 0 },
    { id: "rotate", dx: 0, dy: -hh - 46 },
  ];
  const origin = { x: box.cx, y: box.cy };
  return offsets.map((o) => ({
    id: o.id,
    point: rotatePoint({ x: box.cx + o.dx, y: box.cy + o.dy }, origin, box.rotation),
  }));
}

/** The handle diagonally opposite `id` — the pivot of a resize. */
export function pivotFor(box: Box, id: HandleId): Point {
  const hw = box.w / 2;
  const hh = box.h / 2;
  const map: Record<HandleId, Point> = {
    nw: { x: -hw, y: -hh },
    n: { x: 0, y: hh },
    ne: { x: -hw, y: hh },
    e: { x: -hw, y: 0 },
    se: { x: -hw, y: -hh },
    s: { x: 0, y: -hh },
    sw: { x: hw, y: -hh },
    w: { x: hw, y: 0 },
    rotate: { x: 0, y: 0 },
  };
  const o = map[id];
  const origin = { x: box.cx, y: box.cy };
  return rotatePoint({ x: box.cx - o.x, y: box.cy - o.y }, origin, box.rotation);
}

/* ------------------------------------------------------------------ *
 * Snapping guides
 * ------------------------------------------------------------------ */

export interface Guide {
  axis: "x" | "y";
  position: number;
}

export interface SnapResult {
  x: number;
  y: number;
  guides: Guide[];
}

interface Target {
  x: number[];
  y: number[];
}

/** Candidate alignment lines: frame edges/centre plus every other layer's box. */
export function snapTargets(
  boxes: { box: Box; id: string }[],
  settings: ProjectSettings,
): Target {
  const x = [0, settings.width / 2, settings.width];
  const y = [0, settings.height / 2, settings.height];
  for (const { box } of boxes) {
    x.push(box.cx);
    y.push(box.cy);
    const b = boxBounds(box);
    x.push(b.left, b.right);
    y.push(b.top, b.bottom);
  }
  return { x, y };
}

function nearest(candidates: number[], values: number[], tolerance: number): { delta: number; line: number } | null {
  let best: { delta: number; line: number } | null = null;
  let bestDist = tolerance;
  for (const target of candidates) {
    for (const value of values) {
      const dist = Math.abs(target - value);
      if (dist <= bestDist) {
        bestDist = dist;
        best = { delta: target - value, line: target };
      }
    }
  }
  return best;
}

/**
 * Snaps a moving box (centre + edges) to the nearest alignment lines.
 * Returns the corrected centre and the guide lines to draw.
 */
export function snapBox(box: Box, dx: number, dy: number, targets: Target, tolerance: number): SnapResult {
  const moved: Box = { ...box, cx: box.cx + dx, cy: box.cy + dy };
  const c = corners(moved);
  const b = boundsOf(c);

  const xSnap = nearest(targets.x, [b.left, moved.cx, b.right], tolerance);
  const ySnap = nearest(targets.y, [b.top, moved.cy, b.bottom], tolerance);

  const guides: Guide[] = [];
  let cx = moved.cx;
  let cy = moved.cy;
  if (xSnap) {
    cx += xSnap.delta;
    guides.push({ axis: "x", position: xSnap.line });
  }
  if (ySnap) {
    cy += ySnap.delta;
    guides.push({ axis: "y", position: ySnap.line });
  }
  return { x: cx, y: cy, guides };
}
