/**
 * MACRO TOOLS — save and replay the agent's own edit recipes.
 *
 * The token-saver of the whole surface. An agent that performs the same editorial
 * workflow repeatedly (trim silence, beat cut, title, export) saves it once as a
 * named macro, then replays it with a single `run_macro` call that passes the
 * changing bits as slots — instead of re-deriving the twelve calls every time.
 *
 * A macro is an ordered `Step[]` plus `{{slot}}` placeholders. `run_macro`
 * substitutes the slot values and hands the plan to the same `applyPlan` every
 * other tool uses, so one replay is still one undo step and every mutation still
 * goes through the store actions a human click would use.
 */
import { fillSlots, getMacro, listMacros, macroReferences, saveMacro, deleteMacro, type SavedMacro } from "@/lib/macros";
import { READ, WRITE, applyPlan, argString, type ToolDefinition } from "@/lib/mcp/kit";
import { textResult, toolError, type JsonSchema } from "@/lib/mcp/protocol";
import type { Step } from "@/lib/mcp/steps";

/* ------------------------------------------------------------------ *
 * Schema fragments for the array/object shapes the kit builders do not cover
 * ------------------------------------------------------------------ */

const PARAMS_SCHEMA: JsonSchema = {
  type: "array",
  description:
    "The slots the macro exposes. Each is a name the steps refer to as {{name}}, with an optional description and default.",
  items: {
    type: "object",
    properties: {
      name: { type: "string", description: "Slot name, referenced as {{name}} in the steps." },
      description: { type: "string", description: "What the caller should put in it." },
      required: { type: "boolean", description: "Whether run_macro refuses to run without it." },
      default: { type: "string", description: "Value used when the caller omits it." },
    },
    required: ["name"],
    additionalProperties: true,
  },
};

const STEPS_SCHEMA: JsonSchema = {
  type: "array",
  description:
    "The plan, as an array of step objects (the vocabulary documented in the playbook). $0/$all refer to earlier steps; {{name}} marks a slot.",
};

const SLOTS_SCHEMA: JsonSchema = {
  type: "object",
  description: "Slot values, keyed by slot name, e.g. { \"musicAsset\": \"asset_9\", \"duration\": \"12\" }.",
  additionalProperties: true,
};

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

const lineFor = (macro: SavedMacro): string =>
  `  "${macro.id}" — ${macro.name} (${macro.steps.length} step${macro.steps.length === 1 ? "" : "s"}${
    macro.params.length ? `, slots: ${macro.params.map((p) => p.name).join(", ")}` : ""
  })${macro.blurb ? ` — ${macro.blurb}` : ""}`;

