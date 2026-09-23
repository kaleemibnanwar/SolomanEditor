/**
 * BRAND PACKS — the config that turns the editor's primitives into a look.
 *
 * A brand is DATA, not code: a palette, two type families, a rail, a top-left
 * bug, a cue opacity, a voice profile, a music mix, the fixed row layout, a set
 * of cue queries and music moods, a checklist of brand rules, and the export
 * defaults. Every "content" tool reads the ACTIVE brand, so the same tooling
 * drives any pack — "Insight Train" is just the first one shipped.
 *
 * Two things are deliberately fixed, because they are the editor's invariants,
 * not the brand's choices:
 *
 *   · The first layout row is the MAIN LAYER. A project must have exactly one,
 *     so the cue (the back-most visual) lives there and everything else stacks
 *     in front of it.
 *   · The flat backdrop is `settings.backgroundColor`, never a layer — a
 *     full-frame plate on a row would draw OVER the footage instead of under it.
 *
 * `buildTemplateProject` mirrors `lib/templates.ts::buildTemplateProject` but
 * for this layout, so `apply_template` and the auto pipeline share one builder.
 */
import { measureText, DEFAULT_WRAP_RATIO } from "@/lib/compositor";
import {
  createEffectLayer,
  createLayer,
  createShapeLayer,
  createTextLayer,
  orderedLayers,
  withNormalizedZ,
} from "@/lib/project";
import { createTrack, withTrackOrder } from "@/lib/tracks";
import { uid } from "@/lib/time";
import { DEFAULT_SETTINGS } from "@/store/editorStore";
import type {
  Asset,
  AssetId,
  EditorState,
  Layer,
  LayerId,
  Project,
  ShapeId,
  TextStyle,
  Track,
  TrackId,
} from "@/types/editor";

export type BrandId = string;

/* ------------------------------------------------------------------ *
 * The spec
 * ------------------------------------------------------------------ */

export interface BrandPalette {
  /** Flat backdrop colour — the "black void" of the frame. */
  background: string;
  /** The one accent colour — the rail, the bug, the flag. */
  accent: string;
  /** Primary type. */
  ink: string;
  /** Secondary type — sub-labels, source lines. */
  muted: string;
  /** Condensed display family for the massive word. Oswald/Antonio are not
   *  bundled (offline app), so the stack falls back to Impact / Arial Black. */
  displayFont: string;
  /** Body family for the lower third. */
  bodyFont: string;
}

export interface BrandRail {
  color: string;
  /** thickness in project pixels at 1080p, scaled by the frame */
  thicknessPx: number;
}

export interface BrandBug {
  /** Shape id drawn top-left as the mark. */
  shape: ShapeId;
  /** Diameter in project pixels. */
  sizePx: number;
  /** Centre inset from the top-left corner, in project pixels. */
  insetPx: number;
}

export interface BrandVoice {
  /** Named profile the tool surface exposes, e.g. "bbc_news". */
  profile: string;
  /** The Kokoro voice id behind that profile. */
  kokoro: string;
  /** Aspirational settings, reported rather than silently enforced. */
  defaults: { pace?: number; lufs?: number; reverb?: string };
}

export interface CueQuery {
  id: string;
  label: string;
  /** The stock search text that sources this cue. */
  query: string;
}

export interface MusicMood {
  id: string;
  label: string;
  /** Stock search text for the bed. */
  query: string;
  bpm: number;
}

export interface BrandRule {
  id: string;
  label: string;
  /** One line explaining the failure, filled with concrete details. */
  describe: (violation: { detail: string }) => string;
}

/** One slot of the fixed row layout, back → front. */
export interface LayoutRow {
  /** Row name shown on the timeline. */
  name: string;
  /** Semantic role, so the builder knows what to put on it. */
  role: "cue" | "bug" | "word" | "lowerThird" | "rail" | "voice" | "music";
  /** The single row that is the MAIN LAYER (the cue). */
  main?: boolean;
}

