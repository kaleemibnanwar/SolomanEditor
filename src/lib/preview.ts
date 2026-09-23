/**
 * LIBRARY PREVIEWS.
 *
 * Every card in the asset library shows a real render, never a stock picture:
 * the transition cards run `makeRamp` → `renderInk` (the compositor's own ink
 * path), the effect cards run the same `drawEffect` the compositor does, and the
 * shape / text / background cards build a throwaway layer and hand it to
 * `drawFrame`. That is the whole point — a card cannot promise something the
 * timeline will not deliver.
 *
 * The library has to work with no network and no bundled imagery, so the
 * backdrop is a landscape synthesised from code, drawn deterministically.
 *
 * Previews are 1/6-scale proxies of a 1920×1080 frame, and every value that is
 * measured in *project pixels* (filter blur, transition blur, mask feather) is
 * brought down by the same ratio, so a card shows what a real project shows.
 */
import { NEUTRAL_FILTERS, filterString } from "@/lib/anim";
import { DEFAULT_WRAP_RATIO, drawFrame, measureText } from "@/lib/compositor";
import { renderInk } from "@/lib/ink";
import { lookValues, type BackgroundPreset, type EffectPreset, type FilterLook, type TextPreset } from "@/lib/library";
import { createBackgroundLayer, createLayer, createShapeLayer, createTextLayer } from "@/lib/project";
import { hashSeed, rngFrom } from "@/lib/random";
import { clamp } from "@/lib/time";
import { NEUTRAL_FX, isNoopTransition, makeRamp, resolveTransition, transitionRgb } from "@/lib/transitions";
import type {
  Layer,
  LayerFilters,
  ProjectSettings,
  ShapeId,
  TransitionDirection,
  TransitionType,
} from "@/types/editor";

const TAU = Math.PI * 2;

/** The frame size preview px-values are authored against. */
const REFERENCE = { width: 1920, height: 1080 };

export interface PreviewView {
  width: number;
  height: number;
}

/** 16:9 card — transitions, filters, effects, backgrounds. */
export const THUMB_VIEW: PreviewView = { width: 320, height: 180 };
/** Square card — shapes. */
export const SHAPE_VIEW: PreviewView = { width: 220, height: 220 };
/** Letterbox card — text styles, so a sample line fits. */
export const TEXT_VIEW: PreviewView = { width: 320, height: 144 };

/* ------------------------------------------------------------------ *
 * The synthesised still
 * ------------------------------------------------------------------ */

interface Palette {
  sky: [string, string, string];
  far: string;
  near: string;
  ground: string;
  orb: string;
  glow: [string, string];
  foliage: [string, string];
  skin: string;
  cloth: string;
  hair: string;
}

/** Two shots, warm and cool, so a transition reads as A → B at a glance. */
const PALETTES: [Palette, Palette] = [
  {
    sky: ["#ffe0b0", "#ff9f6a", "#8b3f6d"],
    far: "#5d2c55",
    near: "#3c1c3c",
    ground: "#2a1330",
    orb: "#fff7d8",
    glow: ["rgba(255,226,160,0.55)", "rgba(255,178,118,0.2)"],
    foliage: ["#c07c3a", "#7b4a24"],
    skin: "#e6ac86",
    cloth: "#402033",
    hair: "#37201a",
  },
  {
    sky: ["#0d2b48", "#17556a", "#06121f"],
    far: "#0e2d40",
    near: "#081c2a",
    ground: "#05121c",
    orb: "#e9f7ff",
    glow: ["rgba(150,210,255,0.5)", "rgba(120,180,255,0.18)"],
    foliage: ["#1d7068", "#0f3d3c"],
    skin: "#cf9070",
    cloth: "#101f2b",
    hair: "#0d1a24",
  },
];

/**
 * Paints the stand-in "photo": a landscape with a subject, so highlights,
 * shadows and a skin tone are all present for a filter or grade to act on.
 */
