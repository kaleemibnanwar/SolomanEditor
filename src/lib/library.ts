/**
 * THE BUNDLED LIBRARY.
 *
 * Every card the left-hand rail can show, described as data. This is the
 * offline half of the asset library: it always works, needs no network, and is
 * what the editor boots with. The live open-source sources in `stock.ts` layer
 * on top of it.
 *
 * A card is never just a picture — a filter card carries the actual filter +
 * grade values it applies, an overlay card carries the EffectStyle it draws.
 * The same data renders the thumbnail, so the preview cannot lie.
 */
import { NEUTRAL_FILTERS, NEUTRAL_GRADE } from "@/lib/anim";
import type {
  BlendMode,
  EffectKind,
  EffectStyle,
  LayerFilters,
  LayerGrade,
  ProjectSettings,
  ShapeId,
  StickerStyle,
  TextStyle,
} from "@/types/editor";

/* ------------------------------------------------------------------ *
 * Filters (canvas filter chain + colour grade)
 * ------------------------------------------------------------------ */

export interface FilterLook {
  id: string;
  name: string;
  hint: string;
  filters: Partial<LayerFilters>;
  grade: Partial<LayerGrade>;
}

export const FILTER_LOOKS: FilterLook[] = [
  { id: "none", name: "Original", hint: "no changes", filters: {}, grade: {} },
  {
    id: "cinematic",
    name: "Cinematic",
    hint: "cool shadows, film contrast",
    filters: { brightness: 0.97, contrast: 1.2, saturate: 0.86, sepia: 0.06 },
    grade: { temperature: -0.14, tint: -0.06, fade: 0.08 },
  },
  {
    id: "warmGold",
    name: "Warm gold",
    hint: "golden hour skin tones",
    filters: { brightness: 1.06, contrast: 1.06, saturate: 1.22, sepia: 0.16 },
    grade: { temperature: 0.34, tint: 0.05 },
  },
  {
    id: "coolBlue",
    name: "Cool blue",
    hint: "overcast and clinical",
    filters: { brightness: 1.03, contrast: 1.1, saturate: 1.04, hueRotate: -12 },
    grade: { temperature: -0.32, tint: -0.05 },
  },
  {
    id: "noir",
    name: "Noir",
    hint: "monochrome, deep blacks",
    filters: { brightness: 1.02, contrast: 1.32, saturate: 0, grayscale: 1 },
    grade: { vignette: 0.42, grain: 0.2 },
  },
  {
    id: "film400",
    name: "Film 400",
    hint: "grainy stock, lifted blacks",
    filters: { brightness: 1.04, contrast: 1.12, saturate: 0.94 },
    grade: { temperature: 0.1, fade: 0.24, grain: 0.42 },
  },
  {
    id: "faded",
    name: "Faded",
    hint: "washed-out nostalgia",
    filters: { brightness: 1.12, contrast: 0.84, saturate: 0.72, sepia: 0.12 },
    grade: { fade: 0.38 },
  },
  {
    id: "dream",
    name: "Dream",
    hint: "soft glow bloom",
    filters: { brightness: 1.09, contrast: 0.93, saturate: 1.16, blur: 1.4 },
    grade: { temperature: 0.14, fade: 0.2, vignette: 0.18 },
  },
  {
    id: "vivid",
    name: "Vivid",
    hint: "punchy and saturated",
    filters: { brightness: 1.04, contrast: 1.2, saturate: 1.45 },
    grade: {},
  },
  {
    id: "tealOrange",
    name: "Teal & orange",
    hint: "the blockbuster grade",
    filters: { contrast: 1.16, saturate: 1.16, hueRotate: -6 },
    grade: { temperature: 0.24, tint: 0.1, vignette: 0.2 },
  },
  {
    id: "pastel",
    name: "Pastel",
    hint: "milk-soft and bright",
    filters: { brightness: 1.16, contrast: 0.9, saturate: 0.88 },
    grade: { temperature: 0.08, tint: 0.08, fade: 0.3 },
  },
  {
    id: "cyberpunk",
    name: "Cyberpunk",
    hint: "neon magenta and cyan",
    filters: { contrast: 1.24, saturate: 1.5, hueRotate: 20 },
    grade: { temperature: -0.2, tint: 0.34, vignette: 0.28, grain: 0.12 },
  },
  {
    id: "sunset",
    name: "Sunset",
    hint: "amber wash",
    filters: { brightness: 1.04, contrast: 1.1, saturate: 1.3, sepia: 0.24 },
    grade: { temperature: 0.46, fade: 0.12 },
  },
  {
    id: "arctic",
    name: "Arctic",
    hint: "cold and bright",
    filters: { brightness: 1.1, contrast: 1.08, saturate: 0.9 },
    grade: { temperature: -0.4, tint: 0.06 },
  },
  {
    id: "matteGreen",
    name: "Matte green",
    hint: "log-style flat grade",
    filters: { brightness: 1.06, contrast: 0.88, saturate: 0.9, hueRotate: -18 },
    grade: { temperature: -0.1, tint: -0.24, fade: 0.34 },
  },
  {
    id: "copper",
    name: "Copper",
    hint: "metallic warm contrast",
    filters: { brightness: 0.98, contrast: 1.26, saturate: 1.1, sepia: 0.3 },
    grade: { temperature: 0.3, vignette: 0.34, grain: 0.14 },
  },
  {
    id: "bleach",
    name: "Bleach bypass",
    hint: "silver, high contrast",
    filters: { brightness: 1.02, contrast: 1.44, saturate: 0.42 },
    grade: { fade: 0.14, grain: 0.26 },
  },
  {
    id: "sepia",
    name: "Sepia",
    hint: "archive tone",
    filters: { brightness: 1.04, contrast: 1.06, saturate: 0.7, sepia: 0.7 },
    grade: { temperature: 0.2, vignette: 0.4, grain: 0.24 },
  },
  {
    id: "infrared",
    name: "Infrared",
    hint: "false-colour foliage",
    filters: { contrast: 1.2, saturate: 1.7, hueRotate: -60 },
    grade: { tint: 0.2, vignette: 0.3 },
  },
  {
    id: "night",
    name: "Night vision",
    hint: "green phosphor",
    filters: { brightness: 1.24, contrast: 1.3, saturate: 0, grayscale: 1 },
    grade: { tint: -0.6, vignette: 0.5, grain: 0.5 },
  },
  {
    id: "invert",
    name: "Negative",
    hint: "inverted film",
    filters: { invert: 1, contrast: 1.1 },
    grade: {},
  },
  {
    id: "studio",
    name: "Studio",
    hint: "clean interview look",
    filters: { brightness: 1.05, contrast: 1.06, saturate: 1.08 },
    grade: { fade: 0.06, vignette: 0.12 },
  },
  {
    id: "lineArt",
    name: "Line art",
    hint: "monochrome white-on-black, for faint topic cues",
    filters: { brightness: 1.02, contrast: 1.5, saturate: 0, grayscale: 1 },
    grade: { fade: 0.08, vignette: 0.18 },
  },
];