export interface TemplateSpec {
  id: string;
  name: string;
  brand: BrandId;
  /** The default massive word, overridable per call. */
  bigWord?: string;
  /** Lower-third line(s). `\n` is an explicit break. */
  lowerThird?: string;
  /** A data figure shown on the lower-third row (finance). */
  dataNumber?: string;
  /** Which cue query to source the backdrop from. */
  cue?: string;
  cueOpacity?: number;
  /** Total length in seconds. */
  seconds: number;
}

export interface ExportDefaults {
  resolution: "4K" | "1080p" | "720p";
  fps: number;
  aspect: "16:9" | "9:16" | "1:1";
  codec: "H264" | "VP9" | "auto";
  audio: "AAC 320kbps" | "Opus" | "auto";
}

export interface BrandPack {
  id: BrandId;
  name: string;
  palette: BrandPalette;
  rail: BrandRail;
  bug: BrandBug;
  cueOpacity: number;
  /** Music sits this many dB under the voice; −24 → gain 10^(−24/20). */
  musicUnderVoiceDb: number;
  voice: BrandVoice;
  /** Fixed row layout, back → front. First row is the main layer (cue). */
  layout: LayoutRow[];
  cueQueries: CueQuery[];
  musicMoods: MusicMood[];
  rules: BrandRule[];
  exportDefaults: ExportDefaults;
  templates: TemplateSpec[];
  /** The centred sign-off word shown in the closing card (defaults to the name). */
  signoff?: string;
  /** The topic line under the sign-off (e.g. the verticals the brand covers). */
  topicLine?: string;
}

/* ------------------------------------------------------------------ *
 * The bundled pack — Insight Train
 * ------------------------------------------------------------------ */

const VOID = "#0A0A0A";
const RED = "#D71921";
const WHITE = "#FFFFFF";
const GREY = "#CCCCCC";

const INSIGHT_LAYOUT: LayoutRow[] = [
  { name: "Topic cue", role: "cue", main: true },
  { name: "Brand bug", role: "bug" },
  { name: "Massive word", role: "word" },
  { name: "Lower third", role: "lowerThird" },
  { name: "Red rail", role: "rail" },
  { name: "Voiceover", role: "voice" },
  { name: "Music bed", role: "music" },
];

