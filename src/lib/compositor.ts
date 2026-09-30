/**
 * THE COMPOSITOR.
 *
 * One function draws a frame of the composition into any 2D context. The live
 * preview calls it every animation frame; the export renderer calls it into an
 * offscreen canvas. Because both consume the same store projection, the same
 * `evaluateLayer` and the same ink renderer, exported frames match the preview
 * exactly.
 *
 * The compositor's own job is small on purpose: work out what each layer IS
 * (its box, its paint routine, its evaluated transform) and hand that to
 * `renderInk`, which owns how it LOOKS under a transition. Nothing here knows
 * about masks, slices or shaders.
 */
import { evaluateLayer, filterString, layerSpansTime } from "@/lib/anim";
import { renderInk, type OverlayDraw } from "@/lib/ink";
import { DEFAULT_SHAPE_STYLE, type FilterLook } from "@/lib/library";
import { isCapturing } from "@/lib/playback";
import { paintShape, shapePath } from "@/lib/shapes";
import { combineFx, rampsAt, transitionRgb, type RampInk } from "@/lib/transitions";
import { uid } from "@/lib/time";
import type { Asset, Layer, LayerGrade, ProjectSettings, TextStyle } from "@/types/editor";

export interface BaseSize {
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ *
 * Text measurement (cached)
 * ------------------------------------------------------------------ */

let scratch: CanvasRenderingContext2D | null = null;
function getScratch(): CanvasRenderingContext2D {
  if (!scratch) {
    const c = document.createElement("canvas");
    c.width = 8;
    c.height = 8;
    scratch = c.getContext("2d")!;
  }
  return scratch;
}

export const DEFAULT_WRAP_RATIO = 0.92;

export function fontString(style: TextStyle): string {
  return `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
}

export interface TextBlock {
  lines: string[];
  width: number;
  height: number;
}

const textCache = new Map<string, TextBlock>();

/** Wraps + measures a text layer. Result is in project pixels at scale 1. */
export function measureText(style: TextStyle, maxWidth: number): TextBlock {
  const key = `${style.content}|${style.fontFamily}|${style.fontSize}|${style.fontWeight}|${style.lineHeight}|${style.letterSpacing}|${Math.round(maxWidth)}`;
  const cached = textCache.get(key);
  if (cached) return cached;

  const ctx = getScratch();
  ctx.font = fontString(style);
  const spacing = style.letterSpacing;
  const widthOf = (s: string) => ctx.measureText(s).width + spacing * Math.max(0, s.length - 1);

  const lines: string[] = [];
  for (const paragraph of style.content.split("\n")) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/(\s+)/);
    let current = "";
    for (const word of words) {
      const candidate = current + word;
      if (widthOf(candidate) > maxWidth && current.trim() !== "") {
        lines.push(current.replace(/\s+$/, ""));
        current = word.replace(/^\s+/, "");
      } else {
        current = candidate;
      }
    }
    lines.push(current.replace(/\s+$/, ""));
  }

  const lineHeight = style.fontSize * style.lineHeight;
  const block: TextBlock = {
    width: Math.max(1, ...lines.map(widthOf)),
    height: Math.max(lineHeight, lines.length * lineHeight),
    lines,
  };
  if (textCache.size > 400) textCache.clear();
  textCache.set(key, block);
  return block;
}

/* ------------------------------------------------------------------ *
 * Natural ("scale 1") size of a layer
 * ------------------------------------------------------------------ */

/** Side of the square box a shape sticker or an emoji sticker occupies. */
export const STICKER_BOX = 180;

export function getBaseSize(layer: Layer, settings: ProjectSettings, assets: Record<string, Asset>): BaseSize {
  switch (layer.type) {
    case "video":
    case "image": {
      const asset = layer.assetId ? assets[layer.assetId] : undefined;
      if (!asset) return { width: settings.width, height: settings.height };
      const el = asset.el as HTMLVideoElement | HTMLImageElement | undefined;
      const w = el && "videoWidth" in el ? el.videoWidth || asset.width : asset.width;
      const h = el && "videoHeight" in el ? el.videoHeight || asset.height : asset.height;
      return { width: w || settings.width, height: h || settings.height };
    }
    case "text": {
      if (!layer.text) return { width: 400, height: 100 };
      const maxWidth = layer.text.boxWidth ?? (settings.width * DEFAULT_WRAP_RATIO);
      const block = measureText(layer.text, maxWidth);
      return { width: maxWidth, height: block.height };
    }
    case "sticker":
      return layer.sticker?.shape
        ? { width: STICKER_BOX, height: STICKER_BOX }
        : { width: STICKER_BOX, height: STICKER_BOX * 1.15 };
    default:
      // Effects and anything else fill the frame box.
      return { width: settings.width, height: settings.height };
  }
}

/* ------------------------------------------------------------------ *
 * Background
 * ------------------------------------------------------------------ */

function paintBackground(ctx: CanvasRenderingContext2D, settings: ProjectSettings) {
  const { width, height } = settings;
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  if (settings.backgroundKind === "gradient" && settings.backgroundGradient) {
    const grad = ctx.createLinearGradient(0, 0, width, height);
    // The stored value is a CSS gradient string; we only need its angle, so a
    // flat two-stop gradient over the project colour is close enough and always
    // valid regardless of the syntax the preset used.
    grad.addColorStop(0, settings.backgroundColor);
    grad.addColorStop(1, settings.backgroundGradient.includes("gradient") ? settings.backgroundColor : settings.backgroundGradient);
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = settings.backgroundColor;
  }
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

export interface DrawArgs {
  ctx: CanvasRenderingContext2D;
  settings: ProjectSettings;
  /** bottom → top */
  layers: Layer[];
  assets: Record<string, Asset>;
  time: number;
  /** draw the project background colour */
  drawBackground?: boolean;
  /** Render entry text animations (typing/slideUp/marquee) as already finished,
   *  so a single still frame shows the text fully rather than blank at t=0. */
  animationComplete?: boolean;
}

export function drawFrame({ ctx, settings, layers, assets, time, drawBackground = true, animationComplete = false }: DrawArgs) {
  if (drawBackground) paintBackground(ctx, settings);

  for (const layer of layers) {
    if (layer.hidden) continue;
    drawLayer(ctx, layer, settings, assets, time, animationComplete);
  }
}

const lastRampWith = <T,>(ramps: RampInk[], pick: (ramp: RampInk) => T | undefined): { ramp: RampInk; value: T } | null => {
  for (let i = ramps.length - 1; i >= 0; i--) {
    const value = pick(ramps[i]);
    if (value !== undefined) return { ramp: ramps[i], value };
  }
  return null;
};

function drawLayer(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  settings: ProjectSettings,
  assets: Record<string, Asset>,
  time: number,
  animationComplete: boolean,
) {
  // Audio has no pixels; its gain envelope is handled by the playback graph.
  if (layer.type === "audio") return;
  if (!layerSpansTime(layer, time)) return;

  const localTime = time - layer.startTime;
  const values = evaluateLayer(layer, time);
  if (values.opacity <= 0.002) return;

  const base = getBaseSize(layer, settings, assets);
  const ramps = rampsAt(layer, localTime);
  const fx = combineFx(ramps);
  const alpha = values.opacity * fx.alpha;
  if (alpha <= 0.004) return;

  const masked = lastRampWith(ramps, (ramp) => ramp.mask);
  const shader = lastRampWith(ramps, (ramp) => ramp.shader);
  const overlays = ramps.map((ramp) => ramp.overlay).filter((o): o is NonNullable<RampInk["overlay"]> => !!o);
  const effectDraws: OverlayDraw[] =
    layer.type === "effect" && layer.effect
      ? [
          {
            style: layer.effect,
            width: base.width,
            height: base.height,
            time: localTime,
            seedKey: layer.id,
          },
        ]
      : [];

  // `renderInk` works in absolute project pixels (its scratch blit and the GLSL
  // pass both assume it), so the context is normalised before every layer.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  renderInk({
    ctx,
    view: { width: settings.width, height: settings.height },
    center: { x: values.x, y: values.y },
    base,
    scale: { x: values.scale * (values.scaleX ?? 1), y: values.scale * (values.scaleY ?? 1) },
    rotation: values.rotation,
    alpha,
    filter: filterString(layer),
    grade: layer.grade,
    fx,
    mask: masked?.value,
    feather: masked?.ramp.feather ?? 0,
    softness: masked?.ramp.softness ?? 0,
    overlays,
    effectDraws,
    shader: shader?.value,
    shaderProgress: shader?.ramp.progress ?? 1,
    shaderColor: shader ? transitionRgb(shader.ramp.color) : [1, 1, 1],
    seedKey: layer.id,
    paint: (target) => paintLayer(target, layer, base, assets, settings.width, localTime, animationComplete),
  });

  ctx.restore();
}

function paintLayer(
  ctx: CanvasRenderingContext2D,
  layer: Layer,
  base: BaseSize,
  assets: Record<string, Asset>,
  projectWidth: number,
  localTime: number,
  animationComplete: boolean,
) {
  switch (layer.type) {
    case "video":
    case "image":
      paintMedia(ctx, layer, assets, base);
      break;
    case "text":
      paintText(ctx, layer, base, projectWidth, localTime, animationComplete);
      break;
    case "sticker":
      paintSticker(ctx, layer, base);
      break;
    default:
      // Effects paint themselves through `effectDraws`.
      break;
  }
}

/** Decoded poster images, keyed by asset — drawn when a video can't be sampled. */
const posterCache = new Map<string, HTMLImageElement>();

function paintPoster(ctx: CanvasRenderingContext2D, asset: Asset, base: BaseSize) {
  if (asset.thumbnail) {
    let img = posterCache.get(asset.id);
    if (!img) {
      img = new Image();
      img.src = asset.thumbnail;
      posterCache.set(asset.id, img);
    }
    if (img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, -base.width / 2, -base.height / 2, base.width, base.height);
      return;
    }
  }
  // No poster yet — a faint box keeps the layer visible rather than a hole.
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.fillRect(-base.width / 2, -base.height / 2, base.width, base.height);
}

function paintMedia(ctx: CanvasRenderingContext2D, layer: Layer, assets: Record<string, Asset>, base: BaseSize) {
  const asset = layer.assetId ? assets[layer.assetId] : undefined;
  if (!asset?.el) return;
  const el = asset.el as HTMLVideoElement | HTMLImageElement;

  // A video that has not decoded its current frame yet (right after a seek —
  // pausing, scrubbing and the export's capture start all seek) cannot be
  // sampled without throwing. During a capture (export/broadcast) a blank hole
  // is worse than a stale frame, so paint the poster; in the live preview a
  // poster is a wrong-time frame that flashes on every seek, so keep the faint
  // placeholder box the initial versions used.
  if (el instanceof HTMLVideoElement && el.readyState < 2) {
    if (isCapturing()) {
      paintPoster(ctx, asset, base);
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fillRect(-base.width / 2, -base.height / 2, base.width, base.height);
    }
    return;
  }

  try {
    ctx.drawImage(el, -base.width / 2, -base.height / 2, base.width, base.height);
  } catch {
    // A tainted image can't be sampled at all; only a video has a poster to
    // fall back on, and an image is left transparent rather than drawn over.
    if (el instanceof HTMLVideoElement) paintPoster(ctx, asset, base);
  }
}

function paintText(ctx: CanvasRenderingContext2D, layer: Layer, base: BaseSize, projectWidth: number, localTime: number, animationComplete: boolean) {
  const style = layer.text;
  if (!style) return;
  // Same wrap width as `getBaseSize` so the lines match the frame that was measured.
  const maxWidth = style.boxWidth ?? (projectWidth * DEFAULT_WRAP_RATIO);
  const block = measureText(style, maxWidth);
  const lineHeight = style.fontSize * style.lineHeight;
  const top = -base.height / 2;

  ctx.save();

  if (style.skew) {
    const shear = Math.tan((style.skew * Math.PI) / 180);
    ctx.transform(1, 0, -shear, 1, shear * base.height * 0.5, 0);
  }

  const padX = style.fontSize * 0.32;
  const padY = style.fontSize * 0.18;

  // Background is stationary
  if (style.backgroundColor && style.backgroundColor !== "transparent") {
    ctx.fillStyle = style.backgroundColor;
    roundRectPath(
      ctx,
      -base.width / 2 - padX,
      top - padY,
      base.width + padX * 2,
      base.height + padY * 2,
      style.backgroundRadius,
    );
    ctx.fill();
  }

  const anchorX = style.align === "center" ? 0 : style.align === "left" ? -base.width / 2 : base.width / 2;

  // Clip the text to the bounding box plus padding so marquee doesn't bleed out
  roundRectPath(
    ctx,
    -base.width / 2 - padX,
    top - padY,
    base.width + padX * 2,
    base.height + padY * 2,
    style.backgroundRadius || 0,
  );
  ctx.clip();

  if (!animationComplete && style.animation === "marquee") {
    const speed = 150; // pixels per second
    const offset = -(localTime * speed) % (block.width + base.width);
    const startX = base.width / 2 - anchorX;
    ctx.translate(offset + startX, 0);
  } else if (!animationComplete && style.animation === "slideUp") {
    // slide up and fade in over first 1 second
    const progress = Math.min(localTime / 1.0, 1.0);
    const easeOutQuart = 1 - Math.pow(1 - progress, 4);
    ctx.translate(0, (1 - easeOutQuart) * 50);
    ctx.globalAlpha *= easeOutQuart;
  }

  ctx.font = fontString(style);
  ctx.textBaseline = "middle";
  ctx.textAlign = style.align;
  const spacingCtx = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if (style.letterSpacing) spacingCtx.letterSpacing = `${style.letterSpacing}px`;

  /** Flat colour, or a vertical gradient across the whole block. */
  const fillFor = (): string | CanvasGradient => {
    if (!style.gradient) return style.color;
    const grad = ctx.createLinearGradient(0, top, 0, top + Math.max(1, block.height));
    grad.addColorStop(0, style.color);
    grad.addColorStop(1, style.gradient >= 1 ? style.gradientColor : blendHex(style.color, style.gradientColor, style.gradient));
    return grad;
  };

  let charsToDraw = Infinity;
  if (!animationComplete && style.animation === "typing") {
    const charsPerSecond = 20;
    charsToDraw = Math.floor(localTime * charsPerSecond);
  }

  let charsDrawn = 0;
  block.lines.forEach((line, i) => {
    if (charsDrawn >= charsToDraw) return;
    
    let drawLine = line;
    if (charsDrawn + line.length > charsToDraw) {
      drawLine = line.slice(0, charsToDraw - charsDrawn);
    }
    charsDrawn += line.length;

    const y = top + lineHeight * (i + 0.5);
    if (style.shadow) {
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.55)";
      ctx.shadowBlur = style.fontSize * 0.18;
      ctx.shadowOffsetY = style.fontSize * 0.05;
      ctx.fillStyle = fillFor();
      ctx.fillText(drawLine, anchorX, y);
      ctx.restore();
    }
    if (style.strokeWidth > 0) {
      ctx.lineJoin = "round";
      ctx.lineWidth = style.strokeWidth;
      ctx.strokeStyle = style.strokeColor;
      ctx.strokeText(drawLine, anchorX, y);
    }
    ctx.fillStyle = fillFor();
    ctx.fillText(drawLine, anchorX, y);
  });

  if (style.letterSpacing) spacingCtx.letterSpacing = "0px";
  ctx.restore();
}

/** Linear interpolation between two hex colours. Falls back to `to`. */
function blendHex(from: string, to: string, t: number): string {
  const parse = (hex: string) => {
    const clean = hex.replace("#", "");
    const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
    const num = Number.parseInt(full.slice(0, 6), 16);
    return Number.isFinite(num) ? [(num >> 16) & 255, (num >> 8) & 255, num & 255] : [255, 255, 255];
  };
  if (!/^#[0-9a-f]{3,6}$/i.test(to)) return to;
  const [r0, g0, b0] = parse(from);
  const [r1, g1, b1] = parse(to);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(r0, r1)},${mix(g0, g1)},${mix(b0, b1)})`;
}

function paintSticker(ctx: CanvasRenderingContext2D, layer: Layer, base: BaseSize) {
  const style = layer.sticker ?? DEFAULT_SHAPE_STYLE;
  const r = Math.min(base.width, base.height) / 2;

  if (style.shape) {
    paintShape(ctx, style.shape, 0, 0, r, style.fill, style.stroke, style.strokeWidth);
    if (style.depth > 0) {
      // A clipped top-lit gradient is what gives a flat shape its thickness.
      ctx.save();
      shapePath(ctx, style.shape, 0, 0, r);
      ctx.clip();
      ctx.globalCompositeOperation = "source-atop";
      const grad = ctx.createLinearGradient(0, -r, 0, r);
      grad.addColorStop(0, `rgba(255,255,255,${(0.44 * style.depth).toFixed(3)})`);
      grad.addColorStop(0.5, "rgba(255,255,255,0)");
      grad.addColorStop(1, `rgba(0,0,0,${(0.52 * style.depth).toFixed(3)})`);
      ctx.fillStyle = grad;
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.restore();
    }
    return;
  }

  const glyph = style.glyph ?? "⭐";
  ctx.font = `${Math.round(base.height * 0.82)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, 0, 0);
}

/* ------------------------------------------------------------------ *
 * Helpers shared with the panels
 * ------------------------------------------------------------------ */

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
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

/** Renders an offscreen JPEG poster for a look, used by the library cards. */
export function lookSwatch(look: FilterLook, grade: LayerGrade): string {
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const parts = Object.entries(look.filters).map(([k, v]) => {
    if (k === "hueRotate") return `hue-rotate(${v}deg)`;
    return `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}(${v})`;
  });
  ctx.filter = parts.length ? parts.join(" ") : "none";
  void grade;
  return canvas.toDataURL();
}

/** Stable id for ad-hoc layers created from the library. */
export const newLayerId = () => uid("layer");
