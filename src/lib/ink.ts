/**
 * THE INK RENDERER.
 *
 * One function turns "a layer's content + the transition ink acting on it" into
 * pixels. Both the compositor (real layers) and the library thumbnails (proxy
 * scenes) call it, which is the only reason a transition preview can be trusted.
 *
 * Three execution tiers, cheapest first:
 *
 *   1. DIRECT  — no mask, no raster pass, no grade. Pure transform, so the
 *                content is drawn straight onto the target context.
 *   2. SCRATCH — the content is rendered into an offscreen surface sized to the
 *                layer's own box (+padding) so it can be feathered, sliced,
 *                channel-split, mosaiced and graded without touching the
 *                pixels of any other layer.
 *   3. SHADER  — the frame below the layer (A) and the frame including it (B)
 *                are uploaded as textures and one GLSL pass blends them.
 */
import { drawEffect } from "@/lib/effects";
import { runTransitionShader, type ShaderTransitionId } from "@/lib/gl";
import { rngFor } from "@/lib/random";
import type { RampFx } from "@/lib/transitions";
import type { LayerGrade } from "@/types/editor";

export type MaskFn = (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
export type OverlayFn = (ctx: CanvasRenderingContext2D, width: number, height: number) => void;

/** Anything the effects library can draw, plus its own placement. */
export interface OverlayDraw {
  style: Parameters<typeof drawEffect>[0]["style"];
  width: number;
  height: number;
  time: number;
  seedKey: string;
}

export interface InkArgs {
  ctx: CanvasRenderingContext2D;
  /** the frame size, in project pixels */
  view: { width: number; height: number };
  /** centre of the content, in project pixels */
  center: { x: number; y: number };
  /** the content's natural size */
  base: { width: number; height: number };
  /** evaluated scale (already includes keyframes) */
  scale: { x: number; y: number };
  rotation: number;
  alpha: number;
  /** canvas filter string for the content itself */
  filter: string;
  grade?: LayerGrade;
  fx: RampFx;
  mask?: MaskFn;
  /** multiplier on the user's softness for the feathered mask */
  feather: number;
  softness: number;
  /** transition overlays, drawn over the layer box in layer-local space */
  overlays: OverlayFn[];
  /** procedural effect draws (the Effects library) */
  effectDraws: OverlayDraw[];
  shader?: ShaderTransitionId;
  /** 0 → A, 1 → B, for the shader tier */
  shaderProgress: number;
  shaderColor: [number, number, number];
  seedKey: string;
  /** paints the layer's content, centred on the origin, at its natural size */
  paint: (target: CanvasRenderingContext2D) => void;
}

/* ------------------------------------------------------------------ *
 * Offscreen surfaces
 * ------------------------------------------------------------------ */

interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

const surfaces = new Map<string, Surface>();

function getSurface(name: string, width: number, height: number): Surface {
  const w = Math.max(2, Math.round(width));
  const h = Math.max(2, Math.round(height));
  let surface = surfaces.get(name);
  if (!surface) {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    surface = { canvas, ctx };
    surfaces.set(name, surface);
  }
  if (surface.canvas.width !== w || surface.canvas.height !== h) {
    surface.canvas.width = w;
    surface.canvas.height = h;
  }
  surface.ctx.setTransform(1, 0, 0, 1, 0, 0);
  surface.ctx.globalAlpha = 1;
  surface.ctx.globalCompositeOperation = "source-over";
  surface.ctx.filter = "none";
  return surface;
}

/** Copies whatever is currently painted on `ctx` into a named surface. */
function snapshot(ctx: CanvasRenderingContext2D, name: string, view: { width: number; height: number }): Surface {
  const surface = getSurface(name, view.width, view.height);
  surface.ctx.clearRect(0, 0, surface.canvas.width, surface.canvas.height);
  try {
    surface.ctx.drawImage(ctx.canvas, 0, 0, surface.canvas.width, surface.canvas.height);
  } catch {
    /* a tainted canvas cannot be sampled — the caller falls back */
  }
  return surface;
}

const isNeutral = (g: LayerGrade) =>
  g.temperature === 0 && g.tint === 0 && g.fade === 0 && g.vignette === 0 && g.grain === 0;

/* ------------------------------------------------------------------ *
 * Raster passes on a scratch surface
 * ------------------------------------------------------------------ */

/** Shears the surface in horizontal bands — the glitch/slice look. */
function applySlices(sctx: CanvasRenderingContext2D, w: number, h: number, fx: RampFx, rand: () => number) {
  const slices = fx.slices;
  if (!slices) return;
  const count = Math.max(2, Math.round(slices.count));
  const bandH = h / count;
  const source = getSurface("sliceSrc", w, h);
  source.ctx.clearRect(0, 0, w, h);
  source.ctx.drawImage(sctx.canvas, 0, 0, w, h);
  sctx.clearRect(0, 0, w, h);
  for (let i = 0; i < count; i++) {
    const y = i * bandH;
    const shift = (rand() * 2 - 1) * slices.spread;
    sctx.drawImage(source.canvas, 0, y, w, bandH, shift, y, w, bandH);
  }
}

/** Channel separation. Needs real pixel access, so it is done once on ImageData. */
function applyRgbSplit(sctx: CanvasRenderingContext2D, w: number, h: number, amount: number) {
  const offset = Math.round(Math.max(1, amount));
  let image: ImageData;
  try {
    image = sctx.getImageData(0, 0, w, h);
  } catch {
    return; // tainted — skip rather than break the frame
  }
  const src = new Uint8ClampedArray(image.data);
  const out = image.data;
  const stride = offset * 4;
  for (let i = 0; i < src.length; i++) {
    const r = src[i - stride] ?? src[i];
    const b = src[i + stride] ?? src[i];
    out[i] = r;
    out[i + 2] = b;
  }
  sctx.putImageData(image, 0, 0);
}

/** Mosaic: downscale then blow back up with smoothing off. */
function applyPixelate(sctx: CanvasRenderingContext2D, w: number, h: number, cell: number) {
  const small = getSurface("pixelSmall", Math.max(2, w / cell), Math.max(2, h / cell));
  small.ctx.imageSmoothingEnabled = true;
  small.ctx.clearRect(0, 0, small.canvas.width, small.canvas.height);
  small.ctx.drawImage(sctx.canvas, 0, 0, small.canvas.width, small.canvas.height);
  sctx.imageSmoothingEnabled = false;
  sctx.clearRect(0, 0, w, h);
  sctx.drawImage(small.canvas, 0, 0, w, h);
  sctx.imageSmoothingEnabled = true;
}

/* ------------------------------------------------------------------ *
 * Grade
 * ------------------------------------------------------------------ */

/** Applies the colour grade to a scratch surface, confined to existing pixels. */
function applyGrade(sctx: CanvasRenderingContext2D, grade: LayerGrade, boxW: number, boxH: number, seedKey: string) {
  if (isNeutral(grade)) return;
  const cx = sctx.canvas.width / 2;
  const cy = sctx.canvas.height / 2;

  sctx.save();
  // Everything here composites only where the layer already painted, so the
  // grade can never bleed onto other layers.
  sctx.globalCompositeOperation = "source-atop";
  sctx.translate(cx, cy);

  if (grade.temperature !== 0) {
    const a = Math.min(0.55, Math.abs(grade.temperature) * 0.4);
    sctx.fillStyle = grade.temperature > 0 ? `rgba(255,158,64,${a})` : `rgba(64,144,255,${a})`;
    sctx.fillRect(-boxW / 2, -boxH / 2, boxW, boxH);
  }

  if (grade.tint !== 0) {
    const a = Math.min(0.45, Math.abs(grade.tint) * 0.32);
    sctx.fillStyle = grade.tint > 0 ? `rgba(255,64,196,${a})` : `rgba(64,220,120,${a})`;
    sctx.fillRect(-boxW / 2, -boxH / 2, boxW, boxH);
  }

  if (grade.fade > 0) {
    sctx.fillStyle = `rgba(255,255,255,${Math.min(0.3, grade.fade * 0.26)})`;
    sctx.fillRect(-boxW / 2, -boxH / 2, boxW, boxH);
  }

  if (grade.grain > 0) {
    const rand = rngFor(Math.max(1, seedKey.length * 2654435761 + Math.round(grade.grain * 1000)));
    const count = Math.round(grade.grain * 1400);
    const size = Math.max(1, Math.max(boxW, boxH) * 0.0022);
    for (let i = 0; i < count; i++) {
      const v = rand();
      sctx.fillStyle = v > 0.5 ? `rgba(255,255,255,${0.05 + v * 0.14})` : "rgba(0,0,0,0.14)";
      sctx.fillRect((rand() - 0.5) * boxW, (rand() - 0.5) * boxH, size, size);
    }
  }

  if (grade.vignette > 0) {
    const r = Math.hypot(boxW, boxH) * 0.5;
    const grad = sctx.createRadialGradient(0, 0, r * 0.32, 0, 0, r * 1.02);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(0.7, `rgba(0,0,0,${grade.vignette * 0.28})`);
    grad.addColorStop(1, `rgba(0,0,0,${Math.min(0.95, grade.vignette * 1.05)})`);
    sctx.fillStyle = grad;
    sctx.fillRect(-boxW / 2, -boxH / 2, boxW, boxH);
  }

  sctx.restore();
}

/* ------------------------------------------------------------------ *
 * Mask
 * ------------------------------------------------------------------ */

/**
 * Clips the scratch surface to a transition mask.
 * Hard masks clip the path directly; soft ones blur the mask first, which is
 * what gives a feathered wipe its gradient edge.
 */
function applyMask(
  sctx: CanvasRenderingContext2D,
  mask: MaskFn,
  center: { x: number; y: number },
  rotation: number,
  scale: { x: number; y: number },
  base: { width: number; height: number },
  featherPx: number,
) {
  const w = sctx.canvas.width;
  const h = sctx.canvas.height;

  if (featherPx <= 0.75) {
    sctx.save();
    sctx.translate(center.x, center.y);
    sctx.rotate(rotation);
    sctx.scale(scale.x, scale.y);
    mask(sctx, base.width, base.height);
    sctx.restore();
    sctx.globalCompositeOperation = "destination-in";
    sctx.fillStyle = "#ffffff";
    sctx.fill();
    sctx.globalCompositeOperation = "source-over";
    return;
  }

  const maskSurface = getSurface("mask", w, h);
  maskSurface.ctx.clearRect(0, 0, w, h);
  maskSurface.ctx.save();
  maskSurface.ctx.translate(center.x, center.y);
  maskSurface.ctx.rotate(rotation);
  maskSurface.ctx.scale(scale.x, scale.y);
  mask(maskSurface.ctx, base.width, base.height);
  maskSurface.ctx.restore();
  maskSurface.ctx.fillStyle = "#ffffff";
  maskSurface.ctx.fill();

  const blurSurface = getSurface("maskBlur", w, h);
  blurSurface.ctx.clearRect(0, 0, w, h);
  blurSurface.ctx.filter = `blur(${Math.min(120, featherPx)}px)`;
  blurSurface.ctx.drawImage(maskSurface.canvas, 0, 0);
  blurSurface.ctx.filter = "none";

  sctx.globalCompositeOperation = "destination-in";
  sctx.drawImage(blurSurface.canvas, 0, 0);
  sctx.globalCompositeOperation = "source-over";
}

/* ------------------------------------------------------------------ *
 * Renderer
 * ------------------------------------------------------------------ */

/** Largest offset a raster pass can push pixels, used to pad the scratch box. */
function rasterSpread(fx: RampFx): number {
  let spread = Math.abs(fx.rgbSplit ?? 0) * 2;
  if (fx.slices) spread = Math.max(spread, Math.abs(fx.slices.spread) * 2);
  if (fx.pixelate) spread = Math.max(spread, fx.pixelate * 2);
  return spread;
}

export function renderInk(args: InkArgs): void {
  const { ctx, view, center, base, alpha, fx } = args;
  if (alpha <= 0.002) return;

  const nativeFilter = args.filter && args.filter !== "none" ? args.filter : "";
  const blurPx = fx.blur > 0 ? (fx.blur * view.height) / 1080 : 0;
  const filter = [nativeFilter, blurPx > 0.1 ? `blur(${blurPx.toFixed(2)}px)` : ""].filter(Boolean).join(" ");

  const scale = {
    x: args.scale.x * fx.scaleMul * fx.scaleXMul,
    y: args.scale.y * fx.scaleMul * fx.scaleYMul,
  };
  const rotation = (args.rotation * Math.PI) / 180;
  const offset = { x: fx.dx * base.width * args.scale.x, y: fx.dy * base.height * args.scale.y };
  const content = { x: center.x + offset.x, y: center.y + offset.y };

  /** Lays the layer's own coordinate system into a target context. */
  const place = (target: CanvasRenderingContext2D, ox: number, oy: number) => {
    target.translate(ox, oy);
    target.rotate(rotation);
    target.scale(scale.x, scale.y);
  };

  /**
   * Paints the content, then the procedural effects, then the transition
   * overlays. `ox/oy` is where the layer's centre has to land in the target,
   * which lets the direct, scratch and shader tiers share one painter.
   */
  const paintAll = (target: CanvasRenderingContext2D, ox: number, oy: number, withOverlays = true) => {
    target.save();
    place(target, ox, oy);
    if (filter) target.filter = filter;
    args.paint(target);
    for (const draw of args.effectDraws) {
      target.save();
      target.globalCompositeOperation = draw.style.blend;
      drawEffect({
        ctx: target,
        style: draw.style,
        width: draw.width,
        height: draw.height,
        time: draw.time,
        seedKey: draw.seedKey,
      });
      target.restore();
    }
    target.filter = "none";
    // Overlays are deliberately NOT filtered or masked — a flash should flash
    // the whole clip, not a feathered sliver of it.
    if (withOverlays) for (const overlay of args.overlays) overlay(target, base.width, base.height);
    target.restore();
  };

  /* ---------------- tier 3: GLSL ---------------- */
  if (args.shader) {
    const from = snapshot(ctx, "shaderFrom", view);
    const to = snapshot(ctx, "shaderTo", view);
    to.ctx.save();
    to.ctx.globalAlpha = Math.min(1, alpha);
    paintAll(to.ctx, content.x, content.y);
    to.ctx.restore();

    const result = runTransitionShader(
      args.shader,
      {
        from: from.canvas,
        to: to.canvas,
        progress: args.shaderProgress,
        softness: args.softness,
        color: args.shaderColor,
      },
      view.width,
      view.height,
    );
    if (result) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(result, 0, 0, view.width, view.height);
      ctx.restore();
      return;
    }
    // No shader available — fall through to the Canvas-2D tiers and cross-fade.
    const fadeAlpha = Math.min(1, alpha) * args.shaderProgress;
    if (fadeAlpha <= 0.002) return;
    ctx.save();
    ctx.globalAlpha = fadeAlpha;
    paintAll(ctx, content.x, content.y);
    ctx.restore();
    return;
  }

  const graded = args.grade && !isNeutral(args.grade);
  const needsScratch =
    !!args.mask ||
    !!fx.slices ||
    fx.rgbSplit !== undefined ||
    fx.pixelate !== undefined ||
    !!graded;

  /* ---------------- tier 1: direct ---------------- */
  if (!needsScratch) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, ctx.globalAlpha * alpha);
    paintAll(ctx, content.x, content.y);
    ctx.restore();
    return;
  }

  /* ---------------- tier 2: scratch ---------------- */
  const dispW = Math.abs(base.width * scale.x);
  const dispH = Math.abs(base.height * scale.y);
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  const pad = blurPx * 3 + rasterSpread(fx) + 16;
  const boxW = Math.ceil(dispW * cos + dispH * sin + pad * 2);
  const boxH = Math.ceil(dispW * sin + dispH * cos + pad * 2);

  const scratch = getSurface("ink", boxW, boxH);
  const sctx = scratch.ctx;
  sctx.clearRect(0, 0, boxW, boxH);

  const localCenter = { x: boxW / 2, y: boxH / 2 };
  paintAll(sctx, localCenter.x, localCenter.y, false);

  const rand = rngFor(Math.max(1, args.seedKey.length * 7919 + Math.round((fx.slices?.spread ?? 0) * 13)));
  if (fx.slices) applySlices(sctx, boxW, boxH, fx, rand);
  if (fx.rgbSplit !== undefined && fx.rgbSplit > 0.4) applyRgbSplit(sctx, boxW, boxH, fx.rgbSplit);
  if (fx.pixelate !== undefined && fx.pixelate > 1.02) applyPixelate(sctx, boxW, boxH, fx.pixelate);
  if (args.grade) applyGrade(sctx, args.grade, dispW, dispH, args.seedKey);
  if (args.mask) {
    const softness = args.feather === 0 ? 0 : args.softness * args.feather * view.height * 0.045;
    applyMask(sctx, args.mask, localCenter, rotation, scale, base, softness);
  }

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(scratch.canvas, content.x - boxW / 2, content.y - boxH / 2);
  ctx.restore();

  // Overlays sit outside the mask, so they go straight onto the target.
  if (args.overlays.length) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, ctx.globalAlpha * alpha);
    place(ctx, content.x, content.y);
    for (const overlay of args.overlays) overlay(ctx, base.width, base.height);
    ctx.restore();
  }
}

/** Frees cached surfaces — only useful when the view size changes drastically. */
export function resetInkSurfaces() {
  surfaces.clear();
}
