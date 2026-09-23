/**
 * THE MANIFEST — a declarative, one-shot composition an LLM authors as JSON.
 *
 * The "programmatic tool calling" pattern applied to editing: instead of twelve
 * tool calls whose intermediate results stream back into context, the agent
 * writes one small JSON document and hands it over. This module fetches the
 * media it names, resolves every timespan, and compiles the result into a
 * single `Step[]` that the existing executor runs atomically.
 *
 * TWO RULES KEEP IT FROM MAKING A MESS:
 *
 *   · NOTHING IS ADDRESSED BY ID. Media is referenced by `key`, tracks by name,
 *     looks/shapes/effects by their library id. The LLM never guesses an id.
 *   · TIMESPANS ARE COMPUTED, NEVER AUTHORED BLIND. One `duration` driver sets
 *     the piece length; every layer then anchors to `start`, `end`, or a
 *     nose-to-tail sequence, and the compiler derives the numbers — so a clip
 *     cannot be asked to end past the piece, or an image to "run its full
 *     length".
 *
 * The manifest is the declarative sibling of `run_macro`: a macro replays a
 * *sequence of steps*; a manifest declares a *desired end-state*. Both compile
 * to a `Step[]` and share the executor's guarantees (one undo, real clamping).
 */
import { EFFECT_KINDS, READ, WRITE, applyPlan, argString, type ToolDefinition } from "@/lib/mcp/kit";
import { readLocalFile } from "@/lib/mcp/host";
import { textResult, toolError, type JsonSchema } from "@/lib/mcp/protocol";
import type { LayerPatch, Step } from "@/lib/mcp/steps";
import { assetMetaPatch, createAssetsFromFiles, detectKind } from "@/lib/media";
import { EFFECT_PRESETS, FILTER_LOOK_BY_ID, SHAPE_PRESETS } from "@/lib/library";
import { brandById } from "@/lib/brands";
import { withNormalizedZ } from "@/lib/project";
import { createTrack, withTrackOrder } from "@/lib/tracks";
import { round, uid } from "@/lib/time";
import { DEFAULT_SETTINGS, editor } from "@/store/editorStore";
import { saveProject } from "@/lib/projects";
import type { Asset, AssetId, EffectKind, MediaKind, Project, ShapeId, TextStyle } from "@/types/editor";

/* ------------------------------------------------------------------ *
 * The spec
 * ------------------------------------------------------------------ */

type Kind = MediaKind;
type AtAnchor = "start" | "end" | number;
type Duration = number | "fill" | "media";

interface ManifestMedia {
  key: string;
  url?: string;
  path?: string;
  kind?: Kind;
  name?: string;
}

interface ManifestTrack {
  name: string;
  main?: boolean;
}

interface ManifestSequenceClip {
  media: string;
  duration?: number;
  inPoint?: number;
  fit?: "cover" | "contain";
  opacity?: number;
}

interface ManifestLayer {
  track: string;
  at?: AtAnchor;
  offset?: number;
  duration?: Duration;
  media?: string;
  text?: string;
  style?: "title" | "word" | "lowerThird" | "subLabel";
  shape?: string;
  effect?: string;
  glyph?: string;
  fit?: "cover" | "contain";
  opacity?: number;
  volume?: number;
  loop?: boolean;
  fadeIn?: number;
  fadeOut?: number;
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  color?: string;
  fontSize?: number;
  align?: "left" | "center" | "right";
  name?: string;
}

interface ManifestSpec {
  name?: string;
  canvas?: { width?: number; height?: number; fps?: number };
  background?: { kind?: "color" | "gradient"; color?: string; gradient?: string; angle?: number };
  brand?: string;
  duration?: number | string;
  media?: ManifestMedia[];
  tracks?: ManifestTrack[];
  sequence?: ManifestSequenceClip[];
  layers?: ManifestLayer[];
  look?: { apply: string };
  export?: { resolution?: string; fileName?: string };
}

const RESOLUTION_SIZE: Record<string, [number, number]> = { "4K": [3840, 2160], "1080p": [1920, 1080], "720p": [1280, 720] };
const MIN = 0.08;

/** Thrown for anything wrong with the manifest — one clear message, no partial state. */
class ManifestError extends Error {}

/* ------------------------------------------------------------------ *
 * Media import (off-store until every fetch has succeeded)
 * ------------------------------------------------------------------ */

