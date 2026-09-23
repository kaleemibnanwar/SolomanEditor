/**
 * SAVED MACROS — the agent's own reusable edit recipes.
 *
 * A macro is the *process* of an edit, not its result: an ordered list of steps
 * (`Step[]`, the same vocabulary every tool compiles to) plus a handful of named
 * SLOTS. A slot is a `{{name}}` placeholder inside the steps that is substituted
 * at run time, so one macro can stand for every recurrence of the same workflow —
 * the footage and the numbers change, the shape of the edit does not.
 *
 * This is the token-saver: instead of re-deriving "trim silence → beat cut →
 * title → export" from twelve tool calls every time, the agent authors it once,
 * saves it, and replays it with one call that passes the changing bits as slots.
 *
 * Deliberately separate from templates. A template (snapshot/recipe) is a saved
 * *state* a project starts from; a macro is a saved *sequence of steps*. The two
 * compose: a macro can call `create_project { snapshot }` as its first step.
 */
import { MACRO_STORE, storeDelete, storeGet, storeGetAll, storePut } from "@/lib/storage";
import { uid } from "@/lib/time";
import type { Step } from "@/lib/mcp/steps";

/** One named slot the caller must (or may) fill at run time. */
export interface MacroSlot {
  name: string;
  description?: string;
  required?: boolean;
  /** Value used when the caller does not supply one. */
  default?: string;
}

export interface SavedMacro {
  id: string;
  name: string;
  blurb?: string;
  createdAt: number;
  params: MacroSlot[];
  /** The plan, as plain JSON. `{{name}}` marks a slot, `$0`/`$all` a step ref. */
  steps: Step[];
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

export async function listMacros(): Promise<SavedMacro[]> {
  const macros = await storeGetAll<SavedMacro>(MACRO_STORE);
  return macros.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getMacro(idOrName: string): Promise<SavedMacro | undefined> {
  const macros = await listMacros();
  return (
    macros.find((macro) => macro.id === idOrName) ??
    macros.find((macro) => macro.name.trim().toLowerCase() === idOrName.trim().toLowerCase())
  );
}

export async function saveMacro(
  name: string,
  blurb: string | undefined,
  params: MacroSlot[],
  steps: Step[],
): Promise<SavedMacro> {
  const macro: SavedMacro = {
    id: uid("macro"),
    name,
    blurb,
    createdAt: Date.now(),
    params,
    steps,
  };
  await storePut(MACRO_STORE, macro);
  return macro;
}

export async function deleteMacro(id: string): Promise<void> {
  await storeDelete(MACRO_STORE, id);
}

/* ------------------------------------------------------------------ *
 * Slot substitution
 * ------------------------------------------------------------------ */

/** Collect every `{{name}}` a macro's steps mention, so missing slots are caught. */
export function macroReferences(steps: Step[]): Set<string> {
  const names = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g)) names.add(match[1]);
      return;
    }
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(walk);
  };
  steps.forEach(walk);
  return names;
}

const NUMBER = /^-?\d+(\.\d+)?$/;

/** Deep-copy `steps`, substituting slot values. Numbers are coerced when they can be. */
export function fillSlots(steps: Step[], values: Record<string, string>): Step[] {
  const apply = (value: unknown): unknown => {
    if (typeof value === "string") {
      // A whole-string slot that looks numeric becomes a number, so `duration` and
      // `at` slots land as numbers rather than strings that validation would reject.
      const whole = value.match(/^\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}$/);
      if (whole && whole[1] in values) {
        const raw = values[whole[1]];
        return NUMBER.test(raw) ? Number(raw) : raw;
      }
      return value.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, name: string) =>
        name in values ? values[name] : _,
      );
    }
    if (Array.isArray(value)) return value.map(apply);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = apply(item);
      return out;
    }
    return value;
  };
  return steps.map((step) => apply(step)) as Step[];
}