export const FILTER_LOOK_BY_ID: Record<string, FilterLook> = Object.fromEntries(
  FILTER_LOOKS.map((look) => [look.id, look]),
);

/** Merges a look over a layer's neutral baseline, returning complete values. */
export function lookValues(look: FilterLook): { filters: LayerFilters; grade: LayerGrade } {
  return {
    filters: { ...NEUTRAL_FILTERS, ...look.filters },
    grade: { ...NEUTRAL_GRADE, ...look.grade },
  };
}

/** Does this layer already match the look exactly? Drives the selected state. */
export function lookMatches(look: FilterLook, filters: LayerFilters, grade: LayerGrade): boolean {
  const wanted = lookValues(look);
  const near = (a: number, b: number) => Math.abs(a - b) < 0.002;
  return (
    (Object.keys(wanted.filters) as (keyof LayerFilters)[]).every((k) => near(filters[k], wanted.filters[k])) &&
    (Object.keys(wanted.grade) as (keyof LayerGrade)[]).every((k) => near(grade[k], wanted.grade[k]))
  );
}

/* ------------------------------------------------------------------ *
 * Effects, overlays and backgrounds
 * ------------------------------------------------------------------ */

export type EffectGroup = "light" | "particles" | "texture" | "plate";

export interface EffectPreset {
  id: string;
  label: string;
  hint: string;
  group: EffectGroup;
  style: EffectStyle;
}

