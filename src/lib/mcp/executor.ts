/**
 * THE EXECUTOR — where an agent's plan becomes real edits.
 *
 * A tool returns `Step[]`; this module runs them against `editorStore` and
 * reports what happened. Two rules keep it honest:
 *
 *   · EVERY MUTATION GOES THROUGH A STORE ACTION. Nothing here reaches into the
 *     project graph directly, so the preview, the seed layer, the snapping and
 *     the history all see the same change a human click would produce. The only
 *     writer of `history` is the coalescing pass at the bottom.
 *   · ONE TOOL CALL IS ONE UNDO. Steps run with `record: false` — the visible
 *     history entry is written once, at the end, from the snapshot taken before
 *     the plan started. A flow that compiles to fourteen steps therefore undoes
 *     in one press rather than fourteen.
 *
 * THE ONE THING AN AGENT CANNOT COMPUTE IS TIME. A step may name a time in
 * project seconds (`at`, `start`), but a keyframe is stored in LAYER-LOCAL
 * seconds, and only the clip knows where it starts. So every time a step is
 * converted, it is converted here, from the live layer — never assumed.
 */
import { layerEnd, projectDuration } from "@/lib/project";
import {
  DEFAULT_SHAPE_STYLE,
  EFFECT_PRESETS,
  FILTER_LOOK_BY_ID,
  BACKGROUND_PRESETS,
  lookValues,
} from "@/lib/library";
import {
  MIN_LAYER_DURATION,
  createEffectLayer,
  createMediaLayer,
  createShapeLayer,
  createStickerLayer,
  createTextLayer,
} from "@/lib/project";
import { applyBond, junctionsOnTrack, maxBondDuration } from "@/lib/bonds";
import { getBaseSize } from "@/lib/compositor";
import { layersOnTrack, mainTrackId, trackHasRoom } from "@/lib/tracks";
import { TRANSITION_BY_ID } from "@/lib/transitions";
import { clamp, round } from "@/lib/time";
import { editor, editorStore } from "@/store/editorStore";
import { planMutatesProject, resolveRefs, type RunReport, type Step, type StepOutcome } from "@/lib/mcp/steps";
import type {
  AnimatableProp,
  Asset,
  BlendMode,
  EffectKind,
  EffectStyle,
  ExportOptions,
  Keyframe,
  Layer,
  LayerId,
  ProjectSettings,
  TextStyle,
} from "@/types/editor";

/** Mirrors `HISTORY_LIMIT` in editorStore — the depth the store itself keeps. */
const HISTORY_LIMIT = 80;

const ANIMATABLE: AnimatableProp[] = ["opacity", "x", "y", "scale", "rotation", "volume"];

/** Canvas sizes `reframe` can move a project to, by aspect. */
const ASPECT_SIZES: Record<string, [number, number]> = {
  "16:9": [1920, 1080],
  "9:16": [1080, 1920],
  "1:1": [1080, 1080],
  "4:5": [1080, 1350],
  "4:3": [1440, 1080],
};

const OPACITY_MIN = 0;
const VOLUME_MAX = 4;
/** Opaque plates cover the frame; everything else is a light-style overlay. */
const OPAQUE_EFFECTS = new Set<EffectKind>(["solid", "gradient", "rail"]);

export interface RunOptions {
  /** The label the whole plan is undone under. */
  label: string;
  /** `false` for steps that manage history themselves (`edit_history`). */
  record?: boolean;
}

/* ------------------------------------------------------------------ *
 * Ran the plan
 * ------------------------------------------------------------------ */

class StepError extends Error {}

interface StepResult {
  outcome: StepOutcome;
  /** Ids the step CREATED — what `RunReport.created` collects. */
  created: string[];
}

export function runPlan(steps: Step[], options: RunOptions): RunReport {
  const projectBefore = editor().project;
  const pastBefore = editor().history.past;

  const entries: (StepOutcome & { step: string })[] = [];
  const warnings: string[] = [];
  const created: string[] = [];
  let error: string | undefined;

  for (let i = 0; i < steps.length; i++) {
    const kind = steps[i].kind;
    let step: Step;
    try {
      step = resolveRefs(steps[i], entries);
    } catch (err) {
      error = `${kind}: ${err instanceof Error ? err.message : String(err)}`;
      entries.push({ ids: [], summary: `failed — ${error}`, step: kind, warnings: [] });
      break;
    }

    try {
      const result = runStep(step);
      entries.push({ ...result.outcome, step: kind });
      created.push(...result.created);
      if (result.outcome.warnings?.length) warnings.push(...result.outcome.warnings);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Everything before this step stands — a plan that dies halfway is a
      // half-done edit, not a reverted one — so the failing step is recorded
      // and the caller is told exactly where the plan stopped.
      error = `${kind}: ${message}`;
      entries.push({ ids: [], summary: `failed — ${message}`, step: kind, warnings: [] });
      break;
    }
  }

  coalesce(options, projectBefore, pastBefore, steps);

  return { ok: !error, steps: entries, warnings, created, error };
}

/**
 * Collapses the whole plan into a single history entry.
 *
 * The store pushes its own snapshots along the way (creation and duplication do
 * this even when asked not to), so the honest move is to *discard* everything
 * recorded during the plan and re-push the one snapshot that matters: the
 * project as it stood before step 0. That also makes the plan's label the one
 * the undo button reads, no matter which step happened to run last.
 */
function coalesce(options: RunOptions, projectBefore: unknown, pastBefore: unknown[], steps: Step[]): void {
  if (options.record === false) return;
  if (!planMutatesProject(steps)) return;
  if (editor().project === projectBefore) return;
  editorStore.setState(() => ({
    history: {
      past: [...(pastBefore as never[]), projectBefore as never].slice(-HISTORY_LIMIT),
      future: [],
    },
    lastAction: options.label,
  }));
}

/* ------------------------------------------------------------------ *
 * Small helpers shared by the steps
 * ------------------------------------------------------------------ */

function requireLayer(id: string): Layer {
  const layer = editor().project.layers[id];
  if (!layer) throw new StepError(`no clip with id "${id}" — call get_timeline for current ids`);
  return layer;
}

function requireAsset(id: string): Asset {
  const asset = editor().assets[id];
  if (!asset) throw new StepError(`no asset with id "${id}" — call list_assets for valid ids`);
  return asset;
}

function requireTrack(id: string): void {
  if (!editor().project.tracks[id]) throw new StepError(`no track with id "${id}" — call get_timeline for rows`);
}

const isTimed = (layer: Layer) => layer.type === "video" || layer.type === "audio";

/** Source length left after the in-point, or Infinity when there is no limit. */
function headroom(asset: Asset | undefined, inPoint: number): number {
  if (!asset?.duration) return Infinity;
  return Math.max(0, asset.duration - inPoint);
}

const secs = (value: number) => `${round(value, 2)}s`;

const nameOf = (id: LayerId) => editor().project.layers[id]?.name ?? "(deleted)";

/** What a timing change did, phrased as a diff. */
function describeChange(before: Layer, after: Layer): string {
  const parts: string[] = [];
  if (Math.abs(after.startTime - before.startTime) > 1e-3) parts.push(`start ${secs(before.startTime)} → ${secs(after.startTime)}`);
  if (Math.abs(after.duration - before.duration) > 1e-3) parts.push(`duration ${secs(before.duration)} → ${secs(after.duration)}`);
  if (Math.abs(after.inPoint - before.inPoint) > 1e-3) parts.push(`sourceIn ${secs(before.inPoint)} → ${secs(after.inPoint)}`);
  return parts.length ? parts.join(", ") : "unchanged";
}

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