async function fetchToFile(url: string, name: string | undefined, kind: Kind | undefined): Promise<File> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new ManifestError(`Could not fetch "${url}" — ${err instanceof Error ? err.message : "network error"}.`);
  }
  if (!res.ok) throw new ManifestError(`Download failed (${res.status}) for "${url}".`);
  const blob = await res.blob();
  const ext = kind ? { image: "jpg", video: "mp4", audio: "mp3" }[kind] : url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
  const base = (name || "media").replace(/\.[^.]+$/, "");
  const fileName = /\./.test(base) ? base : `${base}.${ext || "bin"}`;
  return new File([blob], fileName, { type: kind ? `${kind}/${ext}` : blob.type || "application/octet-stream" });
}

async function fileFromPath(filePath: string, name: string | undefined, kind: Kind | undefined): Promise<File> {
  const loaded = await readLocalFile(filePath);
  const ext = kind ? { image: "jpg", video: "mp4", audio: "mp3" }[kind] : filePath.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
  const base = (name || loaded.name || "media").replace(/\.[^.]+$/, "");
  const fileName = /\./.test(base) ? base : `${base}.${ext || "bin"}`;
  const probe = new File([loaded.data], fileName, { type: "" });
  const detected = kind ?? detectKind(probe);
  const mime = detected ? `${detected}/${ext}` : "";
  return new File([loaded.data], fileName, { type: mime });
}

interface ImportedMedia {
  assetId: AssetId;
  kind: Kind;
  name: string;
  duration?: number;
  width?: number;
  height?: number;
}

/** Fetches every media entry first, then registers assets — all-or-nothing. */
async function resolveMedia(
  entries: ManifestMedia[] | undefined,
): Promise<{ assets: Record<AssetId, Asset>; byKey: Map<string, ImportedMedia> }> {
  const assets: Record<AssetId, Asset> = {};
  const byKey = new Map<string, ImportedMedia>();

  if (!entries?.length) return { assets, byKey };

  // 1. Fetch every file BEFORE creating any asset, so one failure aborts cleanly.
  const files: { key: string; file: File; kind?: Kind; name?: string }[] = [];
  for (const entry of entries) {
    const file = entry.path
      ? await fileFromPath(entry.path, entry.name, entry.kind)
      : entry.url
        ? await fetchToFile(entry.url, entry.name, entry.kind)
        : null;
    if (!file) throw new ManifestError(`Media "${entry.key}" needs either a url or a path.`);
    if (!detectKind(file)) throw new ManifestError(`Media "${entry.key}" ("${file.name}") is not a supported type — pass an explicit kind.`);
    files.push({ key: entry.key, file, kind: entry.kind, name: entry.name });
  }

  // 2. Create and register in one batch.
  const created = createAssetsFromFiles(files.map((f) => f.file));
  if (created.length !== files.length) throw new ManifestError("Some media files could not be imported.");

  for (let i = 0; i < files.length; i++) {
    const { key, file, kind, name } = files[i];
    const { asset, meta } = created[i];
    const overriddenName = name ?? asset.name;
    asset.name = overriddenName;
    const patch = assetMetaPatch(await meta);
    const final: Asset = {
      ...asset,
      ...patch,
      duration: patch.duration ?? asset.duration,
      width: patch.width ?? asset.width,
      height: patch.height ?? asset.height,
    };
    assets[final.id] = final;
    byKey.set(key, {
      assetId: final.id,
      kind: final.kind,
      name: overriddenName,
      duration: final.duration,
      width: final.width,
      height: final.height,
    });
  }

  return { assets, byKey };
}

/* ------------------------------------------------------------------ *
 * Duration + timespans
 * ------------------------------------------------------------------ */

const MIN_DUR = 0.08;

function sequenceDuration(media: ImportedMedia, clip: ManifestSequenceClip): number {
  if (clip.duration !== undefined) return Math.max(MIN_DUR, clip.duration);
  if (media.kind === "video" || media.kind === "audio") {
    if (media.duration) return Math.max(MIN_DUR, media.duration - (clip.inPoint ?? 0));
    throw new ManifestError(`Media "${clip.media}" has no known duration — give the sequence clip an explicit duration.`);
  }
  throw new ManifestError(`Sequence clip "${clip.media}" is an image — give it an explicit duration.`);
}