const effect = (
  id: string,
  label: string,
  hint: string,
  group: EffectGroup,
  kind: EffectKind,
  style: Partial<EffectStyle>,
): EffectPreset => ({
  id,
  label,
  hint,
  group,
  style: {
    kind,
    color: "#ffffff",
    color2: "#ffffff",
    angle: 45,
    blend: "screen",
    amount: 0.5,
    scale: 0.5,
    seed: 0.31,
    ...style,
  },
});

export const EFFECT_PRESETS: EffectPreset[] = [
  /* ---- light ---- */
  effect("leakWarm", "Warm leak", "amber streak sweeping across", "light", "lightLeak", {
    color: "rgba(255,176,84,0.85)",
    color2: "rgba(255,98,46,0.7)",
    angle: 20,
    amount: 0.6,
    scale: 0.6,
  }),
  effect("leakCool", "Cool leak", "icy blue flare drift", "light", "lightLeak", {
    color: "rgba(126,196,255,0.8)",
    color2: "rgba(198,132,255,0.6)",
    angle: -35,
    amount: 0.55,
    seed: 0.68,
  }),
  effect("glowSoft", "Soft glow", "gentle breathing bloom", "light", "glow", {
    color: "rgba(255,246,214,0.7)",
    color2: "rgba(255,190,120,0.28)",
    amount: 0.5,
    scale: 0.5,
  }),
  effect("glowNeon", "Neon bloom", "electric blue haze", "light", "glow", {
    color: "rgba(120,220,255,0.75)",
    color2: "rgba(160,80,255,0.3)",
    amount: 0.7,
    scale: 0.7,
    seed: 0.12,
  }),
  effect("flareAnamorphic", "Anamorphic", "blue streaks and ghosts", "light", "flares", {
    color: "rgba(150,200,255,0.9)",
    color2: "rgba(90,140,255,0.55)",
    amount: 0.55,
    scale: 0.5,
  }),
  effect("raysGod", "God rays", "rotating shafts of light", "light", "rays", {
    color: "rgba(255,242,200,0.65)",
    color2: "rgba(255,214,140,0.4)",
    amount: 0.45,
    scale: 0.7,
  }),
  effect("raysHard", "Hard rays", "hard-edged light blades", "light", "rays", {
    color: "rgba(255,255,255,0.55)",
    color2: "rgba(180,220,255,0.3)",
    amount: 0.8,
    scale: 1,
    seed: 0.77,
  }),
  effect("streakHorizon", "Light streaks", "horizontal light smears", "light", "streaks", {
    color: "rgba(255,236,200,0.8)",
    amount: 0.5,
    scale: 0.4,
  }),
  effect("streakSpeed", "Speed lines", "fast horizontal motion", "light", "streaks", {
    color: "rgba(255,255,255,0.75)",
    amount: 0.85,
    scale: 0.2,
    seed: 0.44,
  }),

  /* ---- particles ---- */
  effect("bokehDream", "Dream bokeh", "floating out-of-focus orbs", "particles", "bokeh", {
    color: "rgba(255,246,220,0.85)",
    color2: "rgba(180,220,255,0.8)",
    amount: 0.45,
    scale: 0.5,
  }),
  effect("bokehParty", "Party bokeh", "dense colourful orbs", "particles", "bokeh", {
    color: "rgba(255,140,220,0.8)",
    color2: "rgba(120,255,220,0.8)",
    amount: 0.85,
    scale: 0.4,
    seed: 0.9,
  }),
  effect("dustGolden", "Golden dust", "fine motes in the light", "particles", "dust", {
    color: "rgba(255,232,180,0.9)",
    blend: "screen",
    amount: 0.5,
    scale: 0.4,
  }),
  effect("dustEmbers", "Embers", "rising warm sparks", "particles", "dust", {
    color: "rgba(255,140,60,0.95)",
    color2: "rgba(255,210,120,0.8)",
    amount: 0.6,
    scale: 0.6,
    seed: 0.23,
  }),
  effect("snowSoft", "Snowfall", "gentle white flakes", "particles", "snow", {
    color: "rgba(255,255,255,0.95)",
    amount: 0.5,
    scale: 0.45,
  }),
  effect("snowBlizzard", "Blizzard", "heavy fast snowfall", "particles", "snow", {
    color: "rgba(238,246,255,0.95)",
    amount: 0.95,
    scale: 0.25,
    seed: 0.6,
  }),
  effect("confettiParty", "Confetti", "colourful falling strips", "particles", "confetti", {
    color: "#ffd166",
    color2: "#ef476f",
    blend: "source-over",
    amount: 0.6,
    scale: 0.5,
  }),
  effect("confettiGold", "Gold confetti", "metallic celebration", "particles", "confetti", {
    color: "#ffd76e",
    color2: "#fff3c4",
    blend: "source-over",
    amount: 0.4,
    scale: 0.4,
    seed: 0.15,
  }),
  effect("sparkleTwinkle", "Sparkle", "four-point twinkling stars", "particles", "sparkle", {
    color: "rgba(255,255,255,0.95)",
    color2: "rgba(180,225,255,0.9)",
    amount: 0.5,
    scale: 0.5,
  }),
  effect("sparkleFairies", "Fairy dust", "dense tiny glints", "particles", "sparkle", {
    color: "rgba(255,225,255,0.95)",
    color2: "rgba(200,255,235,0.9)",
    amount: 0.9,
    scale: 0.25,
    seed: 0.52,
  }),

  /* ---- texture ---- */
  effect("grainFilm", "Film grain", "organic 35mm grain", "texture", "grain", {
    color: "rgba(255,255,255,0.5)",
    color2: "rgba(0,0,0,0.5)",
    blend: "overlay",
    amount: 0.35,
    scale: 0.5,
  }),
  effect("grainHeavy", "Heavy grain", "16mm grit", "texture", "grain", {
    color: "rgba(255,255,255,0.6)",
    color2: "rgba(0,0,0,0.65)",
    blend: "overlay",
    amount: 0.75,
    scale: 0.7,
    seed: 0.72,
  }),
  effect("noiseSignal", "Signal noise", "analogue TV static", "texture", "noise", {
    color: "rgba(255,255,255,0.5)",
    color2: "rgba(0,0,0,0.6)",
    blend: "overlay",
    amount: 0.5,
    scale: 0.5,
  }),
  effect("noiseDigital", "Digital artifacting", "blocky compression", "texture", "noise", {
    color: "rgba(120,255,180,0.5)",
    color2: "rgba(0,0,0,0.7)",
    blend: "overlay",
    amount: 0.6,
    scale: 0.2,
    seed: 0.33,
  }),
  effect("scanCRT", "CRT scanlines", "rolling cathode lines", "texture", "scanlines", {
    color: "rgba(0,0,0,0.55)",
    color2: "rgba(255,255,255,0.35)",
    blend: "multiply",
    amount: 0.5,
    scale: 0.5,
  }),
  effect("scanBroadcast", "Broadcast lines", "light interlacing", "texture", "scanlines", {
    color: "rgba(0,0,0,0.35)",
    color2: "rgba(180,255,220,0.4)",
    blend: "overlay",
    amount: 0.35,
    scale: 0.8,
    seed: 0.28,
  }),
  effect("halftonePrint", "Halftone", "newsprint dot grid", "texture", "halftone", {
    color: "rgba(0,0,0,0.75)",
    blend: "multiply",
    amount: 0.5,
    scale: 0.4,
  }),
  effect("halftonePop", "Pop dots", "bold comic dots", "texture", "halftone", {
    color: "rgba(255,90,140,0.85)",
    blend: "multiply",
    amount: 0.7,
    scale: 0.2,
  }),
  effect("prismRainbow", "Prism", "rainbow light refraction", "texture", "prism", {
    color: "rgba(255,255,255,0.4)",
    color2: "rgba(255,255,255,0.25)",
    amount: 0.55,
  }),
  effect("gridTech", "Tech grid", "thin engineering grid", "texture", "grid", {
    color: "rgba(120,255,220,0.6)",
    amount: 0.5,
    scale: 0.5,
  }),
  effect("gridPaper", "Graph paper", "even notebook grid", "texture", "grid", {
    color: "rgba(255,255,255,0.5)",
    amount: 0.3,
    scale: 0.7,
    seed: 0.6,
  }),

  /* ---- plates ---- */
  effect("vignetteSoft", "Soft vignette", "gentle corner falloff", "plate", "vignette", {
    color: "rgba(0,0,0,0.6)",
    blend: "multiply",
    amount: 0.45,
  }),
  effect("vignetteHard", "Heavy vignette", "strong spotlight look", "plate", "vignette", {
    color: "rgba(0,0,0,0.9)",
    blend: "multiply",
    amount: 0.95,
  }),
  effect("washTeal", "Teal wash", "colour wash over the frame", "plate", "gradient", {
    color: "rgba(13,148,136,0.5)",
    color2: "rgba(6,60,90,0.2)",
    blend: "overlay",
    angle: 40,
  }),
  effect("washMagenta", "Magenta wash", "hot colour wash", "plate", "gradient", {
    color: "rgba(219,39,119,0.45)",
    color2: "rgba(76,29,149,0.25)",
    blend: "overlay",
    angle: 130,
  }),
];