export const INSIGHT_TRAIN: BrandPack = {
  id: "insight-train",
  name: "Insight Train",
  palette: {
    background: VOID,
    accent: RED,
    ink: WHITE,
    muted: GREY,
    displayFont: "'Oswald', Impact, 'Arial Black', sans-serif",
    bodyFont: "Inter, system-ui, sans-serif",
  },
  rail: { color: RED, thicknessPx: 8 },
  bug: { shape: "ellipse", sizePx: 72, insetPx: 60 },
  cueOpacity: 0.1,
  musicUnderVoiceDb: -24,
  voice: {
    profile: "bbc_news",
    kokoro: "bm_george",
    defaults: { pace: 0.9, lufs: -18, reverb: "studio newsroom" },
  },
  layout: INSIGHT_LAYOUT,
  cueQueries: [
    { id: "worldMap", label: "World map outline", query: "world map outline white on black" },
    { id: "circuit", label: "Circuit board", query: "circuit board faint lines black background" },
    { id: "candlestick", label: "Candlestick chart", query: "candlestick chart white on black minimal" },
    { id: "smokeTopo", label: "Smoke topo lines", query: "abstract smoke topo lines" },
  ],
  musicMoods: [
    { id: "breaking", label: "Breaking", query: "urgent news music", bpm: 120 },
    { id: "main", label: "Main", query: "news theme music", bpm: 96 },
    { id: "tension", label: "Tension", query: "tense drone music", bpm: 72 },
    { id: "finance", label: "Finance", query: "finance markets music", bpm: 100 },
  ],
  rules: [
    { id: "void", label: "Black void background", describe: () => "the backdrop is not the black void" },
    { id: "noGradient", label: "No blue/red gradient background", describe: () => "the backdrop is a gradient, not flat" },
    { id: "oneWord", label: "At most one word on screen", describe: () => "the massive word is more than one word" },
    { id: "rail", label: "Red rail present", describe: () => "no red rail is on the timeline" },
    { id: "bug", label: "Circle top-left", describe: () => "no top-left brand bug is on the timeline" },
    { id: "hardCut", label: "Music hard cut (no fade)", describe: () => "the music bed fades in or out instead of hard-cutting" },
  ],
  exportDefaults: { resolution: "4K", fps: 24, aspect: "16:9", codec: "H264", audio: "AAC 320kbps" },
  signoff: "THE INSIGHT TRAIN",
  topicLine: "WAR • GEOPOLITICS • TECH • FINANCE",
  templates: [
    {
      id: "insight-train-geopolitics",
      name: "Insight Train — Geopolitics",
      brand: "insight-train",
      bigWord: "IRAN",
      lowerThird: "Strait of Hormuz\nOil routes at risk",
      cue: "worldMap",
      cueOpacity: 0.1,
      seconds: 10,
    },
    {
      id: "insight-train-tech",
      name: "Insight Train — Tech",
      brand: "insight-train",
      bigWord: "CHIPS",
      lowerThird: "Semiconductor supply\nOne foundry, no slack",
      cue: "circuit",
      cueOpacity: 0.1,
      seconds: 10,
    },
    {
      id: "insight-train-finance",
      name: "Insight Train — Finance",
      brand: "insight-train",
      bigWord: "OIL",
      lowerThird: "Brent crude\nA single strait",
      dataNumber: "$500B",
      cue: "candlestick",
      cueOpacity: 0.1,
      seconds: 10,
    },
    {
      id: "insight-train-war",
      name: "Insight Train — War",
      brand: "insight-train",
      bigWord: "WAR",
      lowerThird: "Escalation clock\nThirty days out",
      cue: "smokeTopo",
      cueOpacity: 0.1,
      seconds: 10,
    },
  ],
};

export const BRAND_PACKS: BrandPack[] = [INSIGHT_TRAIN];

/* ------------------------------------------------------------------ *
 * Lookups
 * ------------------------------------------------------------------ */

export function brandById(id: string): BrandPack | undefined {
  return BRAND_PACKS.find((pack) => pack.id === id);
}

export function resolveTemplate(name: string): { template: TemplateSpec; pack: BrandPack } | undefined {
  for (const pack of BRAND_PACKS) {
    const template = pack.templates.find((t) => t.id === name);
    if (template) return { template, pack };
  }
  return undefined;
}

export function templateBrand(template: TemplateSpec): BrandPack {
  return brandById(template.brand) ?? BRAND_PACKS[0];
}

/** The pack a project is styled after, from its settings, else the first pack. */
export function activeBrand(state: EditorState): BrandPack {
  const id = state.project.settings.brandId;
  return (id ? brandById(id) : undefined) ?? BRAND_PACKS[0];
}

export function listBrands() {
  return BRAND_PACKS.map((pack) => ({
    id: pack.id,
    name: pack.name,
    palette: pack.palette,
    voice: pack.voice,
    cueOpacity: pack.cueOpacity,
    musicUnderVoiceDb: pack.musicUnderVoiceDb,
    exportDefaults: pack.exportDefaults,
    layout: pack.layout.map((row) => row.name),
    cueQueries: pack.cueQueries,
    musicMoods: pack.musicMoods,
    rules: pack.rules.map((rule) => ({ id: rule.id, label: rule.label })),
    templates: pack.templates.map((t) => ({ id: t.id, name: t.name, seconds: t.seconds, bigWord: t.bigWord })),
  }));
}

/* ------------------------------------------------------------------ *
 * Placement maths
 * ------------------------------------------------------------------ */