function runStep(step: Step): StepResult {
  switch (step.kind) {
    /* ---- new material ---- */
    case "addMedia":
      return addMedia(step);
    case "addText":
      return addText(step);
    case "addShape":
      return addShape(step);
    case "addSticker":
      return addSticker(step);
    case "addEffect":
      return addEffect(step);
    case "addBackground":
      return addBackground(step);
    case "assemble":
      return assemble(step);

    /* ---- what a clip is ---- */
    case "patchLayer":
      return patchLayerStep(step);
    case "setTransform":
      return setTransform(step);
    case "setFilters":
      return setFilters(step);
    case "setGrade":
      return setGrade(step);
    case "applyLook":
      return applyLook(step);

    /* ---- when a clip plays ---- */
    case "setTiming":
      return setTiming(step);
    case "split":
      return split(step);
    case "remove":
      return remove(step);
    case "duplicate":
      return duplicate(step);
    case "reorder":
      return reorder(step);
    case "reorderTrack":
      return reorderTrack(step);
    case "setLock":
      return setLock(step);

    /* ---- joins ---- */
    case "setTransition":
      return setTransitionStep(step);
    case "bond":
      return bond(step);
    case "unbond":
      return unbond(step);

    /* ---- animation ---- */
    case "setKeyframes":
      return setKeyframes(step);
    case "updateKeyframe":
      return updateKeyframeStep(step);
    case "removeKeyframe":
      return removeKeyframeStep(step);

    /* ---- rows ---- */
    case "addTrack":
      return addTrack(step);
    case "renameTrack":
      return renameTrack(step);
    case "removeTrack":
      return removeTrack(step);
    case "setMainTrack":
      return setMainTrack(step);
    case "moveToTrack":
      return moveToTrack(step);

    /* ---- the editor itself ---- */
    case "seek":
      return seek(step);
    case "playback":
      return playback(step);
    case "select":
      return select(step);
    case "settings":
      return settings(step);
    case "export":
      return exportStep(step);
    case "undo":
      editor().undo();
      return { outcome: { ids: [], summary: "undid the last change" }, created: [] };
    case "redo":
      editor().redo();
      return { outcome: { ids: [], summary: "redid the last change" }, created: [] };

    /* ---- compound ---- */
    case "rippleDelete":
      return rippleDelete(step);
    case "threePointEdit":
      return threePointEdit(step);
    case "autoTrimSilence":
      return autoTrimSilence(step);
    case "reframe":
      return reframe(step);

    default: {
      const exhaustive: never = step;
      throw new StepError(`unsupported step ${(exhaustive as Step).kind}`);
    }
  }
}

/* ---------------------------------- creating ---------------------------------- */

/**
 * Put one piece of source on a row. Shared by `addMedia` (one clip) and
 * `assemble` (a list of them, laid nose to tail) — the two differ only in how
 * they decide where the clip starts, so the clamping, the in-point arithmetic
 * and the overlap warning live here once.
 */
function placeMedia(
  assetId: string,
  start: number,
  options: { duration?: number; inPoint?: number; trackId?: string } = {},
): { id: LayerId; name: string; kind: string; start: number; duration: number; warnings: string[] } {
  const asset = requireAsset(assetId);
  const settings = editor().project.settings;
  const warnings: string[] = [];

  if (options.trackId) requireTrack(options.trackId);

  const timed = asset.kind === "video" || asset.kind === "audio";
  let inPoint = 0;
  if (options.inPoint !== undefined && options.inPoint !== 0) {
    if (!timed) {
      warnings.push(`inPoint ignored — ${asset.kind} assets have no source in-point`);
    } else {
      const maxIn = Math.max(0, (asset.duration ?? 0) - MIN_LAYER_DURATION);
      inPoint = clamp(options.inPoint, 0, maxIn);
      if (Math.abs(inPoint - options.inPoint) > 1e-3) {
        warnings.push(`inPoint clamped to ${secs(inPoint)} — the asset is ${secs(asset.duration ?? 0)} long`);
      }
    }
  }

  const at = Math.max(0, start);
  const layer = createMediaLayer(asset, settings, at);
  layer.inPoint = inPoint;

  const room = headroom(timed ? asset : undefined, inPoint);
  const wanted = options.duration ?? layer.duration;
  const duration = Math.max(MIN_LAYER_DURATION, Math.min(wanted, room));
  if (duration < wanted - 1e-3) {
    warnings.push(
      `duration clamped to ${secs(duration)} — only that much source remains after inPoint ${secs(inPoint)}`,
    );
  }
  layer.duration = duration;

  if (options.trackId) layer.trackId = options.trackId;

  const id = editor().addLayer(layer);
  const placed = editor().project.layers[id];

  // An explicitly requested row is taken as given, so an overlap on it is worth
  // saying out loud: two clips on one row that overlap are a stack, not a cut.
  if (options.trackId) {
    const others = layersOnTrack(editor().project, options.trackId).filter((l) => l.id !== id);
    const overlapping = others.filter((l) => l.startTime < layerEnd(layer) - 1e-6 && layerEnd(l) > at + 1e-6);
    if (overlapping.length) {
      warnings.push(
        `overlaps ${overlapping.map((l) => `"${l.name}"`).join(", ")} on that row — they will stack, not cut`,
      );
    }
  }

  return {
    id,
    name: asset.name,
    kind: placed?.type ?? asset.kind,
    start: placed?.startTime ?? at,
    duration: placed?.duration ?? duration,
    warnings,
  };
}

function addMedia(step: Extract<Step, { kind: "addMedia" }>): StepResult {
  const placed = placeMedia(step.assetId, step.start, {
    duration: step.duration,
    inPoint: step.inPoint,
    trackId: step.trackId,
  });
  return {
    outcome: {
      ids: [placed.id],
      summary: `added ${placed.kind} "${placed.name}" at ${secs(placed.start)} (${secs(placed.duration)})`,
      warnings: placed.warnings,
    },
    created: [placed.id],
  };
}

/**
 * A list of shots laid nose to tail — the step behind a rough cut.
 *
 * The cursor advances by each clip's ACTUAL length rather than the requested
 * one, so when a shot's source runs short the next shot butts up against it
 * instead of leaving a hole. That is the whole reason this is a step and not
 * something the agent has to compute: it cannot know a clip's real length
 * without asking the editor first.
 */
function assemble(step: Extract<Step, { kind: "assemble" }>): StepResult {
  if (!step.clips.length) throw new StepError("no clips to assemble");

  const project = editor().project;
  const trackId = step.trackId ?? mainTrackId(project);
  if (!trackId) throw new StepError("the project has no rows to assemble into");
  requireTrack(trackId);

  const start = Math.max(0, step.start);
  let cursor = start;
  const ids: LayerId[] = [];
  const warnings: string[] = [];

  step.clips.forEach((clip, index) => {
    const placed = placeMedia(clip.assetId, cursor, {
      duration: clip.duration,
      inPoint: clip.inPoint,
      trackId,
    });
    ids.push(placed.id);
    cursor = layerEnd(editor().project.layers[placed.id]);
    for (const warning of placed.warnings) warnings.push(`shot ${index + 1} (${placed.name}): ${warning}`);
  });

  const track = editor().project.tracks[trackId];
  return {
    outcome: {
      ids,
      summary: `assembled ${ids.length} shot${ids.length === 1 ? "" : "s"} on "${track?.name ?? trackId}" from ${secs(
        start,
      )} to ${secs(cursor)} (${secs(cursor - start)})`,
      warnings,
    },
    created: ids,
  };
}