export const EFFECT_GROUPS: { id: EffectGroup; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "particles", label: "Particles" },
  { id: "texture", label: "Texture" },
  { id: "plate", label: "Plates" },
];

export const EFFECT_BY_ID: Record<string, EffectPreset> = Object.fromEntries(
  EFFECT_PRESETS.map((preset) => [preset.id, preset]),
);

/* ------------------------------------------------------------------ *
 * Backgrounds
 * ------------------------------------------------------------------ */

export interface BackgroundPreset {
  id: string;
  label: string;
  hint: string;
  /** what the timeline layer draws */
  style: EffectStyle;
  /** fill the frame for this layer */
  cover: boolean;
  /** optionally also set it as the project's flat background */
  project?: Partial<ProjectSettings>;
}

const bg = (
  id: string,
  label: string,
  hint: string,
  style: Partial<EffectStyle> & { kind: EffectStyle["kind"] },
  project?: Partial<ProjectSettings>,
): BackgroundPreset => ({
  id,
  label,
  hint,
  cover: true,
  project,
  style: {
    color: "#ffffff",
    color2: "#000000",
    angle: 45,
    blend: "source-over",
    amount: 0.5,
    scale: 0.5,
    seed: 0.4,
    ...style,
  },
});

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  bg("bgMidnight", "Midnight", "deep blue to black", { kind: "gradient", color: "#1e3a8a", color2: "#020617", angle: 120 }, {
    backgroundKind: "gradient",
    backgroundGradient: "linear-gradient(120deg, #1e3a8a 0%, #020617 100%)",
    backgroundAngle: 120,
    backgroundColor: "#020617",
  }),
  bg("bgSunset", "Sunset", "orange into violet", { kind: "gradient", color: "#fb7185", color2: "#7c3aed", angle: 40 }, {
    backgroundKind: "gradient",
    backgroundGradient: "linear-gradient(40deg, #fb923c 0%, #db2777 50%, #7c3aed 100%)",
    backgroundAngle: 40,
    backgroundColor: "#431407",
  }),
  bg("bgMint", "Mint", "pale green studio", { kind: "gradient", color: "#a7f3d0", color2: "#0f766e", angle: 160 }, {
    backgroundKind: "gradient",
    backgroundGradient: "linear-gradient(160deg, #a7f3d0 0%, #0f766e 100%)",
    backgroundAngle: 160,
    backgroundColor: "#0f766e",
  }),
  bg("bgPaper", "Paper", "warm off-white", { kind: "solid", color: "#f5f1e8", blend: "source-over" }, {
    backgroundKind: "color",
    backgroundColor: "#f5f1e8",
  }),
  bg("bgInk", "Ink", "flat black", { kind: "solid", color: "#05060a", blend: "source-over" }, {
    backgroundKind: "color",
    backgroundColor: "#05060a",
  }),
  bg("bgStudio", "Studio grey", "neutral seamless", {
    kind: "gradient",
    color: "#4b5563",
    color2: "#111827",
    angle: 180,
    blend: "source-over",
  }, { backgroundKind: "color", backgroundColor: "#1f2937" }),
  bg("bgGrid", "Blueprint", "technical grid on navy", {
    kind: "grid",
    color: "rgba(125,211,252,0.5)",
    color2: "#0b1220",
    blend: "source-over",
    amount: 0.55,
    scale: 0.4,
  }),
  bg("bgHalftone", "Dot press", "halftone wash", {
    kind: "halftone",
    color: "rgba(236,72,153,0.55)",
    color2: "#3b0764",
    blend: "source-over",
    amount: 0.6,
    scale: 0.3,
  }),
  bg("bgBokeh", "Bokeh field", "soft out-of-focus lights", {
    kind: "bokeh",
    color: "rgba(196,181,253,0.7)",
    color2: "rgba(94,234,212,0.6)",
    blend: "source-over",
    amount: 0.7,
    scale: 0.6,
  }),
  bg("bgRays", "Sunburst", "radiating light behind a subject", {
    kind: "rays",
    color: "rgba(255,214,140,0.5)",
    color2: "rgba(255,140,60,0.3)",
    blend: "source-over",
    amount: 0.5,
    scale: 0.8,
  }),
  bg("bgPrism", "Spectrum", "prismatic colour field", {
    kind: "prism",
    color: "rgba(255,255,255,0.3)",
    color2: "rgba(255,255,255,0.15)",
    amount: 0.8,
    blend: "source-over",
  }),
  bg("bgNoise", "Static", "analogue noise field", {
    kind: "noise",
    color: "rgba(255,255,255,0.35)",
    color2: "rgba(0,0,0,0.5)",
    amount: 0.7,
    scale: 0.2,
    blend: "source-over",
  }),
];