/** The transform that hangs a left-aligned block off the left margin. */
function leftAnchor(style: TextStyle, width: number, y: number, marginX?: number) {
  const margin = marginX ?? width * 0.06;
  const block = measureText(style, width * DEFAULT_WRAP_RATIO);
  return { x: Math.round(margin + block.width / 2), y: Math.round(y), block };
}

/* ------------------------------------------------------------------ *
 * Building
 * ------------------------------------------------------------------ */

export interface BuiltBrandProject {
  project: Project;
  assets: Record<AssetId, Asset>;
  /** Row names, back → front. */
  rows: string[];
  duration: number;
  notes: string[];
}

const ASPECT_SIZE: Record<ExportDefaults["aspect"], { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

export interface BuildBrandOptions {
  /** Override the template's massive word. */
  bigWord?: string;
  /** Override the template's lower-third copy. */
  lowerThird?: string;
  /** Override the template's data figure. */
  dataNumber?: string;
}

/**
 * Builds the fixed brand layout as a real, loadable project. Pure — nothing here
 * reads or writes the store, so a caller can build, inspect, then load.
 *
 * The cue row is left EMPTY by design: sourcing the cue image is network-bound,
 * so it is filled later by `generate_image` (or the auto pipeline). Until then
 * the flat backdrop — the brand's void — is what shows, which is the look.
 */
export function buildBrandProject(
  template: TemplateSpec,
  options: BuildBrandOptions = {},
): BuiltBrandProject {
  const pack = templateBrand(template);
  const notes: string[] = [];
  const { width, height } = ASPECT_SIZE[pack.exportDefaults.aspect];
  const unit = Math.min(width, height);

  const bigWord = (options.bigWord ?? template.bigWord ?? "INSIGHT").toUpperCase();
  const wordCount = bigWord.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount > 1) {
    notes.push(`the massive word "${bigWord}" is ${wordCount} words — the one-word rule wants a single word`);
  }

  const settings = {
    ...DEFAULT_SETTINGS,
    name: template.name,
    width,
    height,
    fps: 24,
    backgroundKind: "color" as const,
    backgroundColor: pack.palette.background,
    brandId: pack.id,
  };

  const duration = template.seconds;

  // Rows, back → front. The first (cue) is the main layer.
  const tracks: Track[] = pack.layout.map((row, index) => createTrack(row.name, !!row.main, false));
  const trackById = new Map(tracks.map((track, index) => [pack.layout[index].role, track.id]));

  const layers: Record<LayerId, Layer> = {};
  const layerIds: LayerId[] = [];
  const place = (layer: Layer, role: LayoutRow["role"]): Layer => {
    const trackId = trackById.get(role) ?? tracks[0].id;
    const placed = { ...layer, trackId };
    layers[placed.id] = placed;
    layerIds.push(placed.id);
    return placed;
  };

  /* --- massive word: ONE WORD, display face, heavy tracking, left-aligned --- */
  const wordStyle: TextStyle = {
    ...(createTextLayer(settings, 0).text as TextStyle),
    content: bigWord,
    fontFamily: pack.palette.displayFont,
    fontSize: Math.round(unit * 0.16),
    fontWeight: 700,
    letterSpacing: Math.round(unit * 0.02),
    lineHeight: 1.05,
    color: pack.palette.ink,
    align: "left",
    backgroundColor: "transparent",
    shadow: false,
    gradient: 0,
    skew: 0,
    strokeWidth: 0,
  };
  const wordAnchor = leftAnchor(wordStyle, width, height * 0.42);
  place(
    createLayer({
      type: "text",
      name: bigWord.slice(0, 24),
      startTime: 0,
      duration,
      text: wordStyle,
      transform: { x: wordAnchor.x, y: wordAnchor.y, scale: 1, rotation: 0 },
    }),
    "word",
  );

  /* --- lower third: box #0A0A0A 80% + body type --- */
  const lowerThird = options.lowerThird ?? template.lowerThird ?? "";
  const data = options.dataNumber ?? template.dataNumber;
  const lowerContent = data ? `${lowerThird}\n${data}` : lowerThird;
  const lowerStyle: TextStyle = {
    ...(createTextLayer(settings, 0).text as TextStyle),
    content: lowerContent,
    fontFamily: pack.palette.bodyFont,
    fontSize: Math.round(unit * 0.026),
    fontWeight: 400,
    letterSpacing: 0,
    lineHeight: 1.3,
    color: pack.palette.ink,
    align: "left",
    backgroundColor: "rgba(10,10,10,0.8)",
    backgroundRadius: Math.round(unit * 0.004),
    shadow: false,
    gradient: 0,
    skew: 0,
    strokeWidth: 0,
  };
  const lowerAnchor = leftAnchor(lowerStyle, width, height * 0.56);
  place(
    createLayer({
      type: "text",
      name: (lowerContent.split("\n")[0] ?? "Lower third").slice(0, 24),
      startTime: 0,
      duration,
      text: lowerStyle,
      transform: { x: lowerAnchor.x, y: lowerAnchor.y, scale: 1, rotation: 0 },
    }),
    "lowerThird",
  );

  /* --- brand bug: the accent shape, top-left, fixed --- */
  const bugScale = pack.bug.sizePx / 180;
  place(
    createLayer({
      ...createShapeLayer(settings, 0, pack.bug.shape),
      name: "Brand bug",
      startTime: 0,
      duration,
      sticker: {
        shape: pack.bug.shape,
        fill: pack.palette.accent,
        stroke: "transparent",
        strokeWidth: 0,
        depth: 0,
      },
      transform: {
        x: pack.bug.insetPx,
        y: pack.bug.insetPx,
        scale: bugScale,
        rotation: 0,
      },
    }),
    "bug",
  );

  /* --- red rail: full-width bottom bar --- */
  place(
    createLayer({
      ...createEffectLayer(settings, 0, {
        kind: "rail",
        color: pack.rail.color,
        color2: pack.rail.color,
        angle: 0,
        blend: "source-over",
        amount: 1,
        scale: pack.rail.thicknessPx / 8,
        seed: 0,
      }),
      name: "Red rail",
      startTime: 0,
      duration,
      transform: { x: width / 2, y: height / 2, scale: 1, rotation: 0 },
    }),
    "rail",
  );

  const tracksById: Record<TrackId, Track> = {};
  for (const track of tracks) tracksById[track.id] = track;

  const project = withTrackOrder(
    withNormalizedZ({
      id: uid("project"),
      settings,
      layers,
      layerIds,
      trackIds: tracks.map((track) => track.id),
      tracks: tracksById,
    }),
  );

  notes.push(
    `${pack.layout.length} rows: ${tracks.map((t) => t.name).join(" / ")} — the cue row is empty until generate_image fills it.`,
  );
  notes.push(`the frame opens on the "${pack.palette.background}" void with a ${pack.palette.accent} rail and bug.`);

  return {
    project,
    assets: {},
    rows: tracks.map((track) => track.name),
    duration,
    notes,
  };
}