function addText(step: Extract<Step, { kind: "addText" }>): StepResult {
  const settings = editor().project.settings;
  const start = Math.max(0, step.start ?? editor().currentTime);
  const content = step.text?.content ?? step.content;

  const layer = createTextLayer(settings, start, content);
  if (step.text) layer.text = { ...(layer.text as TextStyle), ...step.text };
  if (!layer.text?.content) layer.text = { ...(layer.text as TextStyle), content: step.content };
  layer.duration = Math.max(MIN_LAYER_DURATION, step.duration ?? layer.duration);
  if (step.name) layer.name = step.name;
  if (step.x !== undefined) layer.transform.x = step.x;
  if (step.y !== undefined) layer.transform.y = step.y;
  if (step.scale !== undefined) layer.transform.scale = step.scale;
  // A trackId the project already recognises is honoured as-is (placeLayer,
  // called by addLayer, keeps a layer on an existing track rather than
  // spinning up a new one) — this is how a run of captions lands on one shared
  // row instead of each getting its own.
  if (step.trackId && editor().project.tracks[step.trackId]) layer.trackId = step.trackId;

  const id = editor().addLayer(layer);
  return {
    outcome: {
      ids: [id],
      summary: `added text "${layer.text?.content}" at ${secs(start)} (${secs(layer.duration)})`,
    },
    created: [id],
  };
}

function addShape(step: Extract<Step, { kind: "addShape" }>): StepResult {
  const settings = editor().project.settings;
  const start = Math.max(0, step.start ?? editor().currentTime);
  const layer = createShapeLayer(settings, start, step.shape);
  if (step.style) layer.sticker = { ...(layer.sticker ?? DEFAULT_SHAPE_STYLE), ...step.style };
  layer.duration = Math.max(MIN_LAYER_DURATION, step.duration ?? layer.duration);
  if (step.trackId && editor().project.tracks[step.trackId]) layer.trackId = step.trackId;

  const id = editor().addLayer(layer);
  return {
    outcome: { ids: [id], summary: `added ${step.shape} shape at ${secs(start)}` },
    created: [id],
  };
}

function addSticker(step: Extract<Step, { kind: "addSticker" }>): StepResult {
  const settings = editor().project.settings;
  const start = Math.max(0, step.start ?? editor().currentTime);
  // The glyph takes the place of the shape: `shape: undefined` is what makes the
  // renderer draw the character instead of a vector.
  const style = { ...DEFAULT_SHAPE_STYLE, glyph: step.glyph, shape: undefined };
  const layer = createStickerLayer(settings, start, style, step.name ?? step.glyph);
  layer.duration = Math.max(MIN_LAYER_DURATION, step.duration ?? layer.duration);

  const id = editor().addLayer(layer);
  return {
    outcome: { ids: [id], summary: `added sticker "${step.glyph}" at ${secs(start)}` },
    created: [id],
  };
}

function addEffect(step: Extract<Step, { kind: "addEffect" }>): StepResult {
  const preset = step.presetId ? EFFECT_PRESETS.find((p) => p.id === step.presetId) : undefined;
  if (step.presetId && !preset) {
    throw new StepError(`no effect preset "${step.presetId}" — call list_library for the ids`);
  }
  const kind = step.effectKind ?? preset?.style.kind;
  if (!kind) throw new StepError("needs either a presetId or an effect kind — call list_library for the ids");

  const blend: BlendMode = OPAQUE_EFFECTS.has(kind) ? "source-over" : "screen";
  const style: EffectStyle = {
    color: "#ffffff",
    color2: "#000000",
    angle: 45,
    blend,
    amount: 0.5,
    scale: 0.5,
    seed: 0.31,
    ...(preset?.style ?? {}),
    kind,
    ...(step.style ?? {}),
  };

  const settings = editor().project.settings;
  const start = Math.max(0, step.start ?? editor().currentTime);
  const layer = createEffectLayer(settings, start, style, step.name ?? preset?.label);
  layer.duration = Math.max(MIN_LAYER_DURATION, step.duration ?? layer.duration);
  if (step.trackId && editor().project.tracks[step.trackId]) layer.trackId = step.trackId;

  const id = editor().addLayer(layer);
  return {
    outcome: {
      ids: [id],
      summary: `added ${kind} effect${preset ? ` (${preset.label})` : ""} at ${secs(start)}`,
    },
    created: [id],
  };
}

function addBackground(step: Extract<Step, { kind: "addBackground" }>): StepResult {
  const preset = BACKGROUND_PRESETS.find((p) => p.id === step.presetId);
  if (!preset) throw new StepError(`no background preset "${step.presetId}" — call list_library for the ids`);

  // `addBackgroundLayer` also applies `preset.project`, so the flat backdrop
  // behind the timeline matches the card the agent picked.
  const id = editor().addBackgroundLayer(preset);
  if (step.start !== undefined) editor().setLayerStart(id, Math.max(0, step.start), false);
  if (step.duration !== undefined) {
    const layer = editor().project.layers[id];
    editor().trimEnd(id, layer.startTime + Math.max(MIN_LAYER_DURATION, step.duration), false);
  }

  return {
    outcome: { ids: [id], summary: `added "${preset.label}" background` },
    created: [id],
  };
}

/* ---------------------------------- mutating ---------------------------------- */

function patchLayerStep(step: Extract<Step, { kind: "patchLayer" }>): StepResult {
  const layer = requireLayer(step.id);
  const patch = step.patch;
  const applied: Partial<Layer> = {};
  const warnings: string[] = [];
  const changed: string[] = [];

  const scalar = (key: "name" | "locked" | "hidden" | "mediaLoop" | "rate" | "audioFadeIn" | "audioFadeOut") => {
    const value = patch[key];
    if (value === undefined) return;
    (applied as Record<string, unknown>)[key] = value;
    changed.push(key);
  };
  scalar("name");
  scalar("locked");
  scalar("hidden");
  scalar("mediaLoop");
  scalar("rate");
  scalar("audioFadeIn");
  scalar("audioFadeOut");

  if (patch.opacity !== undefined) {
    const opacity = clamp(patch.opacity, OPACITY_MIN, 1);
    if (Math.abs(opacity - patch.opacity) > 1e-3) warnings.push(`opacity clamped to ${round(opacity, 3)} (range 0–1)`);
    applied.opacity = opacity;
    changed.push("opacity");
  }
  if (patch.volume !== undefined) {
    const volume = clamp(patch.volume, 0, VOLUME_MAX);
    if (Math.abs(volume - patch.volume) > 1e-3) warnings.push(`volume clamped to ${round(volume, 3)} (range 0–${VOLUME_MAX})`);
    applied.volume = volume;
    changed.push("volume");
  }

  // The three type-specific blocks are merged, never replaced — that is what
  // lets a caller say `{ text: { fontSize: 90 } }` and keep everything else.
  const block = <K extends "text" | "sticker" | "effect">(key: K) => {
    const value = patch[key];
    if (!value) return;
    if (layer.type !== key) {
      warnings.push(`${key} style ignored — "${layer.name}" is a ${layer.type} clip`);
      return;
    }
    (applied as Record<string, unknown>)[key] = { ...(layer[key] as object), ...value };
    changed.push(key);
  };
  block("text");
  block("sticker");
  block("effect");

  if (!changed.length) {
    return { outcome: { ids: [step.id], summary: `nothing to change on "${layer.name}"`, warnings }, created: [] };
  }

  editor().updateLayer(step.id, applied, false);
  return {
    outcome: { ids: [step.id], summary: `set ${changed.join(", ")} on "${layer.name}"`, warnings },
    created: [],
  };
}

function setTransform(step: Extract<Step, { kind: "setTransform" }>): StepResult {
  const layer = requireLayer(step.id);
  const patch = {
    ...(step.x !== undefined ? { x: step.x } : {}),
    ...(step.y !== undefined ? { y: step.y } : {}),
    ...(step.scale !== undefined ? { scale: step.scale } : {}),
    ...(step.rotation !== undefined ? { rotation: step.rotation } : {}),
  };
  if (!Object.keys(patch).length) throw new StepError("needs at least one of x, y, scale or rotation");

  const warnings: string[] = [];
  if (step.scale !== undefined && step.scale <= 0) warnings.push("scale must be greater than 0");
  editor().updateLayerTransform(step.id, patch, false);

  const after = requireLayer(step.id);
  const parts = Object.entries(patch).map(([k, v]) => `${k}=${round(v as number, 3)}`);
  return {
    outcome: {
      ids: [step.id],
      summary: `"${layer.name}" ${parts.join(", ")} → now at ${round(after.transform.x, 1)},${round(after.transform.y, 1)}`,
      warnings,
    },
    created: [],
  };
}

