/**
 * Layer data model — the foundation everything else depends on.
 *
 * Every element on the canvas (video, image, text, audio, sticker, effect) is an
 * independent LAYER. Layers have their own time range on the timeline and their
 * own transform in project space. Layers are composited bottom→top by zIndex.
 */

export type LayerId = string;
export type AssetId = string;
export type KeyframeId = string;
export type TrackId = string;

/** The three top-level editor surfaces. `image` is the still-image canvas. */
export type EditorMode = "edit" | "broadcast" | "image";

export type LayerType = "video" | "image" | "text" | "audio" | "sticker" | "effect";
export type MediaKind = "video" | "image" | "audio";

/** Properties that can be animated with keyframes. */
export type AnimatableProp = "opacity" | "x" | "y" | "scale" | "scaleX" | "scaleY" | "rotation" | "volume";

export type Easing = "linear" | "easeIn" | "easeOut" | "easeInOut" | "easeInQuad" | "bounce";

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

/**
 * The transition catalogue. Ids are grouped by the family the library UI shows:
 * Basic · Motion · Wipe · Shape · Light · Glitch · Shader · Blur.
 *
 * "Shader" types run a real GLSL fragment pass (gl-transitions style) over the
 * frame below the layer and the frame including it, so they are true A→B
 * cross-transitions rather than a fade of a single clip.
 */
export type TransitionType =
  // ---- Basic
  | "none"
  | "cut"
  | "fade"
  | "dissolve"
  | "dipToColor"
  // ---- Motion
  | "slide"
  | "push"
  | "whip"
  | "zoomIn"
  | "zoomOut"
  | "spin"
  | "squeeze"
  | "flip"
  | "bounce"
  | "drop"
  // ---- Wipe
  | "wipe"
  | "wipeDiagonal"
  | "softWipe"
  | "blinds"
  | "checker"
  | "barn"
  // ---- Shape
  | "iris"
  | "clock"
  | "star"
  | "heart"
  | "hexagon"
  // ---- Light
  | "flash"
  | "lightLeak"
  | "glowPulse"
  | "filmBurn"
  // ---- Glitch
  | "glitch"
  | "rgbSplit"
  | "pixelate"
  | "scanline"
  | "sliceShift"
  // ---- Shader (WebGL)
  | "swirl"
  | "ripple"
  | "melt"
  | "crossZoom"
  | "luma"
  | "crosswarp"
  | "waterDrop"
  // ---- Blur
  | "blur"
  | "crossBlur"
  | "shake";

export type TransitionDirection = "left" | "right" | "up" | "down";

export interface Transition {
  type: TransitionType;
  duration: number;
  direction: TransitionDirection;
  /** 0..1 feather on masks and wipes. Defaults to 0.35. */
  softness?: number;
  /** colour used by dip-to-colour, bars and burn transitions. */
  color?: string;
  /** 0..1 strength multiplier for the FX transitions. Defaults to 1. */
  intensity?: number;
}

export type BlendMode =
  | "source-over"
  | "multiply"
  | "screen"
  | "overlay"
  | "lighten"
  | "darken"
  | "color-dodge"
  | "color-burn"
  | "soft-light"
  | "hard-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

/* ------------------------------------------------------------------ *
 * Assets
 * ------------------------------------------------------------------ */

/** Where an asset came from — drives the credit chip in the library. */
export interface AssetProvenance {
  /** "import" | "generated" | "wikimedia" | "met" | "pixabay" | "pexels" | ... */
  provider: string;
  label?: string;
  author?: string;
  license?: string;
  pageUrl?: string;
}

/** An imported or generated media file. Lives outside history. */
export interface Asset {
  id: AssetId;
  kind: MediaKind;
  name: string;
  mime: string;
  url: string;
  size: number;
  width?: number;
  height?: number;
  /** natural duration in seconds (video/audio) */
  duration?: number;
  /** data URL poster frame (video) or scaled preview (image) */
  thumbnail?: string;
  /** normalized 0..1 peaks for audio waveform drawing */
  waveform?: number[];
  /** decoded audio for mixing on export */
  audioBuffer?: AudioBuffer;
  /** live DOM element used by the compositor (video/image/audio) */
  el?: HTMLVideoElement | HTMLImageElement | HTMLAudioElement;
  generated?: boolean;
  source?: AssetProvenance;
}

/** Center-anchored transform. x/y are the layer center in project pixels. */
export interface Transform {
  x: number;
  y: number;
  scale: number;
  scaleX?: number;
  scaleY?: number;
  rotation: number;
}

