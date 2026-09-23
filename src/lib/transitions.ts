/**
 * THE TRANSITIONS ENGINE.
 *
 * A transition is described once, as data (the `TransitionDef` catalogue the
 * library UI renders) plus a pure function that turns an "absence amount" into
 * *ink* — the clip mask, the transform nudges and the overlay a transition
 * paints. The compositor applies that ink; the library renders thumbnails from
 * the exact same code, so a preview can never lie about what a transition does.
 *
 * Three tiers, by capability:
 *   1. Transform   — alpha / offset / scale / rotation / blur. Cheap, vector-safe.
 *   2. Raster      — a scratch surface for feathering, slices, RGB split, mosaic.
 *   3. Shader      — a real GLSL pass over frame A and frame B (see `gl.ts`).
 */
import { shapePath, starPath, heartPath, ellipsePath } from "@/lib/shapes";
import { hashSeed, rngFor } from "@/lib/random";
import type { ShaderTransitionId } from "@/lib/gl";
import type { Layer, Transition, TransitionDirection, TransitionType } from "@/types/editor";

export { hashSeed } from "@/lib/random";

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

export type TransitionCategory = "basic" | "motion" | "wipe" | "shape" | "light" | "glitch" | "shader" | "blur";
export type TransitionParam = "softness" | "color" | "intensity";

export interface TransitionDef {
  id: TransitionType;
  label: string;
  category: TransitionCategory;
  /** the direction control is meaningful */
  directional?: boolean;
  /** extra controls the inspector should expose */
  params?: TransitionParam[];
  /** one-line description for the library card */
  hint: string;
}

export const TRANSITION_CATEGORIES: { id: TransitionCategory; label: string }[] = [
  { id: "basic", label: "Basic" },
  { id: "motion", label: "Motion" },
  { id: "wipe", label: "Wipe" },
  { id: "shape", label: "Shape" },
  { id: "light", label: "Light" },
  { id: "glitch", label: "Glitch" },
  { id: "shader", label: "Shader" },
  { id: "blur", label: "Blur" },
];