function setFilters(step: Extract<Step, { kind: "setFilters" }>): StepResult {
  if (!step.ids.length) throw new StepError("no clips to filter");
  const warnings: string[] = [];
  for (const id of step.ids) {
    const layer = requireLayer(id);
    if (layer.type === "audio") {
      warnings.push(`"${layer.name}" is an audio clip — filters only affect picture`);
      continue;
    }
    // `resetFilters` is the store's own recipe and already skips a no-op, so a
    // reset lands as a single "Reset filters" edit rather than a hand-rolled one.
    if (step.reset) editor().resetFilters(id);
    else editor().updateLayerFilters(id, step.filters, false);
  }
  return {
    outcome: {
      ids: step.ids,
      summary: step.reset
        ? `reset the look on ${step.ids.length} clip${step.ids.length === 1 ? "" : "s"}`
        : `applied ${Object.keys(step.filters).join(", ")} to ${step.ids.length} clip${step.ids.length === 1 ? "" : "s"}`,
      warnings,
    },
    created: [],
  };
}

function setGrade(step: Extract<Step, { kind: "setGrade" }>): StepResult {
  if (!step.ids.length) throw new StepError("no clips to grade");
  // There is no per-id grade action in the store, so this is the same merge the
  // Inspector performs: one `updateLayer` carrying the whole grade object.
  for (const id of step.ids) {
    const layer = requireLayer(id);
    editor().updateLayer(id, { grade: { ...layer.grade, ...step.grade } }, false);
  }
  return {
    outcome: {
      ids: step.ids,
      summary: `graded ${step.ids.length} clip${step.ids.length === 1 ? "" : "s"} (${Object.keys(step.grade).join(", ")})`,
    },
    created: [],
  };
}

function applyLook(step: Extract<Step, { kind: "applyLook" }>): StepResult {
  const look = FILTER_LOOK_BY_ID[step.lookId];
  if (!look) throw new StepError(`no filter look "${step.lookId}" — call list_library for the ids`);
  if (!step.ids.length) throw new StepError("no clips to apply the look to");

  const values = lookValues(look);
  for (const id of step.ids) {
    requireLayer(id);
    editor().updateLayer(id, { filters: { ...values.filters }, grade: { ...values.grade } }, false);
  }
  return {
    outcome: {
      ids: step.ids,
      summary: `applied "${look.name}" to ${step.ids.length} clip${step.ids.length === 1 ? "" : "s"}`,
    },
    created: [],
  };
}

function setTiming(step: Extract<Step, { kind: "setTiming" }>): StepResult {
  const before = requireLayer(step.id);
  const warnings: string[] = [];
  if (step.start === undefined && step.duration === undefined && step.inPoint === undefined) {
    throw new StepError("needs at least one of start, duration or inPoint");
  }

  // In-point first: moving the head of a media clip moves its start as a side
  // effect, so an explicit `start` afterwards must be the one that wins.
  if (step.inPoint !== undefined) {
    if (!isTimed(before)) {
      warnings.push("inPoint only applies to video and audio — ignored");
    } else {
      const delta = step.inPoint - before.inPoint;
      if (Math.abs(delta) > 1e-6) editor().trimStart(step.id, before.startTime + delta, false);
      const now = requireLayer(step.id);
      if (Math.abs(now.inPoint - step.inPoint) > 1e-3) {
        warnings.push(`sourceIn is ${secs(now.inPoint)}, not ${secs(step.inPoint)} — the source ran out`);
      }
    }
  }

  if (step.start !== undefined) {
    editor().setLayerStart(step.id, Math.max(0, step.start), false);
    if (step.start < 0) warnings.push("start clamped to 0");
  }

  if (step.duration !== undefined) {
    const now = requireLayer(step.id);
    editor().trimEnd(step.id, now.startTime + Math.max(MIN_LAYER_DURATION, step.duration), false);
    const after = requireLayer(step.id);
    if (Math.abs(after.duration - step.duration) > 1e-3) {
      warnings.push(
        `duration is ${secs(after.duration)}, not ${secs(step.duration)} — the source has no more room from sourceIn ${secs(after.inPoint)}`,
      );
    }
  }

  const after = requireLayer(step.id);
  return {
    outcome: {
      ids: [step.id],
      summary: `"${before.name}": ${describeChange(before, after)}`,
      warnings,
    },
    created: [],
  };
}

function split(step: Extract<Step, { kind: "split" }>): StepResult {
  const at = Math.max(0, step.at);
  const before = new Set(Object.keys(editor().project.layers));

  if (step.ids?.length) {
    const unknown = step.ids.filter((id) => !editor().project.layers[id]);
    if (unknown.length) throw new StepError(`no clip with id "${unknown[0]}"`);
    editor().select(step.ids);
  } else {
    editor().clearSelection();
  }

  editor().setCurrentTime(at);
  const count = editor().splitAtPlayhead();
  const created = Object.keys(editor().project.layers).filter((id) => !before.has(id));

  const warnings: string[] = [];
  if (!count) {
    warnings.push(
      `nothing was cut at ${secs(at)} — a clip has to span that point with more than 0.06s on each side${
        step.ids?.length ? "" : " (no selection: every clip was considered)"
      }`,
    );
  }

  return {
    outcome: {
      ids: created,
      summary: count ? `cut ${count} clip${count === 1 ? "" : "s"} at ${secs(at)}` : `no cut at ${secs(at)}`,
      warnings,
    },
    created,
  };
}

function remove(step: Extract<Step, { kind: "remove" }>): StepResult {
  if (!step.ids.length) throw new StepError("no clips named for deletion");
  const present = step.ids.filter((id) => editor().project.layers[id]);
  const missing = step.ids.filter((id) => !editor().project.layers[id]);
  if (!present.length) throw new StepError(`no clip with id "${step.ids[0]}"`);

  const names = present.map(nameOf);
  editor().removeLayers(present);

  return {
    outcome: {
      // A deleted clip must NOT leak into `$all` or a later step would address
      // an id that no longer exists.
      ids: [],
      summary: `deleted ${present.length} clip${present.length === 1 ? "" : "s"}: ${names.join(", ")}`,
      warnings: missing.length ? [`ignored unknown id(s): ${missing.join(", ")}`] : undefined,
    },
    created: [],
  };
}

function duplicate(step: Extract<Step, { kind: "duplicate" }>): StepResult {
  if (!step.ids.length) throw new StepError("no clips named for duplication");
  const unknown = step.ids.filter((id) => !editor().project.layers[id]);
  if (unknown.length) throw new StepError(`no clip with id "${unknown[0]}"`);

  const before = new Set(Object.keys(editor().project.layers));
  editor().duplicateLayers(step.ids);
  // `duplicateLayers` leaves the copies selected, which is the same way a human
  // duplicate ends up — so the selection is the authoritative list of new ids.
  const created = editor().selection.filter((id) => !before.has(id));

  return {
    outcome: {
      ids: created,
      summary: `duplicated ${created.length} clip${created.length === 1 ? "" : "s"} — the copies sit directly after the originals`,
    },
    created,
  };
}

function reorder(step: Extract<Step, { kind: "reorder" }>): StepResult {
  const layer = requireLayer(step.id);
  const warnings: string[] = [];
  if (layer.type === "audio") warnings.push("audio clips have no visual stacking to change");
  // Z-order only moves a clip within its own row: rows own the vertical layout.
  editor().nudgeLayerZ(step.id, step.direction);
  const after = requireLayer(step.id);
  if (after.zIndex === layer.zIndex) {
    warnings.push(`"${layer.name}" is already at the ${step.direction === "top" || step.direction === "up" ? "top" : "bottom"} of its row`);
  }
  return {
    outcome: {
      ids: [step.id],
      summary: `moved "${layer.name}" ${step.direction} (z ${layer.zIndex} → ${after.zIndex})`,
      warnings,
    },
    created: [],
  };
}

