/**
 * THE TOOL KIT — the plumbing every tool shares.
 *
 * `tools.ts` (single operations) and `flows.ts` (multi-step editorial
 * operations) are two different catalogues with the same anatomy: each tool
 * reads a little state, compiles a request into an ordered `Step[]`, hands that
 * plan to `runPlan` and renders the report. Everything around that spine — the
 * schema builders, the argument coercers, target resolution, plan reporting —
 * lives here so both catalogues stay thin and behave identically.
 *
 * Nothing in this file touches project state except to *read* it, and nothing
 * here knows about any particular tool.
 */
import { STICKER_BOX, getBaseSize } from "@/lib/compositor";
import { resolveTargets } from "@/lib/mcp/observe";
import { runPlan } from "@/lib/mcp/executor";
import type { RunReport, Step, TransitionPatch } from "@/lib/mcp/steps";
import type { JsonSchema, McpToolResult, ToolAnnotations } from "@/lib/mcp/protocol";
import { textResult } from "@/lib/mcp/protocol";
import { round } from "@/lib/time";
import { editor } from "@/store/editorStore";
import type { EffectKind, Layer, LayerId, TransitionDirection, TransitionType } from "@/types/editor";

/* ------------------------------------------------------------------ *
 * The shape of a tool
 * ------------------------------------------------------------------ */

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  run: (args: Record<string, unknown>) => McpToolResult | Promise<McpToolResult>;
}

export const READ: ToolAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
export const WRITE: ToolAnnotations = { readOnlyHint: false, idempotentHint: false, openWorldHint: false };

/* ------------------------------------------------------------------ *
 * Schema builders — the descriptions ARE the agent's documentation
 * ------------------------------------------------------------------ */

export const num = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({
  type: "number",
  description,
  ...extra,
});

export const int = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({
  type: "integer",
  description,
  ...extra,
});

export const str = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({
  type: "string",
  description,
  ...extra,
});

export const bool = (description: string): JsonSchema => ({ type: "boolean", description });

export const strList = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({
  type: "array",
  description,
  items: { type: "string" },
  ...extra,
});

export const choice = (description: string, values: readonly string[], extra: Partial<JsonSchema> = {}): JsonSchema => ({
  type: "string",
  description,
  enum: [...values],
  ...extra,
});

export const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => {
  const schema: JsonSchema = { type: "object", properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
};

export const NO_ARGS = object({});

/* ------------------------------------------------------------------ *
 * Argument access
 * ------------------------------------------------------------------ */

export const argNumber = (args: Record<string, unknown>, key: string): number | undefined => {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export const argBool = (args: Record<string, unknown>, key: string): boolean | undefined => {
  const value = args[key];
  return typeof value === "boolean" ? value : undefined;
};

export const argString = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === "string" && value.length ? value : undefined;
};

export const argStringList = (args: Record<string, unknown>, key: string): string[] | undefined => {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return items.length ? items : undefined;
};

/**
 * Narrow a required argument. The schema has already guaranteed it, so this is
 * a type assertion with a runtime backstop rather than real validation.
 */
export function need(args: Record<string, unknown>, key: string): string {
  const value = argString(args, key);
  if (value === undefined) throw new Error(`missing required argument "${key}"`);
  return value;
}

export function needNumber(args: Record<string, unknown>, key: string): number {
  const value = argNumber(args, key);
  if (value === undefined) throw new Error(`missing required argument "${key}"`);
  return value;
}

/** Collect only the named keys that were actually supplied. */
export function present<S extends object>(source: Partial<S>): Partial<S> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined) out[key] = value;
  return out as Partial<S>;
}

export const hasKeys = (value: object): boolean => Object.keys(value).length > 0;

export function unknownValue(kind: string, value: string, ids: string[]): Error {
  const shown = ids.slice(0, 14).join(", ");
  return new Error(
    `No ${kind} called "${value}". Valid ids: ${shown}${ids.length > 14 ? `, … (${ids.length} in total — list_library shows the rest)` : ""}`,
  );
}

export function presetOf<T extends { id: string }>(kind: string, items: T[], id: string): T {
  const found = items.find((item) => item.id === id);
  if (!found) throw unknownValue(kind, id, items.map((item) => item.id));
  return found;
}

/* ------------------------------------------------------------------ *
 * Targets
 * ------------------------------------------------------------------ */

/**
 * The clips a write should act on. Named ids win; otherwise the human's
 * selection is used, because that is what they were pointing at.
 */
export function targets(args: Record<string, unknown>, key = "clipIds"): LayerId[] {
  const resolved = resolveTargets(editor(), argStringList(args, key));
  if (!resolved.length) {
    throw new Error(
      `No clip ids given and nothing is selected — pass ${key}, or select clips first with select_clips.`,
    );
  }
  return resolved;
}

export function layerOf(id: string): Layer {
  const layer = editor().project.layers[id];
  if (!layer) throw new Error(`No clip with id "${id}" — call get_timeline for the ids that exist.`);
  return layer;
}

/* ------------------------------------------------------------------ *
 * Running a plan
 * ------------------------------------------------------------------ */

