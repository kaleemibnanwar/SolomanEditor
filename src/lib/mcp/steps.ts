/**
 * EDITOR STEPS — the vocabulary an agent controls the timeline with.
 *
 * A tool never touches the store directly. It returns a *plan*: an ordered list
 * of steps. `executor.ts` runs them against `editorStore` and reports back what
 * changed. That split is what lets one call do real editorial work — a rough cut
 * is one tool call that compiles to a dozen steps — while every individual
 * mutation still goes through the same store actions the UI uses, so undo,
 * history labels and the preview all behave exactly as if a human had clicked.
 *
 * Three kinds of step:
 *
 *   ATOMIC      one store action (move a clip, set a filter).
 *   COMPOUND    a real NLE operation that needs values only the editor can
 *               compute — a three-point edit has to split and slide clips, and
 *               silence detection has to read the audio peaks. These carry
 *               their own implementation in the executor.
 *   REFERENCE   any string in a plan may be `"$0"`: the first id step 0
 *               produced, `"$0+"`: all of them, `"$all"`: everything produced so
 *               far. That is how a flow refers to a clip it created two steps
 *               earlier without the agent having to know its id in advance.
 *
 * Times are always seconds on the PROJECT timeline unless the field says
 * otherwise (`inPoint` is seconds into the source media).
 */

import type {
  AnimatableProp,
  Easing,
  EffectKind,
  EffectStyle,
  LayerFilters,
  LayerGrade,
  ShapeId,
  StickerStyle,
  TextStyle,
  Transition,
  TransitionType,
} from "@/types/editor";

/** The reference `"$all"` — every layer id produced by the plan so far. */
export const ALL_REFS = "$all";

/* ------------------------------------------------------------------ *
 * Steps
 * ------------------------------------------------------------------ */

export type TransitionPatch = Partial<Transition> & { type?: TransitionType };

/**
 * One piece of source placed on the timeline, for `assemble`.
 *
 * A rough cut is a list of these: which take, where it starts in the source
 * (`inPoint`) and how much of it to lay down (`duration`, default: all of it
 * from `inPoint`). The executor places them nose to tail, so an agent can
 * describe an edit as a list of shots instead of doing the arithmetic.
 */
export interface AssembleClip {
  assetId: string;
  /** Seconds into the source media. Defaults to 0. */
  inPoint?: number;
  /** Seconds of source to use. Defaults to everything from `inPoint`. */
  duration?: number;
}

export type Step =
  /* ---- bring new material onto the timeline ---- */
  | { kind: "addMedia"; assetId: string; start: number; duration?: number; inPoint?: number; trackId?: string }
  | { kind: "addText"; content: string; start?: number; duration?: number; text?: Partial<TextStyle>; x?: number; y?: number; scale?: number; name?: string; trackId?: string }
  | { kind: "addShape"; shape: ShapeId; start?: number; duration?: number; style?: Partial<StickerStyle>; trackId?: string }
  | { kind: "addSticker"; glyph: string; start?: number; duration?: number; name?: string }
  | { kind: "addEffect"; presetId?: string; effectKind?: EffectKind; style?: Partial<EffectStyle>; start?: number; duration?: number; name?: string; trackId?: string }
  | { kind: "addBackground"; presetId: string; start?: number; duration?: number }
  | { kind: "assemble"; clips: AssembleClip[]; start: number; trackId?: string }

  /* ---- change what a clip is ---- */
  | { kind: "patchLayer"; id: string; patch: LayerPatch }
  | { kind: "setTransform"; id: string; x?: number; y?: number; scale?: number; rotation?: number }
  | { kind: "setFilters"; ids: string[]; filters: Partial<LayerFilters>; reset?: boolean }
  | { kind: "setGrade"; ids: string[]; grade: Partial<LayerGrade> }
  | { kind: "applyLook"; ids: string[]; lookId: string }

  /* ---- change when a clip plays ---- */
  | { kind: "setTiming"; id: string; start?: number; duration?: number; inPoint?: number }
  | { kind: "split"; at: number; ids?: string[] }
  | { kind: "remove"; ids: string[] }
  | { kind: "duplicate"; ids: string[] }
  | { kind: "reorder"; id: string; direction: "up" | "down" | "top" | "bottom" }
  | { kind: "reorderTrack"; id: string; direction: "up" | "down" | "top" | "bottom" }
  | { kind: "setLock"; ids: string[]; locked: boolean }

  /* ---- joins ---- */
  | { kind: "setTransition"; id: string; edge: "in" | "out"; transition: TransitionPatch }
  | { kind: "bond"; from: string; to: string; transition?: TransitionPatch }
  | { kind: "unbond"; from: string; to: string }

  /* ---- animation ---- */
  | { kind: "setKeyframes"; id: string; action: "add" | "clear"; prop?: AnimatableProp; at?: number; value?: number; easing?: Easing }
  | { kind: "updateKeyframe"; id: string; keyframeId: string; at?: number; value?: number; easing?: Easing }
  | { kind: "removeKeyframe"; id: string; keyframeId: string }

  /* ---- rows ---- */
  | { kind: "addTrack"; name?: string }
  | { kind: "renameTrack"; id: string; name: string }
  | { kind: "removeTrack"; id: string }
  | { kind: "setMainTrack"; id: string }
  | { kind: "moveToTrack"; id: string; trackId: string }

  /* ---- the editor itself ---- */
  | { kind: "seek"; time: number }
  | { kind: "playback"; action: "play" | "pause" | "toggle" | "loop"; loop?: boolean }
  | { kind: "select"; ids: string[]; mode?: "replace" | "add" | "clear" }
  | { kind: "settings"; patch: Record<string, unknown> }
  | { kind: "export"; options?: Record<string, unknown> }
  | { kind: "undo" }
  | { kind: "redo" }

  /* ---- compound: needs the editor to compute values ---- */
  | { kind: "rippleDelete"; id: string }
  | { kind: "threePointEdit"; assetId: string; sourceIn: number; sourceOut: number; recordIn: number; mode: "insert" | "overwrite"; trackId?: string }
  | { kind: "autoTrimSilence"; assetId: string; start: number; threshold?: number; pad?: number; maxClipDuration?: number; trackId?: string }
  | { kind: "reframe"; aspect: string; fit?: "cover" | "contain" };