/**
 * Reorders a whole row in the drawing stack — the "reorder a layer" action,
 * where `reorder` above shuffles clips *within* a row. The main layer is always
 * the back, so it is refused here rather than silently no-op'd.
 */
function reorderTrack(step: Extract<Step, { kind: "reorderTrack" }>): StepResult {
  const track = editor().project.tracks[step.id];
  if (!track) throw new StepError(`no track with id "${step.id}" — call get_timeline for rows`);
  if (track.main) throw new StepError("the main layer is always the back of the stack and cannot be reordered");

  const before = editor().project.trackIds.indexOf(step.id);
  editor().nudgeTrackZ(step.id, step.direction);
  const after = editor().project.trackIds.indexOf(step.id);

  const warnings: string[] = [];
  if (after === before) {
    warnings.push(
      `"${track.name}" is already at the ${step.direction === "top" || step.direction === "up" ? "front" : "back"} of the stack`,
    );
  }
  return {
    outcome: {
      ids: [step.id],
      summary: `moved row "${track.name}" ${step.direction} (position ${before + 1} → ${after + 1} of ${
        editor().project.trackIds.length
      })`,
      warnings,
    },
    created: [],
  };
}

/**
 * Lock or unlock a set of clips in one edit.
 *
 * Exists as its own step because lock is a *batch* fact — "the picture is
 * locked" is one statement about the sequence, and an agent reporting it should
 * produce one line, not one line per clip.
 */
function setLock(step: Extract<Step, { kind: "setLock" }>): StepResult {
  const present = step.ids.filter((id) => editor().project.layers[id]);
  if (!present.length) throw new StepError(`no clip with id "${step.ids[0] ?? ""}" — call get_timeline for current ids`);

  const before = present.filter((id) => editor().project.layers[id].locked).length;
  editor().updateLayers(present, { locked: step.locked }, false);
  const unresolved = step.ids.length - present.length;

  return {
    outcome: {
      ids: present,
      summary: `${step.locked ? "locked" : "unlocked"} ${present.length} clip${present.length === 1 ? "" : "s"}${
        before === present.length && step.locked ? " (they were already locked)" : ""
      }`,
      warnings: unresolved ? [`ignored ${unresolved} unknown id(s)`] : undefined,
    },
    created: [],
  };
}

/* ---------------------------------- joins ---------------------------------- */

function validateTransition(transition: Extract<Step, { kind: "setTransition" }>["transition"]): void {
  if (transition.type !== undefined && !TRANSITION_BY_ID[transition.type]) {
    throw new StepError(`no transition called "${transition.type}" — call list_library for the ids`);
  }
  if (transition.duration !== undefined && transition.duration <= 0) {
    throw new StepError("duration must be greater than 0");
  }
}

function setTransitionStep(step: Extract<Step, { kind: "setTransition" }>): StepResult {
  const layer = requireLayer(step.id);
  validateTransition(step.transition);

  const warnings: string[] = [];
  const type = step.transition.type;
  if (type === "none" || type === "cut") {
    warnings.push(
      'setting type "none" leaves any existing bond overlap in place — use set_junction_transition action="unbond" to give the overlap back',
    );
  }
  const junction = junctionsOnTrack(editor().project, layer.trackId).find((j) =>
    step.edge === "out" ? j.from === step.id : j.to === step.id,
  );
  if (junction?.bonded && step.edge === "in" && junction.to === step.id) {
    warnings.push("this edge is bonded — a bond already owns the incoming clip's ramp");
  }

  editor().setTransition(step.id, step.edge, step.transition);
  const after = requireLayer(step.id);
  const applied = step.edge === "in" ? after.transitionIn : after.transitionOut;

  return {
    outcome: {
      ids: [step.id],
      summary: `"${layer.name}" ${step.edge === "in" ? "in" : "out"} transition → ${applied.type} ${secs(applied.duration)}`,
      warnings,
    },
    created: [],
  };
}

function bond(step: Extract<Step, { kind: "bond" }>): StepResult {
  const project = editor().project;
  const from = requireLayer(step.from);
  const to = requireLayer(step.to);
  if (from.trackId !== to.trackId) {
    throw new StepError(
      `"${from.name}" and "${to.name}" are on different rows — a bond joins two clips that touch on one row`,
    );
  }
  if (step.transition) validateTransition({ ...step.transition, type: step.transition.type });

  const junction = junctionsOnTrack(project, from.trackId).find((j) => j.from === step.from && j.to === step.to);
  if (!junction) {
    throw new StepError(
      `"${from.name}" and "${to.name}" are not a junction — "to" must start where "from" ends (order matters)`,
    );
  }

  const limit = maxBondDuration(project, step.from, step.to);
  editor().bondTransition(step.from, step.to, step.transition, false);

  const warnings: string[] = [];
  if (editor().project === project) warnings.push("that bond was already exactly as asked — nothing changed");

  const after = junctionsOnTrack(editor().project, from.trackId).find((j) => j.from === step.from);
  const requested = step.transition?.duration;
  if (requested !== undefined && after && Math.abs(after.overlap - requested) > 1e-3) {
    warnings.push(
      `bond is ${secs(after.overlap)}, not ${secs(requested)} — the ${to.type} clip's lead on that row caps it at ${secs(limit)}`,
    );
  }
  if (after && !after.overlap) warnings.push("no overlap resulted — the clips may no longer touch");

  return {
    outcome: {
      ids: [step.from, step.to],
      summary: `bonded "${from.name}" → "${to.name}" with ${after?.transition.type ?? "fade"} ${secs(after?.overlap ?? 0)}`,
      warnings,
    },
    created: [],
  };
}

function unbond(step: Extract<Step, { kind: "unbond" }>): StepResult {
  const project = editor().project;
  const from = requireLayer(step.from);
  const to = requireLayer(step.to);
  editor().unbondTransition(step.from, step.to);
  return {
    outcome: {
      ids: [step.from, step.to],
      summary:
        editor().project === project
          ? `"${from.name}" → "${to.name}" was already a plain cut`
          : `removed the bond between "${from.name}" and "${to.name}"`,
    },
    created: [],
  };
}

/* ---------------------------------- animation ---------------------------------- */