/* ------------------------------------------------------------------ *
 * Shapes, stickers, text
 * ------------------------------------------------------------------ */

export const SHAPE_PRESETS: { id: ShapeId; label: string }[] = [
  { id: "roundRect", label: "Card" },
  { id: "ellipse", label: "Ellipse" },
  { id: "triangle", label: "Triangle" },
  { id: "star", label: "Star" },
  { id: "heart", label: "Heart" },
  { id: "arrow", label: "Arrow" },
  { id: "bubble", label: "Bubble" },
  { id: "badge", label: "Badge" },
  { id: "ring", label: "Ring" },
  { id: "diamond", label: "Diamond" },
  { id: "hexagon", label: "Hexagon" },
  { id: "burst", label: "Burst" },
  { id: "cloud", label: "Cloud" },
  { id: "check", label: "Check" },
  { id: "cross", label: "Cross" },
  { id: "chevron", label: "Chevron" },
  { id: "shield", label: "Shield" },
  { id: "blob", label: "Blob" },
];

/** Default look for a freshly placed shape — bright, outlined, readable. */
export const DEFAULT_SHAPE_STYLE: StickerStyle = {
  fill: "#f5a524",
  stroke: "#1a1206",
  strokeWidth: 8,
  depth: 0.35,
};

export interface StickerPack {
  id: string;
  label: string;
  glyphs: string[];
}