export interface PlanOptions {
  /** `false` for tools that manage history themselves (`edit_history`). */
  record?: boolean;
  /** Tool-level remarks that are not tied to any one step. */
  notes?: string[];
  /** Extra keys merged into the structured payload. */
  extra?: Record<string, unknown>;
  /**
   * Facts that only exist once the plan has run: the real end of an assembly
   * (a shot whose source ran short), how much a ripple delete actually pulled
   * back, whether a punch-in had room. Called with the finished report, and its
   * notes and extra keys are merged into the result.
   */
  after?: (report: RunReport) => { notes?: string[]; extra?: Record<string, unknown> } | void;
}

/**
 * Run a plan and render it as one honest report.
 *
 * The text channel is what the model reads: numbered steps in order, then the
 * warnings, then the ids it can use next. The structured channel is the same
 * facts typed, for a client that wants to render them.
 */
export function applyPlan(label: string, steps: Step[], options: PlanOptions = {}): McpToolResult {
  const report = runPlan(steps, { label, record: options.record });
  const notes = options.notes ? [...options.notes] : [];
  const extra: Record<string, unknown> = { ...options.extra };

  // The tail of the report — read after the plan, because it describes what the
  // plan actually did rather than what it was asked to do.
  const tail = options.after?.(report);
  if (tail) {
    if (tail.notes?.length) notes.push(...tail.notes);
    if (tail.extra) Object.assign(extra, tail.extra);
  }

  const lines = [
    `${label} — ${report.ok ? "done" : "STOPPED part-way"} (${report.steps.length} step${report.steps.length === 1 ? "" : "s"})`,
  ];
  report.steps.forEach((step, index) => lines.push(`  ${index}. ${step.summary}`));
  for (const warning of report.warnings) lines.push(`  ! ${warning}`);
  for (const note of notes) lines.push(`  · ${note}`);
  if (report.created.length) lines.push(`  new ids: ${report.created.join(", ")}`);
  if (report.error) lines.push(`  error: ${report.error}`);

  const structured: Record<string, unknown> = {
    ok: report.ok,
    label,
    created: report.created,
    stepCount: report.steps.length,
    steps: report.steps.map((step) => ({
      step: step.step,
      summary: step.summary,
      ids: step.ids,
      warnings: step.warnings ?? [],
    })),
    warnings: report.warnings,
    notes,
    ...extra,
  };
  if (report.error) structured.error = report.error;

  const result = textResult(lines.join("\n"), structured);
  return report.ok ? result : { ...result, isError: true };
}

/* ------------------------------------------------------------------ *
 * Transform helpers
 * ------------------------------------------------------------------ */

/** The transform fields present in `args`, or null when none were given. */
export function transformPatch(
  args: Record<string, unknown>,
): Partial<Record<"x" | "y" | "scale" | "rotation", number>> | null {
  const patch = present({
    x: argNumber(args, "x"),
    y: argNumber(args, "y"),
    scale: argNumber(args, "scale"),
    rotation: argNumber(args, "rotation"),
  });
  return hasKeys(patch) ? patch : null;
}

/**
 * A requested pixel size as a scale factor.
 *
 * Shapes and emoji stickers are drawn in a fixed 180px box and then scaled, so
 * "make it 320px wide" is `scale = 320 / 180` — not 320. Doing that arithmetic
 * here is what lets an agent talk in the units a user would.
 */
export const sizeToScale = (size: number): number => size / STICKER_BOX;

/**
 * The scale that makes a clip fill (`cover`) or fit inside (`contain`) the
 * canvas. Uses the compositor's own natural-size rule, so the number matches
 * what the frame will actually show — a 4K clip and a 300px one both work.
 */
export function fitScale(layer: Layer, mode: "cover" | "contain"): number {
  const { settings } = editor().project;
  const base = getBaseSize(layer, settings, editor().assets);
  if (!base.width || !base.height) return layer.transform.scale;
  const sx = settings.width / base.width;
  const sy = settings.height / base.height;
  return round(mode === "cover" ? Math.max(sx, sy) : Math.min(sx, sy), 4);
}

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

/** The transition fields present in `args`, plus the type the schema requires. */
export function transitionPatch(args: Record<string, unknown>): TransitionPatch {
  return present<TransitionPatch>({
    type: argString(args, "type") as TransitionType | undefined,
    duration: argNumber(args, "duration"),
    direction: argString(args, "direction") as TransitionDirection | undefined,
    softness: argNumber(args, "softness"),
    intensity: argNumber(args, "intensity"),
    color: argString(args, "color"),
  });
}

/* ------------------------------------------------------------------ *
 * Shared vocabulary
 * ------------------------------------------------------------------ */

export const ANIMATABLE = ["opacity", "x", "y", "scale", "rotation", "volume"] as const;
export const EASINGS = ["linear", "easeIn", "easeOut", "easeInOut", "easeInQuad", "bounce"] as const;

/**
 * Every effect kind the compositor can draw. Kept as an explicit list because
 * there is no runtime catalogue of kinds — the presets in the library only
 * cover the ones worth a card, and `solid` has none.
 */
export const EFFECT_KINDS: EffectKind[] = [
  "solid",
  "gradient",
  "vignette",
  "glow",
  "lightLeak",
  "bokeh",
  "dust",
  "flares",
  "rays",
  "streaks",
  "prism",
  "halftone",
  "scanlines",
  "noise",
  "grid",
  "grain",
  "snow",
  "confetti",
  "sparkle",
  "rail",
];