/**
 * Canvas 2D filter values. Neutral defaults: b/c/s = 1, blur = 0, others = 0.
 * These map 1:1 onto the 2D context `filter` property, so the preview and the
 * export share one code path.
 */
export interface LayerFilters {
  brightness: number;
  contrast: number;
  saturate: number;
  blur: number;
  grayscale: number;
  sepia: number;
  hueRotate: number;
  invert: number;
}

/**
 * Colour grade — the part of a look that canvas filters cannot express.
 * Drawn over the layer box by the compositor after the content is painted.
 */
export interface LayerGrade {
  /** -1 cool → 1 warm */
  temperature: number;
  /** -1 green → 1 magenta */
  tint: number;
  /** 0..1 lifted, milky blacks */
  fade: number;
  /** 0..1 corner darkening */
  vignette: number;
  /** 0..1 film grain */
  grain: number;
}

/** Keyframe times are LAYER-LOCAL seconds (0..duration) so trimming never breaks them. */
export interface Keyframe {
  id: KeyframeId;
  prop: AnimatableProp;
  time: number;
  value: number;
  easing: Easing;
}

export interface TextStyle {
  content: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  align: "left" | "center" | "right";
  lineHeight: number;
  letterSpacing: number;
  backgroundColor: string;
  backgroundRadius: number;
  strokeColor: string;
  strokeWidth: number;
  shadow: boolean;
  /** 0 = flat, 1 = heavy; drawn as a vertical gradient across the fill. */
  gradient: number;
  gradientColor: string;
  /** vertical tilt in degrees, for kinetic title presets */
  skew: number;
  /** animation effect for the text */
  animation?: "none" | "typing" | "marquee" | "slideUp";
  /** explicit layout width (in project pixels) before scale */
  boxWidth?: number;
}

/** Vector shapes available to sticker layers (the "Shapes" library). */
export type ShapeId =
  | "roundRect"
  | "ellipse"
  | "triangle"
  | "star"
  | "heart"
  | "arrow"
  | "bubble"
  | "badge"
  | "ring"
  | "diamond"
  | "hexagon"
  | "burst"
  | "cloud"
  | "check"
  | "cross"
  | "chevron"
  | "shield"
  | "blob";

export interface StickerStyle {
  /** emoji / character glyph — used when no shape is set */
  glyph?: string;
  shape?: ShapeId;
  fill: string;
  stroke: string;
  strokeWidth: number;
  /** 0..1 inner shadow / depth */
  depth: number;
}

/**
 * Full-frame (or box-filling) procedural overlays — the "Overlay" and
 * "Effect" libraries. Everything here is drawn from code, so it scales to any
 * resolution and needs no network.
 */
export type EffectKind =
  | "solid"
  | "gradient"
  | "vignette"
  | "glow"
  | "lightLeak"
  | "bokeh"
  | "dust"
  | "flares"
  | "rays"
  | "streaks"
  | "prism"
  | "halftone"
  | "scanlines"
  | "noise"
  | "grid"
  | "grain"
  | "snow"
  | "confetti"
  | "sparkle"
  | "rail";

export interface EffectStyle {
  kind: EffectKind;
  color: string;
  color2: string;
  angle: number;
  blend: BlendMode;
  /** 0..1 — density, count or spread depending on the kind */
  amount: number;
  /** 0..1 — element size for particle-ish kinds */
  scale: number;
  /** 0..1 — animation phase offset so two overlays never look identical */
  seed: number;
}

/**
 * A timeline ROW.
 *
 * Layers are the things that draw; tracks are how they are arranged. Every
 * layer belongs to exactly one track and a track renders as one row, so a
 * sequence of clips can sit side by side instead of each claiming its own row.
 *
 * Exactly one track is the MAIN LAYER: the primary visual sequence — the
 * pictures, video, animations and backdrops the piece is built from. New visual
 * media lands there by default, and consecutive clips on a track that touch
 * form a JUNCTION carrying a joint transition bond (see `lib/bonds.ts`).
 */
export interface Track {
  id: TrackId;
  name: string;
  /** true for the single track that holds the primary visual sequence */
  main: boolean;
  /** true for the track auto-captions/subtitles land on — see `lib/tracks.ts` */
  captions?: boolean;
}