function setKeyframes(step: Extract<Step, { kind: "setKeyframes" }>): StepResult {
  const layer = requireLayer(step.id);

  if (step.action === "clear") {
    if (step.prop && !ANIMATABLE.includes(step.prop)) throw new StepError(`"${step.prop}" cannot be animated`);
    const cleared = step.prop
      ? layer.keyframes.filter((k) => k.prop === step.prop).length
      : layer.keyframes.length;
    if (!cleared) {
      return {
        outcome: { ids: [step.id], summary: `"${layer.name}" has no ${step.prop ?? ""} keyframes to clear`.replace("  ", " ") },
        created: [],
      };
    }
    editor().clearKeyframes(step.id, step.prop);
    return {
      outcome: {
        ids: [step.id],
        summary: `cleared ${cleared} ${step.prop ?? "keyframe"}${cleared === 1 ? "" : "s"} on "${layer.name}"`,
      },
      created: [],
    };
  }

  if (!step.prop) throw new StepError('action "add" needs a prop');
  if (!ANIMATABLE.includes(step.prop)) {
    throw new StepError(`"${step.prop}" cannot be animated — use one of ${ANIMATABLE.join(", ")}`);
  }
  if (step.at === undefined) throw new StepError('action "add" needs an "at" time');
  if (step.value === undefined) throw new StepError('action "add" needs a value');

  const warnings: string[] = [];
  const end = layerEnd(layer);
  if (step.at < layer.startTime || step.at > end) {
    warnings.push(
      `at ${secs(step.at)} is outside the clip (${secs(layer.startTime)}–${secs(end)}) — keyframes are stored layer-local and will be clamped`,
    );
  }

  // Stored clip-local: the agent thinks in timeline seconds, the store does not.
  const local = clamp(step.at - layer.startTime, 0, layer.duration);
  const before = new Set(layer.keyframes.map((k) => k.id));
  editor().addKeyframe(step.id, step.prop, step.value, local);

  // The store always writes a new keyframe as easeInOut, so an agent's easing
  // has to be applied as a follow-up edit — there is no argument for it. When
  // the `at` landed on an existing keyframe this is skipped, because that key
  // already carries an easing the caller did not ask to change.
  const keys = editor().project.layers[step.id]?.keyframes ?? [];
  const added = keys.find((k) => !before.has(k.id));
  const eased = step.easing !== undefined && added && added.prop === step.prop;
  if (eased && added) editor().updateKeyframe(step.id, added.id, { easing: step.easing });

  const finalKeys = editor().project.layers[step.id]?.keyframes ?? [];
  return {
    outcome: {
      ids: [step.id],
      summary: `keyframe ${step.prop}=${round(step.value, 3)} at ${secs(step.at)} on "${layer.name}"${
        eased ? ` with ${step.easing} easing` : step.easing !== undefined ? " (kept its existing easing)" : ""
      }${finalKeys.length > 1 ? ` (${finalKeys.length} total)` : ""}`,
      warnings,
    },
    created: [],
  };
}

function updateKeyframeStep(step: Extract<Step, { kind: "updateKeyframe" }>): StepResult {
  const layer = requireLayer(step.id);
  const existing = layer.keyframes.find((k) => k.id === step.keyframeId);
  if (!existing) throw new StepError(`no keyframe "${step.keyframeId}" on "${layer.name}"`);

  const next: Partial<Keyframe> = {};
  if (step.value !== undefined) next.value = step.value;
  if (step.easing !== undefined) next.easing = step.easing;
  if (step.at !== undefined) next.time = clamp(step.at - layer.startTime, 0, layer.duration);
  if (!Object.keys(next).length) throw new StepError("needs at least one of at, value or easing");

  editor().updateKeyframe(step.id, step.keyframeId, next);
  return {
    outcome: {
      ids: [step.id],
      summary: `moved ${existing.prop} keyframe on "${layer.name}" (${Object.keys(next).join(", ")})`,
    },
    created: [],
  };
}

function removeKeyframeStep(step: Extract<Step, { kind: "removeKeyframe" }>): StepResult {
  const layer = requireLayer(step.id);
  const existing = layer.keyframes.find((k) => k.id === step.keyframeId);
  if (!existing) throw new StepError(`no keyframe "${step.keyframeId}" on "${layer.name}"`);
  editor().removeKeyframe(step.id, step.keyframeId);
  return {
    outcome: { ids: [step.id], summary: `deleted the ${existing.prop} keyframe on "${layer.name}"` },
    created: [],
  };
}

/* ---------------------------------- rows ---------------------------------- */

function addTrack(step: Extract<Step, { kind: "addTrack" }>): StepResult {
  const id = editor().addTrack(step.name);
  const track = editor().project.tracks[id];
  return {
    outcome: {
      ids: [id],
      summary: `added row "${track?.name ?? step.name ?? "track"}" — it draws over the rows above it`,
    },
    created: [id],
  };
}

function renameTrack(step: Extract<Step, { kind: "renameTrack" }>): StepResult {
  requireTrack(step.id);
  const before = editor().project.tracks[step.id].name;
  editor().renameTrack(step.id, step.name);
  return { outcome: { ids: [step.id], summary: `renamed row "${before}" → "${step.name}"` }, created: [] };
}

function removeTrack(step: Extract<Step, { kind: "removeTrack" }>): StepResult {
  const track = editor().project.tracks[step.id];
  if (!track) throw new StepError(`no track with id "${step.id}"`);
  if (track.main) throw new StepError("the main layer cannot be deleted — every visual clip lands there by default");

  const doomed = layersOnTrack(editor().project, step.id);
  editor().removeTrack(step.id);
  return {
    outcome: {
      ids: [],
      summary: `deleted row "${track.name}"${doomed.length ? ` and its ${doomed.length} clip${doomed.length === 1 ? "" : "s"}` : ""}`,
    },
    created: [],
  };
}

function setMainTrack(step: Extract<Step, { kind: "setMainTrack" }>): StepResult {
  requireTrack(step.id);
  editor().setMainTrack(step.id);
  const track = editor().project.tracks[step.id];
  return {
    outcome: {
      ids: [step.id],
      summary: `"${track?.name}" is now the main layer — it moves to the top row and the back of the stack`,
    },
    created: [],
  };
}

function moveToTrack(step: Extract<Step, { kind: "moveToTrack" }>): StepResult {
  const layer = requireLayer(step.id);
  requireTrack(step.trackId);
  if (layer.trackId === step.trackId) {
    return { outcome: { ids: [step.id], summary: `"${layer.name}" is already on that row` }, created: [] };
  }
  editor().moveLayerToTrack(step.id, step.trackId);
  const track = editor().project.tracks[step.trackId];
  return {
    outcome: { ids: [step.id], summary: `moved "${layer.name}" to row "${track?.name ?? step.trackId}"` },
    created: [],
  };
}

/* ---------------------------------- the editor ---------------------------------- */

function seek(step: Extract<Step, { kind: "seek" }>): StepResult {
  editor().setCurrentTime(Math.max(0, step.time));
  const at = editor().currentTime;
  return {
    outcome: { ids: [], summary: `playhead at ${secs(at)}` },
    created: [],
  };
}

function playback(step: Extract<Step, { kind: "playback" }>): StepResult {
  const ed = editor();
  if (step.action === "play") ed.play();
  else if (step.action === "pause") ed.pause();
  else if (step.action === "toggle") ed.togglePlay();
  else ed.setLoop(step.loop ?? true);

  const after = editor();
  return {
    outcome: {
      ids: [],
      summary:
        step.action === "loop"
          ? `looping ${after.loop ? "on" : "off"}`
          : `playback ${after.isPlaying ? "playing" : "paused"} at ${secs(after.currentTime)}`,
    },
    created: [],
  };
}

function select(step: Extract<Step, { kind: "select" }>): StepResult {
  const ids = step.ids ?? [];
  const mode = step.mode ?? "replace";
  const unknown = ids.filter((id) => !editor().project.layers[id]);
  if (unknown.length) throw new StepError(`no clip with id "${unknown[0]}" — call get_timeline for current ids`);

  if (mode === "clear" || (!ids.length && mode !== "add")) {
    editor().clearSelection();
  } else if (mode === "add") {
    editor().select([...new Set([...editor().selection, ...ids])]);
  } else {
    editor().select(ids);
  }

  const count = editor().selection.length;
  return {
    outcome: {
      ids: [...editor().selection],
      summary: count ? `${count} clip${count === 1 ? "" : "s"} selected` : "selection cleared",
    },
    created: [],
  };
}

