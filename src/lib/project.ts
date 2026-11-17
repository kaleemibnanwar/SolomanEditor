/**
 * Pure project helpers — ordering, duration, factories, snapping.
 * No React, no DOM: usable from the store, the compositor and the export engine.
 */
import { NEUTRAL_FILTERS, NEUTRAL_GRADE, layerEnd } from "@/lib/anim";
import { DEFAULT_SHAPE_STYLE, type BackgroundPreset } from "@/lib/library";
import type {
  Asset,
  EffectStyle,
  Layer,
  LayerFilters,
  LayerType,
  Project,
  ProjectSettings,
  ShapeId,
  StickerStyle,
  TextStyle,
  Transition,
} from "@/types/editor";
import { uid } from "@/lib/time";

export { layerEnd } from "@/lib/anim";

export const MIN_LAYER_DURATION = 0.08;

export const orderedLayers = (project: Project): Layer[] =>
  project.layerIds.map((id) => project.layers[id]).filter(Boolean);

export const topFirstLayers = (project: Project): Layer[] => orderedLayers(project).reverse();

export function projectDuration(project: Project): number {
  return orderedLayers(project).reduce((max, l) => Math.max(max, layerEnd(l)), 0);
}

export function layersAtTime(project: Project, time: number): Layer[] {
  return orderedLayers(project).filter((l) => time >= l.startTime && time < layerEnd(l) - 1e-6);
}

export const nextZIndex = (project: Project) => project.layerIds.length;

/** Re-derives layer.zIndex from the canonical layerIds order. */
export function withNormalizedZ(project: Project): Project {
  const layers = { ...project.layers };
  let changed = false;
  project.layerIds.forEach((id, index) => {
    if (layers[id] && layers[id].zIndex !== index) {
      layers[id] = { ...layers[id], zIndex: index };
      changed = true;
    }
  });
  return changed ? { ...project, layers } : project;
}

export const NO_TRANSITION: Transition = { type: "none", duration: 0.5, direction: "left" };

export function createLayer(partial: Partial<Layer> & Pick<Layer, "type">): Layer {
  const base: Layer = {
    id: uid("layer"),
    type: partial.type,
    name: partial.type,
    // Empty means "not placed yet" — the store's insertLayer asks `placeLayer`
    // for a row (`lib/tracks.ts`).
    trackId: "",
    startTime: 0,
    duration: 5,
    inPoint: 0,
    transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    opacity: 1,
    volume: 1,
    audioFadeIn: 0,
    audioFadeOut: 0,
    zIndex: 0,
    filters: { ...NEUTRAL_FILTERS },
    grade: { ...NEUTRAL_GRADE },
    keyframes: [],
    transitionIn: { ...NO_TRANSITION },
    transitionOut: { ...NO_TRANSITION },
    locked: false,
    hidden: false,
  };
  return { ...base, ...partial };
}

/* ------------------------------------------------------------------ *
 * Factories
 * ------------------------------------------------------------------ */

export function mediaLayerDefaults(asset: Asset, settings: ProjectSettings, startTime: number) {
  const natW = asset.width || settings.width;
  const natH = asset.height || settings.height;
  const isAudio = asset.kind === "audio";
  const fit = Math.min(settings.width / natW, settings.height / natH);
  const sourceDuration = asset.duration && asset.duration > 0 ? asset.duration : 5;
  return {
    assetId: asset.id,
    startTime,
    // Source media should land on the timeline at its natural length. The old
    // 60-second cap made multi-hour files appear to contain only their opening
    // minute even though the browser had loaded the full asset.
    duration: asset.kind === "image" ? 5 : sourceDuration,
    name: asset.name,
    transform: {
      x: settings.width / 2,
      y: settings.height / 2,
      scale: isAudio ? 1 : fit,
      rotation: 0,
    },
  };
}

export function createMediaLayer(asset: Asset, settings: ProjectSettings, startTime: number): Layer {
  return createLayer({
    type: asset.kind === "audio" ? "audio" : asset.kind === "image" ? "image" : "video",
    ...mediaLayerDefaults(asset, settings, startTime),
  });
}

