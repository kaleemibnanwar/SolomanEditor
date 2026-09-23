/**
 * Animation / evaluation layer.
 *
 * This module turns a layer + a project time into concrete draw values.
 * Both the live preview and the export renderer call into here, so the
 * exported frame is guaranteed to match what the user saw on the canvas.
 */
import type { AnimatableProp, Easing, Layer, LayerGrade } from "@/types/editor";

const EASINGS: Record<Easing, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  easeInQuad: (t) => t * t,
  bounce: (t) => {
    const n = 7.5625;
    const d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

/** Time relative to the start of the layer, in seconds. */
export const localTimeOf = (layer: Layer, time: number) => time - layer.startTime;

export const layerSpansTime = (layer: Layer, time: number) => {
  const lt = localTimeOf(layer, time);
  return lt >= -1e-6 && lt < layer.duration - 1e-6;
};

export const layerEnd = (layer: Layer) => layer.startTime + layer.duration;

type LayerLike = Pick<Layer, "opacity" | "volume" | "transform" | "keyframes">;

/** Position and size live under `transform`; opacity and volume are top-level. */
type TransformProp = "x" | "y" | "scale" | "rotation";
const isTransformProp = (prop: AnimatableProp): prop is TransformProp =>
  prop !== "opacity" && prop !== "volume";

/**
 * Evaluate an animatable property at a layer-local time.
 * Falls back to the static layer value when no keyframes exist for that property.
 */
export function evalProp(layer: LayerLike, prop: AnimatableProp, localTime: number): number {
  const staticValue = isTransformProp(prop) ? layer.transform[prop] : layer[prop];
  const keys = layer.keyframes.filter((k) => k.prop === prop).sort((a, b) => a.time - b.time);
  if (keys.length === 0) return staticValue;
  if (keys.length === 1) return keys[0].value;
  if (localTime <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (localTime >= last.time) return last.value;

  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (localTime >= a.time && localTime <= b.time) {
      const span = b.time - a.time;
      const t = span <= 0 ? 1 : (localTime - a.time) / span;
      const eased = EASINGS[a.easing]?.(t) ?? t;
      return a.value + (b.value - a.value) * eased;
    }
  }
  return staticValue;
}

export interface EvaluatedLayer {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  volume: number;
}

/**
 * Keyframe-only evaluation of a layer at a project time.
 *
 * Deliberately EXCLUDES transition ramps: those are applied by the compositor,
 * which is the only place that knows the layer's drawn box and can therefore
 * resolve a fractional offset into pixels. `rampsAt` gives the compositor the
 * same ink the library thumbnails are drawn from.
 */
export function evaluateLayer(layer: Layer, time: number): EvaluatedLayer {
  const lt = localTimeOf(layer, time);
  return {
    x: evalProp(layer, "x", lt),
    y: evalProp(layer, "y", lt),
    scale: evalProp(layer, "scale", lt),
    rotation: evalProp(layer, "rotation", lt),
    opacity: evalProp(layer, "opacity", lt),
    volume: evalProp(layer, "volume", lt),
  };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Audio gain envelope (layer-local), honouring fade in/out plus keyframed volume. */
export function evaluateGain(layer: Layer, localTime: number): number {
  let gain = evalProp(layer, "volume", localTime);
  if (layer.audioFadeIn > 0) gain *= clamp01(localTime / layer.audioFadeIn);
  if (layer.audioFadeOut > 0) gain *= clamp01((layer.duration - localTime) / layer.audioFadeOut);
  return Math.max(0, gain);
}

export const NEUTRAL_FILTERS = {
  brightness: 1,
  contrast: 1,
  saturate: 1,
  blur: 0,
  grayscale: 0,
  sepia: 0,
  hueRotate: 0,
  invert: 0,
} as const;

/** Builds a canvas ctx.filter string. Returns "none" when everything is neutral. */
export function filterString(layer: Layer): string {
  const f = layer.filters;
  const parts: string[] = [];
  if (f.brightness !== 1) parts.push(`brightness(${f.brightness})`);
  if (f.contrast !== 1) parts.push(`contrast(${f.contrast})`);
  if (f.saturate !== 1) parts.push(`saturate(${f.saturate})`);
  if (f.hueRotate !== 0) parts.push(`hue-rotate(${f.hueRotate}deg)`);
  if (f.blur > 0) parts.push(`blur(${f.blur}px)`);
  if (f.grayscale > 0) parts.push(`grayscale(${f.grayscale})`);
  if (f.sepia > 0) parts.push(`sepia(${f.sepia})`);
  if (f.invert > 0) parts.push(`invert(${f.invert})`);
  return parts.length ? parts.join(" ") : "none";
}

export const NEUTRAL_GRADE: LayerGrade = {
  temperature: 0,
  tint: 0,
  fade: 0,
  vignette: 0,
  grain: 0,
};

/** Cheap check so the compositor can skip the grade pass entirely. */
export const isNeutralGrade = (g: LayerGrade | undefined): boolean =>
  !g || (g.temperature === 0 && g.tint === 0 && g.fade === 0 && g.vignette === 0 && g.grain === 0);