function settings(step: Extract<Step, { kind: "settings" }>): StepResult {
  const patch = step.patch;
  const allowed: (keyof ProjectSettings)[] = [
    "name",
    "width",
    "height",
    "fps",
    "backgroundColor",
    "backgroundKind",
    "backgroundGradient",
    "backgroundAngle",
  ];
  const unknown = Object.keys(patch).filter((k) => !allowed.includes(k as keyof ProjectSettings));
  if (unknown.length) {
    throw new StepError(`unknown setting(s) ${unknown.join(", ")} — valid keys are ${allowed.join(", ")}`);
  }
  if (patch.backgroundKind && patch.backgroundKind !== "color" && patch.backgroundKind !== "gradient") {
    throw new StepError('backgroundKind must be "color" or "gradient"');
  }
  for (const key of ["width", "height", "fps"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new StepError(`${key} must be a positive number`);
    }
    if ((key === "width" || key === "height") && (value < 16 || value > 7680)) {
      throw new StepError(`${key} must be between 16 and 7680`);
    }
    if (key === "fps" && value > 120) throw new StepError("fps must be 120 or less");
  }

  const before = editor().project.settings;
  const warnings: string[] = [];
  const resized = (patch.width !== undefined && patch.width !== before.width) ||
    (patch.height !== undefined && patch.height !== before.height);
  editor().updateSettings(patch as Partial<ProjectSettings>);
  const after = editor().project.settings;

  // Resizing the canvas does not refit what is already on it, so say so: the
  // clips keep their project-space positions and simply get more or less room.
  if (resized) {
    warnings.push(
      `canvas is now ${after.width}×${after.height}, but the ${editor().project.layerIds.length} existing clip(s) were not refit — use flow_social_reframe for a real reformat`,
    );
  }

  return {
    outcome: {
      ids: [],
      summary:
        before.width !== after.width || before.height !== after.height
          ? `canvas ${before.width}×${before.height} → ${after.width}×${after.height} @ ${after.fps}fps`
          : `project settings updated (${Object.keys(patch).join(", ")})`,
      warnings,
    },
    created: [],
  };
}