export const MACRO_TOOLS: ToolDefinition[] = [
  {
    name: "list_macros",
    title: "List saved macros",
    description:
      "Every saved edit recipe: its id, name, blurb, step count and the slot names it expects. Read this before run_macro, so you pass the right slots and none of the structure is re-derived.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ,
    run: async () => {
      const macros = await listMacros();
      return textResult(
        macros.length
          ? [
              `${macros.length} saved macro(s), most recent first. Replay one with run_macro { macro, slots }.`,
              ...macros.map(lineFor),
            ].join("\n")
          : "No macros saved yet. Author an edit, then save_macro to capture it as a reusable recipe.",
        {
          count: macros.length,
          macros: macros.map((macro) => ({
            id: macro.id,
            name: macro.name,
            blurb: macro.blurb,
            stepCount: macro.steps.length,
            slots: macro.params,
          })),
        },
      );
    },
  },
  {
    name: "save_macro",
    title: "Save a macro",
    description:
      "Save an edit recipe for replay. `steps` is the plan (the same step vocabulary every tool compiles to — see the playbook), with `{{name}}` placeholders for the bits that change each run and `$0`/`$all` to refer to steps the plan creates. `params` declares those slots. Replay with run_macro.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name for the macro." },
        blurb: { type: "string", description: "Short note on what this recipe produces." },
        params: PARAMS_SCHEMA,
        steps: STEPS_SCHEMA,
      },
      required: ["name", "steps"],
      additionalProperties: false,
    },
    annotations: WRITE,
    run: async (args) => {
      const name = (argString(args, "name") ?? "").trim();
      if (!name) return toolError("save_macro needs a name.");
      const steps = args.steps;
      if (!Array.isArray(steps) || !steps.length) return toolError("save_macro needs a non-empty `steps` array.");

      const params = Array.isArray(args.params)
        ? (args.params as { name?: unknown; description?: unknown; required?: unknown; default?: unknown }[])
            .filter((p) => p && typeof p.name === "string" && p.name.length)
            .map((p) => ({
              name: p.name as string,
              description: typeof p.description === "string" ? p.description : undefined,
              required: p.required === true,
              default: typeof p.default === "string" ? p.default : undefined,
            }))
        : [];

      const macro = await saveMacro(name, argString(args, "blurb"), params, steps as Step[]);
      const referenced = macroReferences(steps as Step[]);
      const undeclared = [...referenced].filter((ref) => !params.some((p) => p.name === ref));

      return textResult(
        [
          `Saved macro "${macro.name}" (${macro.id}) — ${steps.length} step(s).`,
          params.length ? `  · slots: ${params.map((p) => p.name).join(", ")}` : "  · no slots — a fixed recipe",
          undeclared.length
            ? `  ! steps reference {{${undeclared.join("}}, {{")}}} but those are not declared in params — add them, or run_macro cannot fill them`
            : "  · all step placeholders are declared",
          `  · replay with run_macro { macro: "${macro.id}", slots: { … } }`,
        ].join("\n"),
        { ok: true, macroId: macro.id, name: macro.name, stepCount: steps.length, slots: params, undeclared },
      );
    },
  },
  {
    name: "get_macro",
    title: "Get a macro's definition",
    description:
      "The full recipe: every step in order and every slot with its description and default. Read this to understand what a saved macro will do before replaying it, or to edit it.",
    inputSchema: {
      type: "object",
      properties: { macro: { type: "string", description: "The macro's id or name." } },
      required: ["macro"],
      additionalProperties: false,
    },
    annotations: READ,
    run: async (args) => {
      const macro = await getMacro(argString(args, "macro") ?? "");
      if (!macro) return toolError("No saved macro by that id or name — list_macros shows them.");
      return textResult(
        [
          `"${macro.name}" (${macro.id}) — ${macro.steps.length} step(s)${macro.blurb ? ` — ${macro.blurb}` : ""}`,
          ...(macro.params.length
            ? [
                "Slots:",
                ...macro.params.map(
                  (p) => `  · ${p.name}${p.required ? " (required)" : ""}${p.default !== undefined ? ` = ${p.default}` : ""}${p.description ? ` — ${p.description}` : ""}`,
                ),
              ]
            : []),
          "Steps:",
          ...macro.steps.map((step, i) => `  ${i}. ${JSON.stringify(step)}`),
        ].join("\n"),
        { macroId: macro.id, name: macro.name, blurb: macro.blurb, params: macro.params, steps: macro.steps },
      );
    },
  },
  {
    name: "run_macro",
    title: "Replay a macro",
    description:
      "Replay a saved recipe by id or name, substituting slot values into its steps, then run the plan as one undo step. Missing required slots and unknown slot names are reported before anything runs. This is the cheap way to repeat an edit: pass the changing bits, not the whole procedure.",
    inputSchema: {
      type: "object",
      properties: {
        macro: { type: "string", description: "The macro's id or name." },
        slots: SLOTS_SCHEMA,
      },
      required: ["macro"],
      additionalProperties: false,
    },
    annotations: WRITE,
    run: async (args) => {
      const macro = await getMacro(argString(args, "macro") ?? "");
      if (!macro) return toolError("No saved macro by that id or name — list_macros shows them.");

      const raw = (args.slots ?? {}) as Record<string, unknown>;
      const slots: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw)) if (value != null) slots[key] = String(value);

      // Defaults fill what the caller left out; required slots are then enforced.
      for (const param of macro.params) {
        if (slots[param.name] === undefined && param.default !== undefined) slots[param.name] = param.default;
      }
      const missing = macro.params.filter((p) => p.required && slots[p.name] === undefined).map((p) => p.name);
      if (missing.length) {
        return toolError(`"${macro.name}" needs ${missing.map((m) => `"${m}"`).join(", ")}.`, { macro: macro.id, missing });
      }

      const referenced = macroReferences(macro.steps);
      const unknown = Object.keys(slots).filter((key) => !referenced.has(key));
      if (unknown.length) {
        return toolError(
          `Unknown slot(s) ${unknown.map((k) => `"${k}"`).join(", ")} — the macro declares: ${
            macro.params.length ? macro.params.map((p) => p.name).join(", ") : "(no slots)"
          }.`,
          { macro: macro.id, unknown },
        );
      }

      const steps = fillSlots(macro.steps, slots);
      return applyPlan(`run_macro(${macro.name})`, steps, {
        notes: [`replayed saved recipe "${macro.name}" (${macro.id})`],
      });
    },
  },
  {
    name: "delete_macro",
    title: "Delete a macro",
    description: "Delete a saved macro permanently. The open project is never affected — a macro is a recipe, not a document.",
    inputSchema: {
      type: "object",
      properties: { macro: { type: "string", description: "The macro's id or name." } },
      required: ["macro"],
      additionalProperties: false,
    },
    annotations: { ...WRITE, destructiveHint: true },
    run: async (args) => {
      const macro = await getMacro(argString(args, "macro") ?? "");
      if (!macro) return toolError("No saved macro by that id or name — list_macros shows them.");
      await deleteMacro(macro.id);
      return textResult(`Deleted macro "${macro.name}" (${macro.id}).`, { ok: true, macroId: macro.id, name: macro.name });
    },
  },
];