/** The one number everything else hangs off. */
function resolveTotal(spec: ManifestSpec, byKey: Map<string, ImportedMedia>, seqDurations: number[]): number {
  const total = seqDurations.reduce((sum, d) => sum + d, 0);

  if (typeof spec.duration === "number") return Math.max(MIN_DUR, spec.duration);

  if (typeof spec.duration === "string") {
    if (spec.duration === "sequence") return Math.max(MIN_DUR, total);
    if (spec.duration.startsWith("media:")) {
      const key = spec.duration.slice("media:".length);
      const media = byKey.get(key);
      if (!media) throw new ManifestError(`duration driver names an unknown media key "${key}".`);
      if (!media.duration) throw new ManifestError(`duration driver "media:${key}" has no known duration.`);
      return Math.max(MIN_DUR, media.duration);
    }
    throw new ManifestError(`Unknown duration driver "${spec.duration}" — use a number, "sequence", or "media:<key>".`);
  }

  // Omitted: the first timed media (a voiceover, typically) drives the length.
  for (const media of byKey.values()) {
    if (media.kind !== "image" && media.duration) return Math.max(MIN_DUR, media.duration);
  }
  if (seqDurations.length) return Math.max(MIN_DUR, total);
  throw new ManifestError("Nothing sets the piece length — give a duration, a timed media key, or a sequence.");
}

/** Resolves one layer's start + duration against the piece total. */
function resolveTiming(
  layer: ManifestLayer,
  media: ImportedMedia | undefined,
  total: number,
): { start: number; duration: number } {
  const at = layer.at ?? "start";
  const offset = layer.offset ?? 0;
  let duration: number;

  if (layer.duration === undefined) {
    duration = media && media.kind !== "image" && media.duration ? Math.max(MIN_DUR, media.duration) : Math.max(MIN_DUR, total);
  } else if (layer.duration === "fill") {
    if (at === "end") throw new ManifestError(`Layer on "${layer.track}" uses duration "fill" with at "end" — give it a fixed duration.`);
    duration = Math.max(MIN_DUR, total);
  } else if (layer.duration === "media") {
    if (!media || !media.duration) throw new ManifestError(`Layer "${media?.name ?? layer.media ?? layer.text ?? layer.effect ?? ""}" cannot use duration "media" — no timed media behind it.`);
    duration = Math.max(MIN_DUR, media.duration);
  } else {
    duration = Math.max(MIN_DUR, layer.duration);
  }

  let start: number;
  if (typeof at === "number") start = Math.max(0, at + offset);
  else if (at === "end") start = Math.max(0, total - duration - offset);
  else start = Math.max(0, offset);

  return { start, duration: Math.min(duration, Math.max(MIN_DUR, total - start)) };
}

/* ------------------------------------------------------------------ *
 * Text style (minimal, brand-aware, deliberately less than add_text)
 * ------------------------------------------------------------------ */

function textStyleFor(
  layer: ManifestLayer,
  content: string,
  brandId: string | undefined,
  width: number,
  height: number,
): Partial<TextStyle> {
  const brand = brandId ? brandById(brandId) : undefined;
  const unit = Math.min(width, height);
  const role = layer.style ?? "title";
  const isBig = role === "title" || role === "word";
  return {
    content,
    fontFamily: brand?.palette.displayFont ?? "Inter, system-ui, sans-serif",
    fontSize: layer.fontSize ?? Math.round(unit * (isBig ? 0.08 : 0.026)),
    fontWeight: isBig ? 700 : 400,
    color: layer.color ?? brand?.palette.ink ?? "#ffffff",
    align: layer.align ?? "center",
    lineHeight: 1.2,
    letterSpacing: isBig ? Math.round(unit * 0.02) : 0,
    backgroundColor: role === "lowerThird" ? "rgba(10,10,10,0.8)" : "transparent",
    backgroundRadius: 0,
    strokeColor: "#000000",
    strokeWidth: 0,
    shadow: false,
    gradient: 0,
    gradientColor: "#000000",
    skew: 0,
  };
}

/* ------------------------------------------------------------------ *
 * The compiler
 * ------------------------------------------------------------------ */

interface BuiltManifest {
  project: Project;
  assets: Record<AssetId, Asset>;
  steps: Step[];
  total: number;
  rows: { name: string; track: string; start: number; end: number }[];
  warnings: string[];
  notes: string[];
}

