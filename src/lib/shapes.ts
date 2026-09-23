/**
 * Vector shape paths.
 *
 * One `shapePath` entry point serves three callers: the sticker/shape library
 * (drawn into the layer box), the shape-mask transitions (star/heart/hexagon
 * reveals) and the transition thumbnail previews. All of them describe the
 * shape centred on (cx, cy) with a radius-like `r`, and none of them touch the
 * canvas state beyond `beginPath()`.
 */
import type { ShapeId } from "@/types/editor";

type Ctx = CanvasRenderingContext2D;

export const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

export function roundRectPath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

export function ellipsePath(ctx: Ctx, cx: number, cy: number, rx: number, ry: number) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(0.01, rx), Math.max(0.01, ry), 0, 0, TAU);
  ctx.closePath();
}

export function polygonPath(ctx: Ctx, cx: number, cy: number, r: number, sides: number, rotation = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i * TAU) / sides;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export function starPath(ctx: Ctx, cx: number, cy: number, outer: number, points = 5, innerRatio = 0.45, rotation = -Math.PI / 2) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : outer * innerRatio;
    const a = rotation + (i * Math.PI) / points;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Pointy "starburst" used by the burst sticker and the burst reveal. */
export function burstPath(ctx: Ctx, cx: number, cy: number, r: number, spikes = 16) {
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / spikes;
    const rad = i % 2 === 0 ? r : r * 0.78;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export function heartPath(ctx: Ctx, cx: number, cy: number, r: number) {
  const s = r / 1.08;
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.82);
  ctx.bezierCurveTo(cx - s * 1.5, cy - s * 0.18, cx - s * 0.62, cy - s * 1.12, cx, cy - s * 0.36);
  ctx.bezierCurveTo(cx + s * 0.62, cy - s * 1.12, cx + s * 1.5, cy - s * 0.18, cx, cy + s * 0.82);
  ctx.closePath();
}

export function arrowPath(ctx: Ctx, cx: number, cy: number, r: number) {
  const s = r;
  ctx.beginPath();
  ctx.moveTo(cx - s, cy - s * 0.34);
  ctx.lineTo(cx + s * 0.15, cy - s * 0.34);
  ctx.lineTo(cx + s * 0.15, cy - s * 0.72);
  ctx.lineTo(cx + s, cy);
  ctx.lineTo(cx + s * 0.15, cy + s * 0.72);
  ctx.lineTo(cx + s * 0.15, cy + s * 0.34);
  ctx.lineTo(cx - s, cy + s * 0.34);
  ctx.closePath();
}

export function chevronPath(ctx: Ctx, cx: number, cy: number, r: number, thickness = 0.42) {
  const s = r;
  ctx.beginPath();
  ctx.moveTo(cx - s, cy - s);
  ctx.lineTo(cx, cy);
  ctx.lineTo(cx - s, cy + s);
  ctx.lineTo(cx - s + s * thickness * 1.6, cy + s);
  ctx.lineTo(cx + s * thickness * 1.6, cy);
  ctx.lineTo(cx - s + s * thickness * 1.6, cy - s);
  ctx.closePath();
}

export function diamondPath(ctx: Ctx, cx: number, cy: number, r: number) {
  polygonPath(ctx, cx, cy, r, 4, -Math.PI / 2);
}

export function ringPath(ctx: Ctx, cx: number, cy: number, r: number, thickness = 0.34) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.arc(cx, cy, Math.max(0.01, r * (1 - thickness)), 0, TAU, true);
  ctx.closePath();
}

export function shieldPath(ctx: Ctx, cx: number, cy: number, r: number) {
  const s = r;
  ctx.beginPath();
  ctx.moveTo(cx, cy - s);
  ctx.lineTo(cx + s * 0.86, cy - s * 0.62);
  ctx.lineTo(cx + s * 0.72, cy + s * 0.24);
  ctx.quadraticCurveTo(cx, cy + s * 1.12, cx - s * 0.72, cy + s * 0.24);
  ctx.lineTo(cx - s * 0.86, cy - s * 0.62);
  ctx.closePath();
}

export function bubblePath(ctx: Ctx, cx: number, cy: number, r: number) {
  const s = r;
  roundRectPath(ctx, cx - s, cy - s * 0.86, s * 2, s * 1.42, s * 0.42);
  ctx.moveTo(cx - s * 0.3, cy + s * 0.56);
  ctx.lineTo(cx - s * 0.12, cy + s * 1.04);
  ctx.lineTo(cx + s * 0.2, cy + s * 0.56);
  ctx.closePath();
}