function paintScene(ctx: CanvasRenderingContext2D, w: number, h: number, variant: number) {
  const p = PALETTES[variant === 1 ? 1 : 0];
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";

  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, p.sky[0]);
  sky.addColorStop(0.58, p.sky[1]);
  sky.addColorStop(1, p.sky[2]);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  const ox = w * (variant === 1 ? 0.26 : 0.74);
  const oy = h * 0.28;
  const orbR = h * 0.115;
  const glow = ctx.createRadialGradient(ox, oy, 0, ox, oy, orbR * 4);
  glow.addColorStop(0, p.glow[0]);
  glow.addColorStop(0.45, p.glow[1]);
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = p.orb;
  ctx.beginPath();
  ctx.arc(ox, oy, orbR, 0, TAU);
  ctx.fill();

  ctx.fillStyle = p.far;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.66);
  ctx.lineTo(w * 0.14, h * 0.42);
  ctx.lineTo(w * 0.3, h * 0.6);
  ctx.lineTo(w * 0.45, h * 0.34);
  ctx.lineTo(w * 0.62, h * 0.58);
  ctx.lineTo(w * 0.78, h * 0.44);
  ctx.lineTo(w, h * 0.62);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = p.near;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.8);
  ctx.bezierCurveTo(w * 0.24, h * 0.66, w * 0.42, h * 0.88, w * 0.64, h * 0.74);
  ctx.bezierCurveTo(w * 0.82, h * 0.62, w * 0.93, h * 0.78, w, h * 0.72);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();

  const rand = rngFrom(`preview-scene:${variant}`);
  ctx.globalAlpha = 0.85;
  for (let i = 0; i < 6; i++) {
    const bx = w * (0.06 + rand() * 0.88);
    const by = h * (0.72 + rand() * 0.2);
    const br = h * (0.06 + rand() * 0.07);
    ctx.fillStyle = i % 2 ? p.foliage[0] : p.foliage[1];
    ctx.beginPath();
    ctx.ellipse(bx, by, br, br * 0.82, 0, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.fillStyle = p.ground;
  ctx.beginPath();
  ctx.moveTo(0, h * 0.93);
  ctx.bezierCurveTo(w * 0.3, h * 0.88, w * 0.68, h * 0.98, w, h * 0.9);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();

  // The subject: skin tone against the sky, which is what a grade is judged on.
  const sx = w * (variant === 1 ? 0.68 : 0.3);
  const headY = h * 0.76;
  const headR = h * 0.1;
  ctx.fillStyle = p.cloth;
  ctx.beginPath();
  ctx.ellipse(sx, h * 1.06, headR * 2.3, headR * 1.9, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = p.skin;
  ctx.beginPath();
  ctx.ellipse(sx, headY, headR * 0.8, headR, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = p.hair;
  ctx.beginPath();
  ctx.ellipse(sx, headY - headR * 0.16, headR * 0.86, headR * 0.78, 0, Math.PI, TAU);
  ctx.fill();

  ctx.restore();
}

const sceneCache = new Map<string, HTMLCanvasElement>();

function sceneCanvas(view: PreviewView, variant: number): HTMLCanvasElement {
  const key = `${variant}:${view.width}x${view.height}`;
  let canvas = sceneCache.get(key);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.width = view.width;
    canvas.height = view.height;
    const ctx = canvas.getContext("2d");
    if (ctx) paintScene(ctx, canvas.width, canvas.height, variant);
    sceneCache.set(key, canvas);
  }
  return canvas;
}

/* ------------------------------------------------------------------ *
 * The renderer entry point
 * ------------------------------------------------------------------ */

export type PreviewRenderer = (ctx: CanvasRenderingContext2D, view: PreviewView) => void;

const cache = new Map<string, string>();
const CACHE_LIMIT = 600;

/**
 * Renders a preview to a data URL, memoised by key. A failing preview returns
 * "" rather than throwing — a decoration must never break a panel.
 */
export function previewDataUrl(
  key: string,
  view: PreviewView,
  render: PreviewRenderer,
  format: "png" | "jpeg" = "png",
): string {
  const cacheKey = `${format}:${key}:${view.width}x${view.height}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;
  if (typeof document === "undefined") return "";

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.round(view.width));
  canvas.height = Math.max(2, Math.round(view.height));
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  try {
    render(ctx, { width: canvas.width, height: canvas.height });
  } catch {
    return "";
  }

  // JPEG halves the memory of the photo-based cards; alpha cards stay PNG.
  const url = format === "jpeg" ? canvas.toDataURL("image/jpeg", 0.86) : canvas.toDataURL("image/png");
  if (cache.size > CACHE_LIMIT) cache.clear();
  cache.set(cacheKey, url);
  return url;
}

/** A throwaway project description sized to the card. */
const settingsFor = (view: PreviewView): ProjectSettings => ({
  name: "Preview",
  width: view.width,
  height: view.height,
  fps: 30,
  backgroundColor: "#000000",
  backgroundKind: "color",
  backgroundGradient: "",
  backgroundAngle: 0,
});

const filterStringOf = (filters: LayerFilters) =>
  filterString(createLayer({ type: "image", filters: { ...NEUTRAL_FILTERS, ...filters } }));

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

export interface TransitionPreviewOptions {
  /** Where in the transition to sample: 0 = the "from" side, 1 = settled. */
  at?: number;
  direction?: TransitionDirection;
  softness?: number;
  color?: string;
  intensity?: number;
  view?: PreviewView;
}

export function transitionPreviewDataUrl(
  type: TransitionType,
  options: TransitionPreviewOptions = {},
): string {
  const view = options.view ?? THUMB_VIEW;
  const at = clamp(options.at ?? 0.5, 0, 1);
  const opts = resolveTransition({
    type,
    duration: 0.5,
    direction: options.direction ?? "left",
    softness: options.softness ?? 0.35,
    color: options.color ?? "#ffffff",
    intensity: options.intensity ?? 1,
  });
  const key = `tx:${type}:${at}:${opts.direction}:${opts.softness}:${opts.color}:${opts.intensity}`;

  // A cut has nothing to sample mid-way, so its card is the two shots side by
  // side — which is exactly what a cut looks like.
  if (isNoopTransition({ type, duration: 1, direction: "left" })) {
    return previewDataUrl(
      `tx:cut:${type}`,
      view,
      (ctx, v) => {
        ctx.drawImage(sceneCanvas(v, 0), 0, 0, v.width, v.height);
        const half = Math.round(v.width / 2);
        const rest = v.width - half;
        ctx.drawImage(sceneCanvas(v, 1), half, 0, rest, v.height, half, 0, rest, v.height);
      },
      "jpeg",
    );
  }

  return previewDataUrl(
    key,
    view,
    (ctx, v) => {
      ctx.drawImage(sceneCanvas(v, 0), 0, 0, v.width, v.height);
      const ramp = makeRamp(type, at, opts, hashSeed(key));
      renderInk({
        ctx,
        view: v,
        center: { x: v.width / 2, y: v.height / 2 },
        base: { width: v.width, height: v.height },
        scale: { x: 1, y: 1 },
        rotation: 0,
        alpha: 1,
        filter: "none",
        fx: ramp.fx,
        mask: ramp.mask,
        feather: ramp.feather,
        softness: ramp.softness,
        overlays: ramp.overlay ? [ramp.overlay] : [],
        effectDraws: [],
        shader: ramp.shader,
        shaderProgress: ramp.progress,
        shaderColor: transitionRgb(ramp.color),
        seedKey: key,
        paint: (target) => target.drawImage(sceneCanvas(v, 1), -v.width / 2, -v.height / 2, v.width, v.height),
      });
    },
    "jpeg",
  );
}

/* ------------------------------------------------------------------ *
 * Filters & looks
 * ------------------------------------------------------------------ */

export function filterPreviewDataUrl(look: FilterLook, view: PreviewView = THUMB_VIEW): string {
  const { filters, grade } = lookValues(look);
  return previewDataUrl(
    `look:${look.id}`,
    view,
    (ctx, v) => {
      const scene = sceneCanvas(v, 0);
      renderInk({
        ctx,
        view: v,
        center: { x: v.width / 2, y: v.height / 2 },
        base: { width: v.width, height: v.height },
        scale: { x: 1, y: 1 },
        rotation: 0,
        alpha: 1,
        // `blur` is measured in project pixels, so it shrinks with the frame.
        filter: filterStringOf({ ...filters, blur: filters.blur * (v.width / REFERENCE.width) }),
        grade,
        fx: NEUTRAL_FX,
        feather: 0,
        softness: 0,
        overlays: [],
        effectDraws: [],
        shaderProgress: 1,
        shaderColor: [1, 1, 1],
        seedKey: look.id,
        paint: (target) => target.drawImage(scene, -v.width / 2, -v.height / 2, v.width, v.height),
      });
    },
    "jpeg",
  );
}

/* ------------------------------------------------------------------ *
 * Effects & backgrounds
 * ------------------------------------------------------------------ */

/**
 * Effects are drawn over the stand-in photo, because most of them are blended
 * (screen, overlay, multiply) and would read as nothing against a flat fill.
 * The card samples the effect part-way through its loop, where it is densest.
 */
export function effectPreviewDataUrl(preset: EffectPreset, view: PreviewView = THUMB_VIEW): string {
  return previewDataUrl(
    `fx:${preset.id}`,
    view,
    (ctx, v) => {
      ctx.drawImage(sceneCanvas(v, 0), 0, 0, v.width, v.height);
      renderInk({
        ctx,
        view: v,
        center: { x: v.width / 2, y: v.height / 2 },
        base: { width: v.width, height: v.height },
        scale: { x: 1, y: 1 },
        rotation: 0,
        alpha: 1,
        filter: "none",
        fx: NEUTRAL_FX,
        feather: 0,
        softness: 0,
        overlays: [],
        effectDraws: [
          {
            style: preset.style,
            width: v.width,
            height: v.height,
            time: ((hashSeed(preset.id) % 1024) / 1024) * 6,
            seedKey: preset.id,
          },
        ],
        shaderProgress: 1,
        shaderColor: [1, 1, 1],
        seedKey: preset.id,
        paint: () => {},
      });
    },
    "jpeg",
  );
}

/** A background is an ordinary effect layer, so its card is a real frame of one. */
export function backgroundPreviewDataUrl(preset: BackgroundPreset, view: PreviewView = THUMB_VIEW): string {
  return previewDataUrl(
    `bg:${preset.id}`,
    view,
    (ctx, v) => {
      const settings = settingsFor(v);
      // A stable id keeps procedural seeds identical on every reload.
      const layer: Layer = { ...createBackgroundLayer(settings, 0, preset), id: `bg-${preset.id}` };
      drawFrame({ ctx, settings, layers: [layer], assets: {}, time: 1.4, drawBackground: false });
    },
    "jpeg",
  );
}

/* ------------------------------------------------------------------ *
 * Shapes & text
 * ------------------------------------------------------------------ */

export function shapePreviewDataUrl(shape: ShapeId, view: PreviewView = SHAPE_VIEW): string {
  return previewDataUrl(`shape:${shape}`, view, (ctx, v) => {
    const settings = settingsFor(v);
    const layer: Layer = { ...createShapeLayer(settings, 0, shape), id: `shape-${shape}` };
    drawFrame({ ctx, settings, layers: [layer], assets: {}, time: 0, drawBackground: false });
  });
}

/**
 * Text cards sample the real `TextStyle` through the real painter — font,
 * weight, outline, shadow, background box and skew are all untouched. Only the
 * scale is chosen to fit the card, the way a title sits in a frame.
 */
export function textPreviewDataUrl(preset: TextPreset, view: PreviewView = TEXT_VIEW): string {
  return previewDataUrl(`text:${preset.id}`, view, (ctx, v) => {
    const settings = settingsFor(v);
    const base = createTextLayer(settings, 0, preset.sample);
    const text = { ...base.text!, ...preset.text, content: preset.sample };
    const measured = measureText(text, v.width * DEFAULT_WRAP_RATIO);
    const layer: Layer = {
      ...base,
      id: `text-${preset.id}`,
      text,
      transform: {
        ...base.transform,
        scale: Math.min(0.94, (v.width * 0.88) / Math.max(1, measured.width), (v.height * 0.8) / Math.max(1, measured.height)),
      },
    };
    drawFrame({ ctx, settings, layers: [layer], assets: {}, time: 0, drawBackground: false });
  });
}