/**
 * Builds the brand's rows and backdrop only — no content. This is what
 * `create_timeline` loads: the fixed layout, empty, ready to be filled.
 */
export function buildBrandScaffold(pack: BrandPack): BuiltBrandProject {
  const { width, height } = ASPECT_SIZE[pack.exportDefaults.aspect];
  const tracks: Track[] = pack.layout.map((row) => createTrack(row.name, !!row.main, false));
  const tracksById: Record<TrackId, Track> = {};
  for (const track of tracks) tracksById[track.id] = track;

  const project = withTrackOrder(
    withNormalizedZ({
      id: uid("project"),
      settings: {
        ...DEFAULT_SETTINGS,
        name: pack.name,
        width,
        height,
        fps: pack.exportDefaults.fps,
        backgroundKind: "color" as const,
        backgroundColor: pack.palette.background,
        brandId: pack.id,
      },
      layers: {},
      layerIds: [],
      trackIds: tracks.map((track) => track.id),
      tracks: tracksById,
    }),
  );

  return {
    project,
    assets: {},
    rows: tracks.map((track) => track.name),
    duration: 10,
    notes: [`${tracks.length} rows, back → front: ${tracks.map((t) => t.name).join(" / ")}`],
  };
}

/* ------------------------------------------------------------------ *
 * Brand rules
 * ------------------------------------------------------------------ */