async function buildManifest(raw: unknown): Promise<BuiltManifest> {
  const spec = (raw ?? {}) as ManifestSpec;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new ManifestError("The manifest must be a JSON object.");

  // ---- media ----
  const { assets, byKey } = await resolveMedia(spec.media);

  // ---- settings + tracks ----
  const canvas = spec.canvas ?? {};
  const width = canvas.width ?? 1920;
  const height = canvas.height ?? 1080;
  const fps = canvas.fps ?? 30;
  const brand = spec.brand ? brandById(spec.brand) : undefined;
  if (spec.brand && !brand) throw new ManifestError(`No brand called "${spec.brand}" — list_brands shows the ids.`);

  const settings = { ...DEFAULT_SETTINGS, name: spec.name ?? "Manifest project", width, height, fps };
  if (brand) {
    settings.brandId = brand.id;
    settings.backgroundColor = brand.palette.background;
    settings.backgroundKind = "color";
  }
  if (spec.background) {
    if (spec.background.kind) settings.backgroundKind = spec.background.kind;
    if (spec.background.color) settings.backgroundColor = spec.background.color;
    if (spec.background.gradient) settings.backgroundGradient = spec.background.gradient;
    if (spec.background.angle !== undefined) settings.backgroundAngle = spec.background.angle;
  }

  const trackDefs = spec.tracks?.length ? spec.tracks : [{ name: "Main", main: true }];
  const tracks = trackDefs.map((t, i) => createTrack(t.name || `Track ${i + 1}`, t.main === true, false));
  if (!tracks.some((t) => t.main)) tracks[0] = { ...tracks[0], main: true };
  const trackByName = new Map(tracks.map((t) => [t.name, t]));

  const project = withTrackOrder(
    withNormalizedZ({
      id: uid("project"),
      settings,
      layers: {},
      layerIds: [],
      trackIds: tracks.map((t) => t.id),
      tracks: Object.fromEntries(tracks.map((t) => [t.id, t])),
    }),
  );

  const warnings: string[] = [];
  const notes: string[] = [];
  const rows: { name: string; track: string; start: number; end: number }[] = [];

  const trackId = (name: string): string => {
    const track = trackByName.get(name);
    if (!track) throw new ManifestError(`No track called "${name}" — declared tracks: ${tracks.map((t) => t.name).join(", ")}.`);
    return track.id;
  };

  // ---- sequence (nose-to-tail on the main track) ----
  const seqDurations: number[] = [];
  for (const clip of spec.sequence ?? []) {
    const media = byKey.get(clip.media);
    if (!media) throw new ManifestError(`Sequence clip names an unknown media key "${clip.media}".`);
    seqDurations.push(sequenceDuration(media, clip));
  }

  const total = resolveTotal(spec, byKey, seqDurations);

  const steps: Step[] = [];
  const mainTrackId = tracks.find((t) => t.main)?.id ?? tracks[0].id;

  let cursor = 0;
  (spec.sequence ?? []).forEach((clip, i) => {
    const media = byKey.get(clip.media)!;
    const start = cursor;
    const duration = seqDurations[i];
    const idx = steps.length;
    steps.push({
      kind: "addMedia",
      assetId: media.assetId,
      start,
      duration,
      ...(clip.inPoint !== undefined ? { inPoint: clip.inPoint } : {}),
      trackId: mainTrackId,
    });
    if (clip.fit) {
      const mw = media.width ?? width;
      const mh = media.height ?? height;
      const scale = clip.fit === "cover" ? Math.max(width / mw, height / mh) : Math.min(width / mw, height / mh);
      steps.push({ kind: "setTransform", id: `$${idx}`, scale: round(scale, 4) });
    }
    if (clip.opacity !== undefined) steps.push({ kind: "patchLayer", id: `$${idx}`, patch: { opacity: clip.opacity } });
    rows.push({ name: media.name, track: trackNameOf(tracks, mainTrackId), start, end: start + duration });
    cursor = start + duration;
  });

  // ---- layers ----
  for (const layer of spec.layers ?? []) {
    const media = layer.media ? byKey.get(layer.media) : undefined;
    if (layer.media && !media) throw new ManifestError(`Layer names an unknown media key "${layer.media}".`);
    const tid = trackId(layer.track);
    const { start, duration } = resolveTiming(layer, media, total);
    const label = media?.name ?? layer.text ?? layer.effect ?? layer.shape ?? layer.glyph ?? layer.name ?? "layer";

    if (layer.media) {
      const idx = steps.length;
      steps.push({ kind: "addMedia", assetId: media!.assetId, start, duration, trackId: tid });
      if (layer.fit) {
        const mw = media!.width ?? width;
        const mh = media!.height ?? height;
        const scale = layer.fit === "cover" ? Math.max(width / mw, height / mh) : Math.min(width / mw, height / mh);
        steps.push({ kind: "setTransform", id: `$${idx}`, scale: round(scale, 4) });
      }
      const patch: LayerPatch = {};
      if (layer.opacity !== undefined) patch.opacity = layer.opacity;
      if (layer.volume !== undefined) patch.volume = layer.volume;
      if (layer.loop !== undefined) patch.mediaLoop = layer.loop;
      if (layer.fadeIn !== undefined) patch.audioFadeIn = layer.fadeIn;
      if (layer.fadeOut !== undefined) patch.audioFadeOut = layer.fadeOut;
      if (Object.keys(patch).length) steps.push({ kind: "patchLayer", id: `$${idx}`, patch });
      if (layer.x !== undefined || layer.y !== undefined || layer.scale !== undefined || layer.rotation !== undefined) {
        steps.push({
          kind: "setTransform",
          id: `$${idx}`,
          ...(layer.x !== undefined ? { x: layer.x } : {}),
          ...(layer.y !== undefined ? { y: layer.y } : {}),
          ...(layer.scale !== undefined ? { scale: layer.scale } : {}),
          ...(layer.rotation !== undefined ? { rotation: layer.rotation } : {}),
        });
      }
    } else if (layer.text) {
      const text = textStyleFor(layer, layer.text, spec.brand, width, height);
      const x = layer.x ?? width / 2;
      const y = layer.y ?? (layer.style === "lowerThird" || layer.style === "subLabel" ? height * 0.85 : height / 2);
      steps.push({ kind: "addText", content: layer.text, text, start, duration, x, y, ...(layer.name ? { name: layer.name } : {}), trackId: tid });
    } else if (layer.shape) {
      if (!SHAPE_PRESETS.some((s) => s.id === layer.shape)) throw new ManifestError(`No shape called "${layer.shape}" — list_library shows them.`);
      steps.push({ kind: "addShape", shape: layer.shape as ShapeId, start, duration, trackId: tid });
    } else if (layer.glyph) {
      steps.push({ kind: "addSticker", glyph: layer.glyph, start, duration, ...(layer.name ? { name: layer.name } : {}) });
    } else if (layer.effect) {
      const isPreset = EFFECT_PRESETS.some((p) => p.id === layer.effect);
      const isKind = (EFFECT_KINDS as string[]).includes(layer.effect);
      if (!isPreset && !isKind) throw new ManifestError(`No effect called "${layer.effect}" — list_library shows the ids.`);
      steps.push({
        kind: "addEffect",
        ...(isPreset ? { presetId: layer.effect } : { effectKind: layer.effect as EffectKind }),
        start,
        duration,
        ...(layer.name ? { name: layer.name } : {}),
        trackId: tid,
      });
    } else {
      throw new ManifestError(`Layer on "${layer.track}" declares nothing to place — give media, text, shape, glyph or effect.`);
    }
    rows.push({ name: label, track: trackNameOf(tracks, tid), start, end: start + duration });
  }

  // ---- look ----
  if (spec.look?.apply) {
    const look = FILTER_LOOK_BY_ID[spec.look.apply];
    if (!look) throw new ManifestError(`No filter look called "${spec.look.apply}" — list_library shows them.`);
    const pictureIds = steps
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.kind === "addMedia")
      .map(({ i }) => `$${i}`);
    if (pictureIds.length) steps.push({ kind: "applyLook", ids: pictureIds, lookId: spec.look.apply });
  }

  // ---- export ----
  if (spec.export) {
    const [ew, eh] = RESOLUTION_SIZE[spec.export.resolution ?? ""] ?? [width, height];
    steps.push({
      kind: "export",
      options: {
        width: ew,
        height: eh,
        fps,
        rangeStart: 0,
        rangeEnd: round(total, 3),
        includeAudio: true,
        format: "auto",
        fileName: spec.export.fileName ?? `${slug(settings.name)}.mp4`,
      },
    });
  }

  notes.push(
    `${tracks.length} row(s): ${tracks.map((t) => t.name).join(" / ")} — total ${round(total, 2)}s, ${steps.length} step(s) compiled.`,
  );

  return { project, assets, steps, total, rows, warnings, notes };
}