export const STICKER_PACKS: StickerPack[] = [
  {
    id: "reactions",
    label: "Reactions",
    glyphs: ["😀", "😂", "😍", "😎", "🤯", "😭", "😱", "🥳", "🤔", "😴", "🤩", "🙃", "😇", "🤗", "🫠", "🤫"],
  },
  {
    id: "hype",
    label: "Hype",
    glyphs: ["🔥", "💥", "⚡", "✨", "💫", "🌟", "🚀", "🎉", "🎊", "🏆", "💯", "📈", "🎯", "🪄", "🌈", "☄️"],
  },
  {
    id: "marks",
    label: "Marks",
    glyphs: ["✅", "❌", "❗", "❓", "❗️", "⚠️", "🆕", "🆗", "🆒", "🔴", "🟢", "🔵", "⬆️", "⬇️", "➡️", "⬅️"],
  },
  {
    id: "media",
    label: "Media",
    glyphs: ["🎬", "🎥", "📸", "🎞️", "🎧", "🎵", "🎤", "🔊", "📺", "📹", "🖥️", "🎚️", "🎛️", "📡", "🎹", "🥁"],
  },
  {
    id: "life",
    label: "Everyday",
    glyphs: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🤍", "🖤", "🍕", "☕", "🍿", "🍩", "🌮", "🍺", "🌻", "🌙"],
  },
  {
    id: "hands",
    label: "Hands",
    glyphs: ["👍", "👎", "👏", "🙌", "🙏", "🤝", "✌️", "🤞", "👌", "🤙", "💪", "🫶", "👀", "🧠", "🫡", "✍️"],
  },
];

/* ------------------------------------------------------------------ *
 * Text presets
 * ------------------------------------------------------------------ */