export function cloudPath(ctx: Ctx, cx: number, cy: number, r: number) {
  const s = r;
  ctx.beginPath();
  ctx.arc(cx - s * 0.5, cy + s * 0.16, s * 0.46, Math.PI * 0.75, Math.PI * 1.75);
  ctx.arc(cx - s * 0.05, cy - s * 0.28, s * 0.56, Math.PI * 0.95, Math.PI * 2.05);
  ctx.arc(cx + s * 0.52, cy + s * 0.1, s * 0.44, Math.PI * 1.3, Math.PI * 0.4);
  ctx.closePath();
}

/** Organic blob — a closed cubic loop with deterministic radii. */
export function blobPath(ctx: Ctx, cx: number, cy: number, r: number, wobble = 0.22, lobes = 6) {
  const points: [number, number][] = [];
  for (let i = 0; i < lobes; i++) {
    const a = (i / lobes) * TAU;
    const rad = r * (1 - wobble + ((i * 37) % 11) / 11 * wobble * 2);
    points.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
  }
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    if (i === 0) ctx.moveTo(mx, my);
    ctx.quadraticCurveTo(x0, y0, mx, my);
  }
  ctx.closePath();
}

export function checkPath(ctx: Ctx, cx: number, cy: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.72, cy + r * 0.04);
  ctx.lineTo(cx - r * 0.2, cy + r * 0.56);
  ctx.lineTo(cx + r * 0.76, cy - r * 0.56);
  ctx.lineTo(cx + r * 0.44, cy - r * 0.84);
  ctx.lineTo(cx - r * 0.2, cy + r * 0.06);
  ctx.lineTo(cx - r * 0.48, cy - r * 0.22);
  ctx.closePath();
}

export function crossPath(ctx: Ctx, cx: number, cy: number, r: number, thickness = 0.36) {
  const t = r * thickness;
  ctx.beginPath();
  ctx.rect(cx - t, cy - r, t * 2, r * 2);
  ctx.rect(cx - r, cy - t, r * 2, t * 2);
  ctx.closePath();
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/** Builds the path for a shape id. Does not fill or stroke. */
export function shapePath(ctx: Ctx, id: ShapeId, cx: number, cy: number, r: number) {
  switch (id) {
    case "roundRect":
      roundRectPath(ctx, cx - r, cy - r * 0.72, r * 2, r * 1.44, r * 0.32);
      break;
    case "ellipse":
      ellipsePath(ctx, cx, cy, r, r * 0.78);
      break;
    case "triangle":
      polygonPath(ctx, cx, cy, r, 3);
      break;
    case "star":
      starPath(ctx, cx, cy, r);
      break;
    case "heart":
      heartPath(ctx, cx, cy, r);
      break;
    case "arrow":
      arrowPath(ctx, cx, cy, r);
      break;
    case "bubble":
      bubblePath(ctx, cx, cy, r);
      break;
    case "badge":
      burstPath(ctx, cx, cy, r, 24);
      break;
    case "ring":
      ringPath(ctx, cx, cy, r);
      break;
    case "diamond":
      diamondPath(ctx, cx, cy, r);
      break;
    case "hexagon":
      polygonPath(ctx, cx, cy, r, 6);
      break;
    case "burst":
      burstPath(ctx, cx, cy, r);
      break;
    case "cloud":
      cloudPath(ctx, cx, cy, r);
      break;
    case "check":
      checkPath(ctx, cx, cy, r);
      break;
    case "cross":
      crossPath(ctx, cx, cy, r);
      break;
    case "chevron":
      chevronPath(ctx, cx, cy, r);
      break;
    case "shield":
      shieldPath(ctx, cx, cy, r);
      break;
    case "blob":
      blobPath(ctx, cx, cy, r);
      break;
    default:
      roundRectPath(ctx, cx - r, cy - r * 0.72, r * 2, r * 1.44, r * 0.32);
  }
}

/** Fills and strokes a shape in one call — used by the sticker renderer. */
export function paintShape(
  ctx: Ctx,
  id: ShapeId,
  cx: number,
  cy: number,
  r: number,
  fill: string,
  stroke: string,
  strokeWidth: number,
) {
  shapePath(ctx, id, cx, cy, r);
  if (fill && fill !== "transparent") {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (strokeWidth > 0 && stroke && stroke !== "transparent") {
    ctx.lineJoin = "round";
    ctx.lineWidth = strokeWidth;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}