export const TRANSITION_DEFS: TransitionDef[] = [
  // ---- Basic -------------------------------------------------------
  { id: "none", label: "None", category: "basic", hint: "no transition — the clip simply appears" },
  { id: "cut", label: "Cut", category: "basic", hint: "hard cut, always instant" },
  { id: "fade", label: "Fade", category: "basic", params: ["intensity"], hint: "cross dissolve to transparent" },
  { id: "dissolve", label: "Dissolve", category: "basic", params: ["softness", "intensity"], hint: "grainy particle dissolve" },
  { id: "dipToColor", label: "Dip to colour", category: "basic", params: ["color"], hint: "fade through a solid colour" },

  // ---- Motion ------------------------------------------------------
  { id: "slide", label: "Slide", category: "motion", directional: true, hint: "the clip slides in from an edge" },
  { id: "push", label: "Push", category: "motion", directional: true, hint: "slides in while softly fading" },
  { id: "whip", label: "Whip pan", category: "motion", directional: true, params: ["intensity"], hint: "fast directional pan with motion blur" },
  { id: "zoomIn", label: "Zoom in", category: "motion", params: ["intensity"], hint: "grows up into place" },
  { id: "zoomOut", label: "Zoom out", category: "motion", params: ["intensity"], hint: "settles down from oversize" },
  { id: "spin", label: "Spin", category: "motion", hint: "half a rotation into place" },
  { id: "squeeze", label: "Squeeze", category: "motion", directional: true, hint: "collapses along one axis" },
  { id: "flip", label: "Flip", category: "motion", directional: true, hint: "3D card flip on its axis" },
  { id: "bounce", label: "Bounce", category: "motion", hint: "drops in and settles with a bounce" },
  { id: "drop", label: "Drop", category: "motion", params: ["intensity"], hint: "falls from above with weight" },

  // ---- Wipe --------------------------------------------------------
  { id: "wipe", label: "Linear wipe", category: "wipe", directional: true, params: ["softness"], hint: "a straight edge sweeps across" },
  { id: "wipeDiagonal", label: "Diagonal", category: "wipe", directional: true, params: ["softness"], hint: "a tilted edge sweeps across" },
  { id: "softWipe", label: "Soft wipe", category: "wipe", directional: true, params: ["softness"], hint: "heavily feathered gradient wipe" },
  { id: "blinds", label: "Blinds", category: "wipe", directional: true, params: ["softness"], hint: "parallel slats open together" },
  { id: "checker", label: "Checkerboard", category: "wipe", params: ["softness"], hint: "cells pop in on a grid" },
  { id: "barn", label: "Barn doors", category: "wipe", directional: true, hint: "two doors open from the middle" },

  // ---- Shape -------------------------------------------------------
  { id: "iris", label: "Iris", category: "shape", params: ["softness"], hint: "a circle opens from the centre" },
  { id: "clock", label: "Clock", category: "shape", params: ["softness"], hint: "a radial sweep like a clock hand" },
  { id: "star", label: "Star", category: "shape", params: ["softness"], hint: "a star mask scales up" },
  { id: "heart", label: "Heart", category: "shape", params: ["softness"], hint: "a heart mask scales up" },
  { id: "hexagon", label: "Hexagon", category: "shape", params: ["softness"], hint: "a hexagonal mask scales up" },

  // ---- Light -------------------------------------------------------
  { id: "flash", label: "Flash", category: "light", params: ["color", "intensity"], hint: "a white flash blows out the cut" },
  { id: "lightLeak", label: "Light leak", category: "light", directional: true, params: ["color", "intensity"], hint: "a warm diagonal light streak" },
  { id: "glowPulse", label: "Glow pulse", category: "light", params: ["color", "intensity"], hint: "a radial glow blooms and fades" },
  { id: "filmBurn", label: "Film burn", category: "light", params: ["color", "intensity"], hint: "heat haze and scorched edges" },

  // ---- Glitch ------------------------------------------------------
  { id: "glitch", label: "Glitch", category: "glitch", params: ["intensity"], hint: "torn slices and channel split" },
  { id: "rgbSplit", label: "RGB split", category: "glitch", params: ["intensity"], hint: "chromatic channels separate" },
  { id: "pixelate", label: "Pixelate", category: "glitch", params: ["intensity"], hint: "mosaic blocks until it resolves" },
  { id: "scanline", label: "Scanlines", category: "glitch", params: ["color", "intensity"], hint: "CRT lines roll over the cut" },
  { id: "sliceShift", label: "Slice shift", category: "glitch", params: ["intensity"], hint: "wide bands shear sideways" },

  // ---- Shader ------------------------------------------------------
  { id: "swirl", label: "Swirl", category: "shader", params: ["intensity"], hint: "GLSL swirl warp between clips" },
  { id: "ripple", label: "Ripple", category: "shader", params: ["intensity"], hint: "concentric water ripple displacement" },
  { id: "melt", label: "Melt", category: "shader", params: ["softness"], hint: "columns drip downward" },
  { id: "crossZoom", label: "Cross zoom", category: "shader", hint: "one clip zooms through the other" },
  { id: "luma", label: "Luma wipe", category: "shader", params: ["softness"], hint: "procedural luma mask dissolves" },
  { id: "crosswarp", label: "Cross warp", category: "shader", hint: "clips warp toward each other" },
  { id: "waterDrop", label: "Water drop", category: "shader", params: ["softness"], hint: "a droplet spreads outward" },

  // ---- Blur --------------------------------------------------------
  { id: "blur", label: "Blur", category: "blur", params: ["intensity"], hint: "defocus out and back in" },
  { id: "crossBlur", label: "Cross blur", category: "blur", params: ["intensity"], hint: "both clips peak blur mid-cut" },
  { id: "shake", label: "Camera shake", category: "blur", params: ["intensity"], hint: "handheld jolt across the cut" },
];