export interface TextPreset {
  id: string;
  label: string;
  hint: string;
  sample: string;
  text: Partial<TextStyle>;
}

export const TEXT_PRESETS: TextPreset[] = [
  {
    id: "title",
    label: "Title",
    hint: "big centred headline",
    sample: "HEADLINE",
    text: { fontSize: 108, fontWeight: 900, letterSpacing: 4, color: "#ffffff", shadow: true, strokeWidth: 0 },
  },
  {
    id: "outline",
    label: "Outline",
    hint: "hollow display type",
    sample: "OUTLINE",
    text: { fontSize: 110, fontWeight: 900, color: "transparent", strokeColor: "#ffffff", strokeWidth: 5 },
  },
  {
    id: "caption",
    label: "Caption",
    hint: "grounded subtitle bar",
    sample: "your caption here",
    text: {
      fontSize: 44,
      fontWeight: 600,
      color: "#ffffff",
      backgroundColor: "rgba(6,10,24,0.62)",
      backgroundRadius: 14,
      shadow: false,
    },
  },
  {
    id: "lowerThird",
    label: "Lower third",
    hint: "name plate, left aligned",
    sample: "Jane Doe\nDirector",
    text: {
      fontSize: 46,
      fontWeight: 700,
      align: "left",
      color: "#ffffff",
      backgroundColor: "rgba(12,74,110,0.78)",
      backgroundRadius: 6,
      letterSpacing: 1,
      shadow: false,
    },
  },
  {
    id: "quote",
    label: "Quote",
    hint: "italic pull quote",
    sample: "“a pull quote”",
    text: { fontSize: 64, fontWeight: 600, fontFamily: "Georgia, 'Times New Roman', serif", lineHeight: 1.35 },
  },
  {
    id: "kinetic",
    label: "Kinetic",
    hint: "slanted poster type",
    sample: "KINETIC",
    text: {
      fontSize: 124,
      fontWeight: 900,
      letterSpacing: -2,
      skew: 10,
      gradient: 0.85,
      gradientColor: "#f97316",
      color: "#fde047",
    },
  },
  {
    id: "neon",
    label: "Neon",
    hint: "glowing sign lettering",
    sample: "NEON",
    text: {
      fontSize: 120,
      fontWeight: 800,
      letterSpacing: 10,
      color: "#a5f3fc",
      strokeColor: "#0891b2",
      strokeWidth: 3,
      shadow: true,
    },
  },
  {
    id: "stamp",
    label: "Stamp",
    hint: "boxed label badge",
    sample: "APPROVED",
    text: {
      fontSize: 56,
      fontWeight: 900,
      letterSpacing: 6,
      color: "#fef3c7",
      backgroundColor: "rgba(190,24,93,0.9)",
      backgroundRadius: 999,
    },
  },
];

export const FONT_OPTIONS: { value: string; label: string }[] = [
  { value: "Inter, system-ui, sans-serif", label: "Inter (default)" },
  { value: "Georgia, 'Times New Roman', serif", label: "Georgia serif" },
  { value: "ui-monospace, 'SF Mono', Menlo, monospace", label: "Monospace" },
  { value: "Impact, 'Arial Black', sans-serif", label: "Impact" },
  { value: "'Trebuchet MS', sans-serif", label: "Trebuchet" },
  { value: "Verdana, sans-serif", label: "Verdana" },
  { value: "'Palatino Linotype', 'Book Antiqua', serif", label: "Palatino" },
  { value: "'Courier New', monospace", label: "Courier" },
];

export const BLEND_OPTIONS: { value: BlendMode; label: string }[] = [
  { value: "source-over", label: "Normal" },
  { value: "multiply", label: "Multiply" },
  { value: "screen", label: "Screen" },
  { value: "overlay", label: "Overlay" },
  { value: "lighten", label: "Lighten" },
  { value: "darken", label: "Darken" },
  { value: "color-dodge", label: "Colour dodge" },
  { value: "color-burn", label: "Colour burn" },
  { value: "soft-light", label: "Soft light" },
  { value: "hard-light", label: "Hard light" },
  { value: "difference", label: "Difference" },
  { value: "exclusion", label: "Exclusion" },
  { value: "hue", label: "Hue" },
  { value: "saturation", label: "Saturation" },
  { value: "color", label: "Colour" },
  { value: "luminosity", label: "Luminosity" },
];