export interface BrandViolation {
  rule: string;
  label: string;
  ok: boolean;
  detail: string;
}

const near = (a: number, b: number, eps = 1e-2) => Math.abs(a - b) < eps;

/** Reads the live project against a pack's checklist, one entry per rule. */
export function brandViolations(state: EditorState, pack: BrandPack): BrandViolation[] {
  const project = state.project;
  const layers = orderedLayers(project);
  const rows = new Map(project.trackIds.map((id) => [project.tracks[id]?.name, id]));
  const onRow = (role: LayoutRow["role"]) => {
    const row = pack.layout.find((r) => r.role === role);
    const trackId = row ? rows.get(row.name) : undefined;
    return trackId ? layers.filter((layer) => layer.trackId === trackId) : [];
  };

  const isVoid =
    project.settings.backgroundKind === "color" &&
    project.settings.backgroundColor.toLowerCase() === pack.palette.background.toLowerCase();

  const wordLayers = onRow("word").filter((layer) => layer.type === "text");
  const oneWord = wordLayers.every((layer) => {
    const words = (layer.text?.content ?? "").trim().split(/\s+/).filter(Boolean);
    return words.length <= 1;
  });

  const railLayers = onRow("rail").filter(
    (layer) => layer.type === "effect" && layer.effect?.kind === "rail",
  );
  const hasRail = railLayers.some(
    (layer) => (layer.effect?.color ?? "").toLowerCase() === pack.rail.color.toLowerCase(),
  );

  const bugLayers = onRow("bug").filter((layer) => layer.type === "sticker");
  const hasBug = bugLayers.length > 0;

  const musicLayers = onRow("music").filter((layer) => layer.type === "audio");
  const hardCut = musicLayers.every(
    (layer) => (layer.audioFadeIn ?? 0) === 0 && (layer.audioFadeOut ?? 0) === 0,
  );

  const cueLayers = onRow("cue").filter((layer) => layer.type === "image" || layer.type === "video");
  const cueOk = cueLayers.length === 0 || cueLayers.every((layer) => near(layer.opacity, pack.cueOpacity, 0.06));

  return [
    { rule: "void", label: "Black void background", ok: isVoid, detail: isVoid ? "backdrop is the void" : `backdrop is ${project.settings.backgroundKind === "color" ? project.settings.backgroundColor : "a gradient"}` },
    { rule: "noGradient", label: "No gradient background", ok: project.settings.backgroundKind !== "gradient", detail: project.settings.backgroundKind === "gradient" ? "backdrop is a gradient" : "backdrop is flat" },
    { rule: "oneWord", label: "At most one word on screen", ok: oneWord, detail: oneWord ? "word row holds a single word" : "word row holds more than one word" },
    { rule: "rail", label: "Red rail present", ok: hasRail, detail: hasRail ? `rail is ${pack.rail.color}` : "no red rail on the rail row" },
    { rule: "bug", label: "Circle top-left", ok: hasBug, detail: hasBug ? "brand bug is top-left" : "no brand bug on the bug row" },
    { rule: "hardCut", label: "Music hard cut", ok: hardCut, detail: hardCut ? "music bed hard-cuts" : "music bed fades in or out" },
    { rule: "cueOpacity", label: "Cue at brand opacity", ok: cueOk, detail: cueOk ? `cue sits at ${pack.cueOpacity}` : "cue opacity does not match the brand" },
  ];
}