export const TRANSITION_BY_ID: Record<string, TransitionDef> = Object.fromEntries(
  TRANSITION_DEFS.map((def) => [def.id, def]),
);

const SHADER_IDS = new Set<TransitionType>(["swirl", "ripple", "melt", "crossZoom", "luma", "crosswarp", "waterDrop"]);

export const transitionDef = (type: TransitionType): TransitionDef | undefined => TRANSITION_BY_ID[type];

export const isShaderTransition = (type: TransitionType): boolean => SHADER_IDS.has(type);

/** Transitions that do nothing at all — used to keep the timeline clean. */
export const isNoopTransition = (t: Transition | undefined) =>
  !t || t.type === "none" || t.type === "cut" || t.duration <= 0;

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

export interface ResolvedTransition {
  type: TransitionType;
  duration: number;
  direction: TransitionDirection;
  softness: number;
  color: string;
  intensity: number;
}

export const DEFAULT_SOFTNESS = 0.3;

export function resolveTransition(t: Transition): ResolvedTransition {
  return {
    type: t.type,
    duration: Math.max(0, t.duration),
    direction: t.direction ?? "left",
    softness: clamp01(t.softness ?? DEFAULT_SOFTNESS),
    color: t.color ?? "#ffffff",
    intensity: clamp01(t.intensity ?? 1),
  };
}

/* ------------------------------------------------------------------ *
 * Ink
 * ------------------------------------------------------------------ */

/** Transform-level nudges. Offsets are fractions of the layer's own box. */
export interface RampFx {
  alpha: number;
  dx: number;
  dy: number;
  scaleMul: number;
  scaleXMul: number;
  scaleYMul: number;
  rotate: number;
  blur: number;
  slices?: { count: number; spread: number };
  rgbSplit?: number;
  pixelate?: number;
}

export const NEUTRAL_FX: RampFx = {
  alpha: 1,
  dx: 0,
  dy: 0,
  scaleMul: 1,
  scaleXMul: 1,
  scaleYMul: 1,
  rotate: 0,
  blur: 0,
};

export interface RampInk {
  def: TransitionDef;
  /** 0 = the transition's "from" side, 1 = fully settled */
  progress: number;
  /** 1 - progress: how far out of place the clip is */
  amount: number;
  fx: RampFx;
  /** Clip the content to this region. Layer-local space, centred on (0,0). */
  mask?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  /** Paint on top of the content, same space. */
  overlay?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  /** Run a GLSL pass over the whole frame instead of drawing the clip directly. */
  shader?: ShaderTransitionId;
  /** The ramp needs an offscreen surface (feathered mask / raster fx). */
  needsScratch: boolean;
  /** Multiplier on the user's softness — lets a preset feather harder by default. */
  feather: number;
  /** Resolved feather amount, carried so the renderer needs no second lookup. */
  softness: number;
  /** Resolved accent colour, used by the shader tier. */
  color: string;
}

function dirVec(d: TransitionDirection) {
  switch (d) {
    case "right":
      return { x: 1, y: 0 };
    case "up":
      return { x: 0, y: -1 };
    case "down":
      return { x: 0, y: 1 };
    default:
      return { x: -1, y: 0 };
  }
}

const hexToRgb = (hex: string): [number, number, number] => {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const num = Number.parseInt(full.slice(0, 6) || "ffffff", 16);
  if (!Number.isFinite(num)) return [1, 1, 1];
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
};

export const transitionRgb = hexToRgb;

/* ---- mask builders ------------------------------------------------ */

type MaskFn = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;

/** Straight-edged reveal. `amount` 1 → nothing visible. */
function wipeMask(dir: TransitionDirection, amount: number): MaskFn {
  const reveal = 1 - amount;
  return (ctx, w, h) => {
    ctx.beginPath();
    switch (dir) {
      case "right":
        ctx.rect(w / 2 - w * reveal, -h / 2, w * reveal, h);
        break;
      case "up":
        ctx.rect(-w / 2, -h / 2, w, h * reveal);
        break;
      case "down":
        ctx.rect(-w / 2, h / 2 - h * reveal, w, h * reveal);
        break;
      default:
        ctx.rect(-w / 2, -h / 2, w * reveal, h);
    }
  };
}