/**
 * Layer fields an agent may set directly, with the ones it may not left out.
 *
 * A layer has no `blend` field of its own — blending lives on `EffectStyle` —
 * so it is set through `effect.blend`, like any other effect property. The
 * three type-specific blocks are *merged* into whatever the layer already
 * holds, so `{ text: { fontSize: 90 } }` changes the size and leaves the rest
 * of the style alone. Setting a block the layer's type does not own is a
 * warning, not an error: the patch still runs.
 */
export interface LayerPatch {
  name?: string;
  opacity?: number;
  volume?: number;
  hidden?: boolean;
  locked?: boolean;
  rate?: number;
  mediaLoop?: boolean;
  audioFadeIn?: number;
  audioFadeOut?: number;
  text?: Partial<TextStyle>;
  sticker?: Partial<StickerStyle>;
  effect?: Partial<EffectStyle>;
}

/* ------------------------------------------------------------------ *
 * Outcomes
 * ------------------------------------------------------------------ */

/**
 * What one step did. `ids` is the contract that makes references work: a step
 * that creates a clip must report it, and a step that acted on existing clips
 * reports the ones it touched, so `"$n+"` can hand them to a later step.
 */
export interface StepOutcome {
  /** `$n` resolves to ids[0]; `$n+` resolves to all of them. */
  ids: string[];
  /** One line for the agent's log. */
  summary: string;
  /** Anything worth warning about that did not stop the step. */
  warnings?: string[];
}

export interface RunReport {
  ok: boolean;
  /** Per-step outcomes, in plan order — index n is `$n`. */
  steps: (StepOutcome & { step: string })[];
  warnings: string[];
  /** Ids created by the whole plan, in creation order. */
  created: string[];
  error?: string;
}

/** Expand `"$0"`, `"$0+"` and `"$all"` inside a plan using earlier outcomes. */
export function resolveRefs(step: Step, outcomes: StepOutcome[]): Step {
  const read = (ref: string): string | string[] | null => {
    if (ref === ALL_REFS) return outcomes.flatMap((o) => o.ids);
    const match = /^\$(\d+)(\+?)$/.exec(ref);
    if (!match) return null;
    const outcome = outcomes[Number(match[1])];
    if (!outcome) return null;
    return match[2] ? outcome.ids : (outcome.ids[0] ?? null);
  };

  const expand = (value: unknown): unknown => {
    if (typeof value === "string") return read(value) ?? value;
    if (Array.isArray(value)) return value.flatMap((item) => expand(item));
    return value;
  };

  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(step)) next[key] = expand(value);
  return next as unknown as Step;
}

/** True when a plan contains a step that changes the project graph. */
export const planMutatesProject = (steps: Step[]): boolean =>
  steps.some((s) => s.kind !== "seek" && s.kind !== "select" && s.kind !== "playback");