export interface Layer {
  id: LayerId;
  type: LayerType;
  name: string;
  /** the row this clip sits on. Assigned by the store when the layer is added. */
  trackId: TrackId;
  /** media layers only */
  assetId?: AssetId;
  /** position on the project timeline, seconds */
  startTime: number;
  /** visible length on the project timeline, seconds */
  duration: number;
  /** offset into the source media, seconds (trim from the left) */
  inPoint: number;
  transform: Transform;
  opacity: number;
  /** 0..1 */
  volume: number;
  audioFadeIn: number;
  audioFadeOut: number;
  /** stack order — higher draws on top. Kept in sync with project.layerIds order. */
  zIndex: number;
  filters: LayerFilters;
  grade: LayerGrade;
  keyframes: Keyframe[];
  transitionIn: Transition;
  transitionOut: Transition;
  text?: TextStyle;
  sticker?: StickerStyle;
  effect?: EffectStyle;
  locked: boolean;
  hidden: boolean;
  /** loop the source media instead of holding the last frame */
  mediaLoop?: boolean;
  /** playback rate multiplier for video/audio layers */
  rate?: number;
}

export interface ProjectSettings {
  name: string;
  width: number;
  height: number;
  fps: number;
  backgroundColor: string;
  /** optional background fill behind everything */
  backgroundKind: "color" | "gradient";
  backgroundGradient: string;
  backgroundAngle: number;
  /** the brand pack this project is styled after (see `lib/brands.ts`) */
  brandId?: string;
}

export interface Project {
  id: string;
  /** The template this project was started from, when it was started from one. */
  templateId?: string;
  settings: ProjectSettings;
  layers: Record<LayerId, Layer>;
  /** canonical bottom→top order; layer.zIndex mirrors the index */
  layerIds: LayerId[];
  /** canonical bottom→top row order; every layer's trackId names one of these */
  trackIds: TrackId[];
  tracks: Record<TrackId, Track>;
}

/** Left-hand library categories (the KineMaster-style rail). */
export type LibraryTab =
  | "media"
  | "stock"
  | "video"
  | "audio"
  | "overlay"
  | "effect"
  | "transition"
  | "filter"
  | "shape"
  | "sticker"
  | "text"
  | "background";

export type InspectorTab =
  | "transform"
  | "filters"
  | "text"
  | "transition"
  | "audio"
  | "keyframes"
  | "effect"
  | "sticker";

export interface EditorState {
  project: Project;
  assets: Record<AssetId, Asset>;
  assetIds: AssetId[];
  selection: LayerId[];
  currentTime: number;
  isPlaying: boolean;
  loop: boolean;
  /** timeline zoom: pixels per second */
  pixelsPerSecond: number;
  history: { past: Project[]; future: Project[] };
  lastAction: string;
  ui: {
    /** which editor surface is showing — read by the MCP server to pick its catalogue */
    mode: EditorMode;
    libraryTab: LibraryTab;
    libraryQuery: string;
    inspectorTab: InspectorTab;
    snapEnabled: boolean;
    showGrid: boolean;
    showSafeArea: boolean;
    /** silenced output (video elements + the audio master gain) */
    muted: boolean;
    exporting: boolean;
    booting: boolean;
    /** which edge the transition library applies to */
    transitionEdge: "in" | "out";
    /** the stock-media key dialog */
    settingsOpen: boolean;
    /** the saved-project library */
    projectsOpen: boolean;
    /** the script being typed in the Audio tab's voice panel */
    voiceScript: string;
    /** the voice that script will be read in */
    voiceId: string;
  };
  exportJobs: ExportJob[];
  voiceoverJobs: VoiceoverJob[];
  clipboard: Layer[];
}

export interface ExportJob {
  id: string;
  /**
   * The project this render came from. The queue deliberately outlives the
   * project it was made for (the monitor is a log), so this is what lets a
   * project's own record tell whether it has ever been rendered out.
   */
  projectId?: string;
  createdAt: number;
  status: "queued" | "preparing" | "rendering" | "encoding" | "done" | "error" | "canceled";
  progress: number;
  message: string;
  options: ExportOptions;
  resultUrl?: string;
  resultName?: string;
  resultSize?: number;
  mimeType?: string;
  error?: string;
}

export interface VoiceoverSegment {
  text: string;
  start: number;
  end: number;
}

export interface VoiceoverOptions {
  /** Timeline seconds the narration begins at. */
  start: number;
  voice: string;
  fetchBroll: boolean;
  /** A `StockSource` id (see `lib/stock.ts`), or omitted to auto-pick one. */
  brollSource?: string;
}

export interface VoiceoverJob {
  id: string;
  createdAt: number;
  status: "queued" | "synthesizing" | "fetching-broll" | "assembling" | "done" | "error" | "canceled";
  progress: number;
  message: string;
  script: string;
  options: VoiceoverOptions;
  segments?: VoiceoverSegment[];
  error?: string;
}

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  bitrateMbps: number;
  rangeStart: number;
  rangeEnd: number;
  includeAudio: boolean;
  format: "auto" | "mp4" | "webm";
  fileName: string;
}