/** Tilted reveal — the cut line runs at 45°. */
function diagonalMask(dir: TransitionDirection, amount: number): MaskFn {
  const reveal = 1 - amount;
  return (ctx, w, h) => {
    ctx.beginPath();
    const travel = (w + h) * reveal;
    if (dir === "up" || dir === "down") {
      const cutY = dir === "up" ? -h / 2 + travel : h / 2 - travel;
      ctx.moveTo(-w / 2, -h / 2);
      ctx.lineTo(w / 2, -h / 2);
      ctx.lineTo(w / 2, dir === "up" ? cutY - w : cutY + w);
      ctx.lineTo(-w / 2, dir === "up" ? cutY - w : cutY + w);
    } else {
      const cutX = dir === "left" ? -w / 2 + travel : w / 2 - travel;
      ctx.moveTo(-w / 2, -h / 2);
      ctx.lineTo(dir === "left" ? cutX : w / 2, -h / 2);
      ctx.lineTo(dir === "left" ? cutX - h : w / 2, h / 2);
      ctx.lineTo(-w / 2, h / 2);
    }
    ctx.closePath();
  };
}

/* ---- the core: amount → ink -------------------------------------- */

export function makeRamp(type: TransitionType, progress: number, opts: ResolvedTransition, seed: number): RampInk {
  const def = TRANSITION_BY_ID[type] ?? TRANSITION_BY_ID.fade;
  const p = clamp01(progress);
  const a = 1 - p;
  const fx: RampFx = { ...NEUTRAL_FX };
  const intensity = Math.max(0.05, opts.intensity);
  const dir = opts.direction;
  let mask: RampInk["mask"];
  let overlay: RampInk["overlay"];
  let shader: ShaderTransitionId | undefined;

  switch (type) {
    /* ---------------- basic ---------------- */
    case "none":
    case "cut":
      break;

    case "fade":
      fx.alpha = 1 - a * intensity;
      break;

    case "dissolve":
      fx.alpha = 0;
      mask = (ctx, w, h) => {
        const rand = rngFor(seed);
        const cell = Math.max(6, Math.round(Math.min(w, h) / 34));
        const cols = Math.ceil(w / cell);
        const rows = Math.ceil(h / cell);
        const threshold = 1 - a;
        ctx.beginPath();
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const n = rand() * 0.65 + ((r + c) / (rows + cols)) * 0.35;
            if (n < threshold) ctx.rect(-w / 2 + c * cell, -h / 2 + r * cell, cell, cell);
          }
        }
      };
      fx.alpha = 1;
      break;

    case "dipToColor":
      // Solid colour sitting over the clip, peaking exactly when it is fully absent.
      overlay = (ctx, w, h) => {
        const alpha = Math.sin(Math.PI * a) * intensity;
        if (alpha <= 0.001) return;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = opts.color;
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.globalAlpha = 1;
      };
      fx.alpha = 1;
      break;

    /* ---------------- motion ---------------- */
    case "slide": {
      const v = dirVec(dir);
      fx.dx = v.x * a;
      fx.dy = v.y * a;
      break;
    }

    case "push": {
      const v = dirVec(dir);
      fx.dx = v.x * a * 0.92;
      fx.dy = v.y * a * 0.92;
      fx.alpha = 1 - a * 0.25;
      break;
    }

    case "whip": {
      const v = dirVec(dir);
      fx.dx = v.x * a * 1.35;
      fx.dy = v.y * a * 1.35;
      fx.blur = a * 26 * intensity;
      fx.alpha = 1 - a * 0.55;
      break;
    }

    case "zoomIn":
      fx.scaleMul = 1 - a * 0.55 * intensity;
      fx.alpha = 1 - a;
      break;

    case "zoomOut":
      fx.scaleMul = 1 + a * 0.5 * intensity;
      fx.alpha = 1 - a;
      break;

    case "spin":
      fx.rotate = a * 180;
      fx.scaleMul = 1 - a * 0.28;
      fx.alpha = 1 - a;
      break;

    case "squeeze":
      if (dir === "up" || dir === "down") fx.scaleYMul = Math.max(0.001, 1 - a);
      else fx.scaleXMul = Math.max(0.001, 1 - a);
      fx.alpha = 1 - a * 0.55;
      break;

    case "flip":
      if (dir === "up" || dir === "down") fx.scaleYMul = Math.cos(Math.PI * a);
      else fx.scaleXMul = Math.cos(Math.PI * a);
      fx.alpha = 1 - a * 0.35;
      break;

    case "bounce": {
      const t = p;
      const overshoot = Math.sin(t * Math.PI) * (1 - t);
      fx.dy = -a * 0.85 * (1 - overshoot * 0.4);
      fx.scaleMul = 1 - a * 0.12 * Math.abs(Math.cos(t * Math.PI * 2));
      fx.alpha = 1 - a * 0.9;
      break;
    }

    case "drop": {
      const ease = 1 - (1 - p) * (1 - p);
      fx.dy = -(1 - ease) * 1.05 * intensity;
      fx.alpha = 1 - a * 0.85;
      break;
    }

    /* ---------------- wipe ---------------- */
    case "wipe":
      mask = wipeMask(dir, a);
      break;

    case "wipeDiagonal":
      mask = diagonalMask(dir, a);
      break;

    case "softWipe":
      mask = wipeMask(dir, a);
      break;

    case "blinds": {
      const bands = 12;
      mask = (ctx, w, h) => {
        ctx.beginPath();
        const bandH = h / bands;
        const grow = bandH * (1 - a);
        for (let i = 0; i < bands; i++) {
          const y = -h / 2 + i * bandH;
          if (dir === "up") ctx.rect(-w / 2, y + bandH - grow, w, grow);
          else if (dir === "down") ctx.rect(-w / 2, y, w, grow);
          else ctx.rect(-w / 2 + (dir === "left" ? 0 : w - w * (1 - a)), y, w * (1 - a), bandH);
        }
      };
      break;
    }

    case "checker": {
      const cells = 9;
      mask = (ctx, w, h) => {
        const rand = rngFor(seed);
        const cw = w / cells;
        const ch = h / cells;
        const threshold = 1 - a;
        ctx.beginPath();
        for (let r = 0; r < cells; r++) {
          for (let c = 0; c < cells; c++) {
            const n = rand() * 0.5 + ((r + c) / (cells * 2)) * 0.5;
            if (n < threshold) ctx.rect(-w / 2 + c * cw, -h / 2 + r * ch, cw, ch);
          }
        }
      };
      break;
    }

    case "barn": {
      const reveal = 1 - a;
      mask = (ctx, w, h) => {
        ctx.beginPath();
        if (dir === "up" || dir === "down") ctx.rect(-w / 2, -h / 2, w, h * reveal);
        else ctx.rect(-w / 2, -h / 2, w * reveal, h);
      };
      break;
    }

    /* ---------------- shape ---------------- */
    case "iris":
    case "clock":
    case "star":
    case "heart":
    case "hexagon": {
      const reveal = 1 - a;
      mask = (ctx, w, h) => {
        const r = Math.hypot(w, h) * 0.55;
        if (type === "iris") ellipsePath(ctx, 0, 0, r * reveal, r * reveal);
        else if (type === "clock") {
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + reveal * Math.PI * 2);
          ctx.closePath();
        } else if (type === "star") starPath(ctx, 0, 0, r * reveal);
        else if (type === "heart") heartPath(ctx, 0, 0, r * reveal);
        else shapePath(ctx, "hexagon", 0, 0, r * reveal);
      };
      break;
    }

    /* ---------------- light ---------------- */
    case "flash":
      overlay = (ctx, w, h) => {
        const alpha = Math.sin(Math.PI * a) * 0.9 * intensity;
        if (alpha <= 0.001) return;
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.fillStyle = opts.color;
        ctx.fillRect(-w / 2, -h / 2, w, h);
        ctx.globalAlpha = 1;
      };
      break;

    case "lightLeak": {
      const v = dirVec(dir);
      overlay = (ctx, w, h) => {
        const alpha = a * 0.85 * intensity;
        if (alpha <= 0.001) return;
        const grad = ctx.createLinearGradient((-v.x * w) / 2 - w * 0.15, (-v.y * h) / 2, (v.x * w) / 2 + w * 0.5, (v.y * h) / 2);
        const rgb = hexToRgb(opts.color);
        const rgba = (mul: number) => `rgba(${rgb.map((c) => Math.round(c * 255 * mul)).join(",")},`;
        grad.addColorStop(0, `${rgba(1)}${alpha * 0.1})`);
        grad.addColorStop(0.42, `${rgba(1)}${alpha})`);
        grad.addColorStop(1, `${rgba(0.6)}0)`);
        ctx.globalAlpha = 1;
        ctx.fillStyle = grad;
        ctx.fillRect(-w / 2, -h / 2, w, h);
      };
      break;
    }

    case "glowPulse":
      overlay = (ctx, w, h) => {
        const alpha = a * intensity;
        if (alpha <= 0.001) return;
        const radius = Math.max(w, h) * (0.35 + (1 - a) * 0.35);
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
        const rgb = hexToRgb(opts.color);
        grad.addColorStop(0, `rgba(${rgb.map((c) => Math.round(c * 255)).join(",")},${alpha})`);
        grad.addColorStop(0.6, `rgba(${rgb.map((c) => Math.round(c * 255 * 0.6)).join(",")},${alpha * 0.5})`);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(-w / 2, -h / 2, w, h);
      };
      break;

    case "filmBurn": {
      const rand = rngFor(seed);
      overlay = (ctx, w, h) => {
        const alpha = Math.pow(a, 1.15) * intensity;
        if (alpha <= 0.001) return;
        const grad = ctx.createRadialGradient(w * 0.12, -h * 0.1, 0, 0, 0, Math.max(w, h) * 0.75);
        const rgb = hexToRgb(opts.color);
        grad.addColorStop(0, `rgba(${rgb.map((c) => Math.round(c * 255)).join(",")},${alpha})`);
        grad.addColorStop(0.45, `rgba(120,40,10,${alpha * 0.45})`);
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.fillRect(-w / 2, -h / 2, w, h);
        // embers
        ctx.fillStyle = `rgba(255,180,80,${alpha * 0.7})`;
        for (let i = 0; i < 26; i++) {
          const x = (rand() - 0.5) * w;
          const y = (rand() - 0.5) * h;
          const s = 1 + rand() * 3;
          ctx.fillRect(x, y, s, s);
        }
      };
      break;
    }

    /* ---------------- glitch ---------------- */
    case "glitch":
      fx.slices = { count: 16, spread: 60 * a * intensity };
      fx.rgbSplit = 14 * a * intensity;
      fx.alpha = 1 - a * 0.3;
      break;

    case "rgbSplit":
      fx.rgbSplit = 26 * a * intensity;
      break;

    case "pixelate":
      fx.pixelate = Math.max(1, 1 + a * 46 * intensity);
      break;

    case "scanline":
      fx.alpha = 1 - a * 0.25;
      overlay = (ctx, w, h) => {
        const alpha = a * 0.55 * intensity;
        if (alpha <= 0.001) return;
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.fillStyle = opts.color;
        const step = 4;
        const offset = (1 - a) * step * 6;
        for (let y = -h / 2 + (offset % step); y < h / 2; y += step) {
          ctx.fillRect(-w / 2, y, w, step * 0.45);
        }
        ctx.globalAlpha = 1;
      };
      break;

    case "sliceShift":
      fx.slices = { count: 7, spread: 130 * a * intensity };
      fx.alpha = 1 - a * 0.2;
      break;

    /* ---------------- shader ---------------- */
    case "swirl":
    case "ripple":
    case "melt":
    case "crossZoom":
    case "luma":
    case "crosswarp":
    case "waterDrop":
      // The GLSL pass owns the whole frame, so the clip itself draws in full.
      shader = type as ShaderTransitionId;
      break;

    /* ---------------- blur ---------------- */
    case "blur":
      fx.blur = a * 42 * intensity;
      fx.alpha = 1 - a * 0.7;
      break;

    case "crossBlur":
      fx.blur = Math.sin(Math.PI * a) * 34 * intensity;
      fx.alpha = 1 - a * 0.35;
      break;

    case "shake": {
      const t = (1 - a) * Math.PI * 6;
      fx.dx = Math.sin(t * 3.1) * a * 0.05 * intensity;
      fx.dy = Math.sin(t * 2.3 + 1.1) * a * 0.05 * intensity;
      fx.rotate = Math.sin(t * 1.7) * a * 1.6 * intensity;
      break;
    }

    default:
      fx.alpha = 1 - a;
  }

  const needsScratch = !!mask || !!fx.slices || fx.rgbSplit !== undefined || fx.pixelate !== undefined || !!shader;

  let feather = 1;
  if (type === "softWipe") feather = 3;
  else if (type === "wipeDiagonal" || type === "barn") feather = 1.6;
  else if (type === "blinds" || type === "checker" || type === "dissolve") feather = 0.6;
  else if (type === "iris" || type === "clock" || type === "star" || type === "heart" || type === "hexagon") feather = 1.2;

  return {
    def,
    progress: p,
    amount: a,
    fx,
    mask,
    overlay,
    shader,
    needsScratch,
    feather,
    softness: opts.softness,
    color: opts.color,
  };
}