function exportStep(step: Extract<Step, { kind: "export" }>): StepResult {
  const project = editor().project;
  const duration = projectDuration(project);
  const supplied = (step.options ?? {}) as Partial<ExportOptions>;

  const options: ExportOptions = {
    width: project.settings.width,
    height: project.settings.height,
    fps: project.settings.fps,
    bitrateMbps: 12,
    rangeStart: 0,
    rangeEnd: round(duration, 3),
    includeAudio: true,
    format: "auto",
    fileName: `${slug(project.settings.name)}.mp4`,
    ...supplied,
  };

  if (!project.layerIds.length) throw new StepError("there is nothing on the timeline to export");
  if (options.rangeEnd <= options.rangeStart) throw new StepError("rangeEnd must be after rangeStart");

  editor().enqueueExport(options);
  const jobs = editor().exportJobs;
  const job = jobs[jobs.length - 1];
  const waiting = jobs.filter(
    (j) => j.status !== "done" && j.status !== "error" && j.status !== "canceled",
  ).length;

  const warnings: string[] = [];
  if (waiting > 1) warnings.push(`${waiting - 1} other export(s) are already queued — they render one at a time`);

  return {
    outcome: {
      ids: [job.id],
      summary: `queued export ${options.width}×${options.height} @${options.fps}fps, ${secs(
        options.rangeEnd - options.rangeStart,
      )} (job ${job.id})`,
      // Export is a realtime capture, so it is only as fast as playback and only
      // works while the tab has the foreground — the agent has to know that.
      warnings: [
        ...warnings,
        "export runs as a REALTIME capture: it takes about as long as the clip and the tab must stay in the foreground",
      ],
    },
    created: [job.id],
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "export";
}

/* ---------------------------------- compound ---------------------------------- */

function rippleDelete(step: Extract<Step, { kind: "rippleDelete" }>): StepResult {
  const project = editor().project;
  const layer = requireLayer(step.id);
  const end = layerEnd(layer);
  const duration = layer.duration;

  const followers = layersOnTrack(project, layer.trackId)
    .filter((l) => l.id !== step.id && l.startTime >= end - 1e-6)
    .sort((a, b) => a.startTime - b.startTime);

  editor().removeLayers([step.id]);
  const moves: [LayerId, number][] = followers.map((l) => [l.id, Math.max(0, l.startTime - duration)]);
  if (moves.length) editor().setLayersStart(moves, false);

  const warnings: string[] = [];
  const end2 = projectDuration(editor().project);
  if (end2 > 0 && Math.abs(end2 - projectDuration(project)) > 1e-3) {
    warnings.push(
      `timeline is now ${secs(end2)} (was ${secs(projectDuration(project))}) — only "${layer.name}"'s row was rippled, other rows kept their times`,
    );
  }

  return {
    outcome: {
      ids: [],
      summary: `ripple-deleted "${layer.name}" (${secs(duration)}) and pulled ${moves.length} clip${
        moves.length === 1 ? "" : "s"
      } back on that row`,
      warnings,
    },
    created: [],
  };
}

/** Cuts every clip on `trackId` that straddles `time`, leaving the row in pieces. */
function splitTrackAt(trackId: string, time: number): void {
  const targets = layersOnTrack(editor().project, trackId)
    .filter((l) => time > l.startTime + 0.03 && time < layerEnd(l) - 0.03)
    .map((l) => l.id);
  if (!targets.length) return;
  editor().select(targets);
  editor().setCurrentTime(time);
  editor().splitAtPlayhead();
}

function threePointEdit(step: Extract<Step, { kind: "threePointEdit" }>): StepResult {
  const asset = requireAsset(step.assetId);
  const settings = editor().project.settings;
  const warnings: string[] = [];

  const sourceIn = Math.max(0, step.sourceIn);
  const sourceOut = Math.max(sourceIn + MIN_LAYER_DURATION, step.sourceOut);
  const length = sourceOut - sourceIn;
  if (step.sourceOut <= step.sourceIn) warnings.push("sourceOut was not after sourceIn — using the minimum clip length");

  const recordIn = Math.max(0, step.recordIn);
  const requestedTrack = step.trackId ?? mainTrackId(editor().project);
  if (!requestedTrack) throw new StepError("the project has no rows to edit into");
  requireTrack(requestedTrack);

  if (step.mode === "insert") {
    splitTrackAt(requestedTrack, recordIn);
    const moves: [LayerId, number][] = layersOnTrack(editor().project, requestedTrack)
      .filter((l) => l.startTime >= recordIn - 1e-6)
      .map((l) => [l.id, l.startTime + length]);
    if (moves.length) editor().setLayersStart(moves, false);
  } else {
    // Split at both edges FIRST, so the material that has to go is a whole clip
    // and the clips that survive keep clean boundaries at the edit points.
    const recordOut = recordIn + length;
    splitTrackAt(requestedTrack, recordIn);
    splitTrackAt(requestedTrack, recordOut);
    const doomed = layersOnTrack(editor().project, requestedTrack)
      .filter((l) => l.startTime >= recordIn - 1e-6 && l.startTime < recordOut - 1e-6)
      .map((l) => l.id);
    if (doomed.length) editor().removeLayers(doomed);
  }

  const layer = createMediaLayer(asset, settings, recordIn);
  layer.inPoint = sourceIn;

  const room = headroom(asset, sourceIn);
  const wanted = Math.min(length, room);
  if (wanted < length - 1e-3) {
    warnings.push(
      `clip is ${secs(wanted)}, not ${secs(length)} — sourceIn ${secs(sourceIn)} leaves only that much of the asset`,
    );
  }
  layer.duration = Math.max(MIN_LAYER_DURATION, wanted);

  // The target row may have been pruned away if the overwrite emptied it (rows
  // are tidied when they run dry), in which case the clip is re-homed.
  if (editor().project.tracks[requestedTrack]) {
    layer.trackId = requestedTrack;
  } else {
    warnings.push("the target row was empty and has been tidied away — the clip was placed on a fresh row");
  }

  const id = editor().addLayer(layer);
  const placed = editor().project.layers[id];

  return {
    outcome: {
      ids: [id],
      summary: `${step.mode === "insert" ? "inserted" : "overwrote"} ${secs(placed?.duration ?? wanted)} of "${asset.name}" at ${secs(
        recordIn,
      )} using source ${secs(sourceIn)}–${secs(sourceIn + (placed?.duration ?? wanted))}`,
      warnings,
    },
    created: [id],
  };
}

function autoTrimSilence(step: Extract<Step, { kind: "autoTrimSilence" }>): StepResult {
  const asset = requireAsset(step.assetId);
  const waveform = asset.waveform;
  if (!waveform?.length) {
    throw new StepError(
      `"${asset.name}" has no decoded waveform — silence detection needs an audio track that has been decoded`,
    );
  }
  const duration = asset.duration ?? 0;
  if (!duration) throw new StepError(`"${asset.name}" has no known duration`);

  const threshold = step.threshold ?? 0.12;
  const pad = Math.max(0, step.pad ?? 0.06);
  const maxClip = Math.max(MIN_LAYER_DURATION, step.maxClipDuration ?? 12);
  const perBucket = duration / waveform.length;

  // Peaks → runs of loud buckets → spans widened by `pad` and merged when the
  // silence between them is shorter than twice the padding. Two spans closer
  // than that would produce a cut nobody would keep.
  const spans: [number, number][] = [];
  let opened = -1;
  for (let i = 0; i < waveform.length; i++) {
    const loud = waveform[i] > threshold;
    if (loud && opened < 0) opened = i;
    const closes = (!loud && opened >= 0) || (loud && i === waveform.length - 1);
    if (!closes || opened < 0) continue;

    const lastLoud = loud ? i : i - 1;
    const from = Math.max(0, opened * perBucket - pad);
    const to = Math.min(duration, (lastLoud + 1) * perBucket + pad);
    const prev = spans[spans.length - 1];
    if (prev && from - prev[1] < pad * 2) prev[1] = Math.max(prev[1], to);
    else spans.push([from, to]);
    opened = -1;
  }

  if (!spans.length) {
    throw new StepError(`nothing in "${asset.name}" is above the threshold of ${threshold} — try a lower threshold`);
  }

  const settings = editor().project.settings;
  const trackId = step.trackId;
  if (trackId) requireTrack(trackId);

  const created: LayerId[] = [];
  let cursor = Math.max(0, step.start);
  const sourceKept = spans.reduce((sum, [from, to]) => sum + (to - from), 0);

  for (const [from, to] of spans) {
    // Long runs are chunked so the timeline gets several normal-sized clips
    // rather than one enormous one that is hard to trim by hand.
    for (let s = from; s < to - 1e-3; s += maxClip) {
      const e = Math.min(to, s + maxClip);
      const layer = createMediaLayer(asset, settings, cursor);
      layer.inPoint = s;
      layer.duration = Math.max(MIN_LAYER_DURATION, e - s);
      if (trackId) layer.trackId = trackId;
      created.push(editor().addLayer(layer));
      cursor += layer.duration;
    }
  }

  return {
    outcome: {
      ids: created,
      summary: `kept ${spans.length} segment${spans.length === 1 ? "" : "s"} of "${asset.name}" (${secs(
        sourceKept,
      )} of ${secs(duration)} source) as ${created.length} clip${created.length === 1 ? "" : "s"} from ${secs(step.start)}`,
      warnings: created.length > 1 ? ["original asset left untouched — the raw clip is still in list_assets if the cut is too tight"] : undefined,
    },
    created,
  };
}

function reframe(step: Extract<Step, { kind: "reframe" }>): StepResult {
  const size = ASPECT_SIZES[step.aspect];
  if (!size) {
    throw new StepError(`unknown aspect "${step.aspect}" — use one of ${Object.keys(ASPECT_SIZES).join(", ")}`);
  }
  const mode = step.fit ?? "cover";

  const state = editor();
  const oldW = state.project.settings.width;
  const oldH = state.project.settings.height;
  const [width, height] = size;

  if (oldW === width && oldH === height) {
    return {
      outcome: { ids: [], summary: `already ${width}×${height} (${step.aspect}) — nothing to reframe` },
      created: [],
    };
  }

  editor().updateSettings({ width, height });

  const sx = width / oldW;
  const sy = height / oldH;
  const shrink = Math.min(sx, sy);
  const refit: string[] = [];

  // Everything on the canvas moves with it, so a clip that filled the frame
  // before still fills it afterwards.
  for (const layer of state.project.layerIds.map((id) => state.project.layers[id])) {
    if (!layer || layer.type === "audio") continue;

    const patch = { x: layer.transform.x * sx, y: layer.transform.y * sy };

    if (layer.type === "video" || layer.type === "image") {
      const asset = layer.assetId ? state.assets[layer.assetId] : undefined;
      const natW = asset?.width && asset?.height ? asset.width : oldW;
      const natH = asset?.width && asset?.height ? asset.height : oldH;
      // Natural size is what `scale` maps from, so the fit is recomputed rather
      // than multiplied — a 3:4 clip in a 9:16 frame needs a different fit, not
      // a smaller version of the old one. `cover` fills the new frame and crops
      // the excess (what a social reformat wants); `contain` letterboxes.
      const fit = mode === "cover" ? Math.max(width / natW, height / natH) : Math.min(width / natW, height / natH);
      editor().updateLayerTransform(layer.id, { ...patch, scale: fit }, false);
      refit.push(layer.name);
      continue;
    }

    if (layer.type === "text") {
      const text = layer.text;
      if (text) {
        editor().updateLayer(
          layer.id,
          { text: { ...text, fontSize: Math.round(text.fontSize * sy) } },
          false,
        );
      }
      editor().updateLayerTransform(layer.id, patch, false);
      refit.push(layer.name);
      continue;
    }

    if (layer.type === "sticker") {
      // The sticker box is a fixed size in project pixels, so it has to grow
      // with the canvas or it shrinks relative to the frame.
      editor().updateLayerTransform(layer.id, { ...patch, scale: layer.transform.scale * shrink }, false);
      refit.push(layer.name);
      continue;
    }

    // Effects are drawn relative to the canvas, so only the centre moves.
    editor().updateLayerTransform(layer.id, patch, false);
    refit.push(layer.name);
  }

  return {
    outcome: {
      ids: [],
      summary: `reframed ${oldW}×${oldH} → ${width}×${height} (${step.aspect}, ${mode}) and refit ${refit.length} layer${
        refit.length === 1 ? "" : "s"
      }`,
      warnings: offFrameGraphics(),
    },
    created: [],
  };
}

/**
 * Graphics that no longer sit inside the frame after a reframe.
 *
 * Only graphics are checked. A media clip is *supposed* to be cropped by
 * `cover` — warning about a full-frame video would be noise — but a title that
 * has fallen off the edge is a mistake the agent should be told about.
 */
function offFrameGraphics(): string[] {
  const { settings, layerIds, layers } = editor().project;
  const outside: string[] = [];

  for (const id of layerIds) {
    const layer = layers[id];
    if (!layer || layer.type === "audio" || layer.type === "video" || layer.type === "image") continue;

    const base = getBaseSize(layer, settings, editor().assets);
    const halfW = (base.width * layer.transform.scale) / 2;
    const halfH = (base.height * layer.transform.scale) / 2;
    // A rotated rectangle covers more than its own width: its axis-aligned
    // footprint is the two sides projected onto each axis.
    const rad = (layer.transform.rotation * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const spanX = halfW * cos + halfH * sin;
    const spanY = halfW * sin + halfH * cos;

    const slackX = settings.width * 0.02;
    const slackY = settings.height * 0.02;
    const { x, y } = layer.transform;
    if (x - spanX < -slackX || x + spanX > settings.width + slackX || y - spanY < -slackY || y + spanY > settings.height + slackY) {
      outside.push(`"${layer.name}"`);
    }
  }

  return outside.length
    ? [
        `${outside.join(", ")} now sit${
          outside.length === 1 ? "s" : ""
        } partly outside the ${settings.width}×${settings.height} frame — use set_clip_transform to bring ${
          outside.length === 1 ? "it" : "them"
        } back in`,
      ]
    : [];
}