const trackNameOf = (tracks: { id: string; name: string }[], id: string): string =>
  tracks.find((t) => t.id === id)?.name ?? id;

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "export";
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

const MANIFEST_SCHEMA: JsonSchema = {
  type: "object",
  description: "The manifest document itself: name, canvas, media, tracks, sequence, layers, look, export.",
  additionalProperties: true,
};

const manifestFromArgs = async (args: Record<string, unknown>): Promise<unknown> => {
  if (args.manifest !== undefined) return args.manifest;
  const url = argString(args, "url");
  if (url) {
    const res = await fetch(url);
    if (!res.ok) throw new ManifestError(`Could not fetch manifest at "${url}" (${res.status}).`);
    return (await res.json()) as unknown;
  }
  throw new ManifestError("Give either a `manifest` object or a `url` to fetch one from.");
};

export const MANIFEST_TOOLS: ToolDefinition[] = [
  {
    name: "validate_manifest",
    title: "Validate a composition manifest",
    description:
      "Dry-run a declarative JSON manifest and report the timeline it would produce — tracks, every clip with its start/end/duration, and any clamp or gap — WITHOUT touching the editor. Iterate here until the report is clean, then apply_manifest commits it as one atomic edit. Media is named by `key`, tracks by name, and one `duration` driver (a number, \"sequence\", or \"media:<key>\") sets the piece length.",
    inputSchema: {
      type: "object",
      properties: {
        manifest: MANIFEST_SCHEMA,
        url: { type: "string", description: "A URL to fetch the manifest JSON from." },
      },
      additionalProperties: false,
    },
    annotations: READ,
    run: async (args) => {
      try {
        const raw = await manifestFromArgs(args);
        const built = await buildManifest(raw);
        return textResult(
          [
            `Manifest is valid — "${built.project.settings.name}", ${built.project.settings.width}×${built.project.settings.height} @ ${built.project.settings.fps}fps, ${round(built.total, 2)}s total.`,
            `Tracks: ${built.project.trackIds.map((id) => built.project.tracks[id].name).join(" / ")}`,
            `Compiles to ${built.steps.length} step(s):`,
            ...built.rows.map((row) => `  · "${row.name}" on ${row.track}: ${round(row.start, 2)}s → ${round(row.end, 2)}s (${round(row.end - row.start, 2)}s)`),
            ...built.warnings.map((w) => `  ! ${w}`),
            "  apply_manifest with the same manifest (or its url) to load it.",
          ].join("\n"),
          {
            ok: true,
            name: built.project.settings.name,
            canvas: { width: built.project.settings.width, height: built.project.settings.height, fps: built.project.settings.fps },
            total: round(built.total, 3),
            stepCount: built.steps.length,
            tracks: built.project.trackIds.map((id) => built.project.tracks[id].name),
            timeline: built.rows,
          },
        );
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    },
  },
  {
    name: "apply_manifest",
    title: "Apply a composition manifest",
    description:
      "Load a declarative JSON manifest in one go: fetch/import the media it names (by `key`), build the project (canvas, tracks, brand), place the sequence and layers with every timespan resolved against one duration driver, apply the look and optionally queue the export. Replaces the open project (undo history goes with it). Prefer validate_manifest first — this commits.",
    inputSchema: {
      type: "object",
      properties: {
        manifest: MANIFEST_SCHEMA,
        url: { type: "string", description: "A URL to fetch the manifest JSON from." },
      },
      additionalProperties: false,
    },
    annotations: WRITE,
    run: async (args) => {
      const before = editor().project.settings.name;
      try {
        const raw = await manifestFromArgs(args);
        const built = await buildManifest(raw);

        editor().loadProject(built.project, built.assets);
        editor().setCurrentTime(0);

        const result = applyPlan("apply_manifest", built.steps, { notes: built.notes });
        await saveProject({ capturePoster: true });

        return textResult(
          [
            `Applied manifest as "${built.project.settings.name}" — ${round(built.total, 2)}s, ${built.project.layerIds.length} clip(s) on ${built.project.trackIds.length} row(s).`,
            `  · replaced "${before}" — it was autosaved, and undo history went with the old project`,
            ...built.notes.map((n) => `  · ${n}`),
            ...built.warnings.map((w) => `  ! ${w}`),
          ].join("\n"),
          {
            ok: true,
            projectId: editor().project.id,
            name: editor().project.settings.name,
            total: round(built.total, 3),
            replaced: before,
            timeline: built.rows,
          },
        );
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    },
  },
];