export const DEFAULT_TEXT = (settings: ProjectSettings): TextStyle => ({
  content: "Your text here",
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: Math.round(settings.height * 0.075),
  fontWeight: 800,
  color: "#ffffff",
  align: "center",
  lineHeight: 1.2,
  letterSpacing: 0,
  backgroundColor: "transparent",
  backgroundRadius: 12,
  strokeColor: "#000000",
  strokeWidth: 0,
  shadow: true,
  gradient: 0,
  gradientColor: "#f97316",
  skew: 0,
});

export function createTextLayer(settings: ProjectSettings, startTime: number, content?: string): Layer {
  const text = DEFAULT_TEXT(settings);
  if (content) text.content = content;
  return createLayer({
    type: "text",
    name: content ? content.slice(0, 22) : "Text",
    startTime,
    duration: 4,
    text,
    transform: { x: settings.width / 2, y: settings.height / 2, scale: 1, rotation: 0 },
  });
}

export function createStickerLayer(
  settings: ProjectSettings,
  startTime: number,
  sticker: StickerStyle,
  name?: string,
): Layer {
  return createLayer({
    type: "sticker",
    name: name ?? (sticker.shape ? `${sticker.shape} shape` : (sticker.glyph ?? "Sticker")),
    startTime,
    duration: 3,
    sticker: { ...sticker },
    transform: { x: settings.width / 2, y: settings.height / 2, scale: 1, rotation: 0 },
  });
}

/** A shape sticker, pre-styled so it reads on any footage. */
export function createShapeLayer(settings: ProjectSettings, startTime: number, shape: ShapeId): Layer {
  return createStickerLayer(settings, startTime, { ...DEFAULT_SHAPE_STYLE, shape });
}

export function createEffectLayer(settings: ProjectSettings, startTime: number, style: EffectStyle, name?: string): Layer {
  return createLayer({
    type: "effect",
    name: name ?? `${style.kind} effect`,
    startTime,
    duration: 4,
    effect: { ...style },
    transform: { x: settings.width / 2, y: settings.height / 2, scale: 1, rotation: 0 },
  });
}

/**
 * A background preset becomes an ordinary effect layer that fills the frame, so
 * it can be moved, trimmed, faded and keyframed like anything else.
 */
export function createBackgroundLayer(settings: ProjectSettings, startTime: number, preset: BackgroundPreset): Layer {
  return createLayer({
    type: "effect",
    name: preset.label,
    startTime,
    duration: 6,
    effect: { ...preset.style },
    transform: { x: settings.width / 2, y: settings.height / 2, scale: preset.cover ? 1 : 0.6, rotation: 0 },
  });
}

/* ------------------------------------------------------------------ *
 * Snapping
 * ------------------------------------------------------------------ */

export function collectSnapTargets(project: Project, excludeIds: string[]): number[] {
  const targets = new Set<number>([0]);
  for (const layer of orderedLayers(project)) {
    if (excludeIds.includes(layer.id)) continue;
    targets.add(layer.startTime);
    targets.add(layerEnd(layer));
  }
  return [...targets].sort((a, b) => a - b);
}

/** Returns the snapped value plus the target it snapped to (for guide display). */
export function snapValue(value: number, targets: number[], tolerance: number): { value: number; target: number | null } {
  let best: number | null = null;
  let bestDist = tolerance;
  for (const t of targets) {
    const d = Math.abs(t - value);
    if (d <= bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best === null ? { value, target: null } : { value: best, target: best };
}

/* ------------------------------------------------------------------ *
 * Presentation metadata
 * ------------------------------------------------------------------ */

export const LAYER_COLORS: Record<LayerType, string> = {
  video: "#6a6b6f",
  image: "#77797d",
  text: "#85868a",
  audio: "#656b6f",
  sticker: "#737479",
  effect: "#5f6266",
};

export const LAYER_LABELS: Record<LayerType, string> = {
  video: "Video",
  image: "Image",
  text: "Text",
  audio: "Audio",
  sticker: "Sticker",
  effect: "Effect",
};

export function assetKindToLayerType(kind: Asset["kind"]): LayerType {
  return kind === "audio" ? "audio" : kind === "image" ? "image" : "video";
}

export function projectIsEmpty(project: Project) {
  return project.layerIds.length === 0;
}