/* ------------------------------------------------------------------ *
 * Layer ramps
 * ------------------------------------------------------------------ */

/** Every ramp currently in flight for a layer, in application order. */
export function rampsAt(layer: Layer, localTime: number): RampInk[] {
  const out: RampInk[] = [];
  const inT = layer.transitionIn;
  if (!isNoopTransition(inT) && localTime < inT.duration) {
    const opts = resolveTransition(inT);
    out.push(makeRamp(opts.type, clamp01(localTime / opts.duration), opts, hashSeed(`${layer.id}:in:${opts.type}`)));
  }
  const outT = layer.transitionOut;
  if (!isNoopTransition(outT) && localTime > layer.duration - outT.duration) {
    const opts = resolveTransition(outT);
    out.push(
      makeRamp(opts.type, clamp01((layer.duration - localTime) / opts.duration), opts, hashSeed(`${layer.id}:out:${opts.type}`)),
    );
  }
  return out;
}

/** Combines the transform nudges of every active ramp into the layer values. */
export function combineFx(ramps: RampInk[]): RampFx {
  const out: RampFx = { ...NEUTRAL_FX };
  for (const ramp of ramps) {
    const fx = ramp.fx;
    out.alpha *= fx.alpha;
    out.dx += fx.dx;
    out.dy += fx.dy;
    out.scaleMul *= fx.scaleMul;
    out.scaleXMul *= fx.scaleXMul;
    out.scaleYMul *= fx.scaleYMul;
    out.rotate += fx.rotate;
    out.blur = Math.max(out.blur, fx.blur);
    if (fx.slices) out.slices = fx.slices;
    if (fx.rgbSplit !== undefined) out.rgbSplit = (out.rgbSplit ?? 0) + fx.rgbSplit;
    if (fx.pixelate !== undefined) out.pixelate = Math.max(out.pixelate ?? 1, fx.pixelate);
  }
  return out;
}

/** Human label for the timeline badge. */
export function describeTransition(t: Transition): string {
  const def = transitionDef(t.type);
  if (!def || isNoopTransition(t)) return "";
  return def.label;
}
