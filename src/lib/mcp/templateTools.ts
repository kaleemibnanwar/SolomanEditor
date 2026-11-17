/**
 * TEMPLATE TOOLS — saving and reusing project structures over MCP.
 *
 * The editor ships with NO built-in templates: every template is a SNAPSHOT
 * the agent or the user saved from a project they already arranged (see
 * `lib/userTemplates.ts`). These tools are the whole template surface — there
 * is no template UI — so an agent can bank a look it built once (rows, titles,
 * overlays, brand, canvas) and start the next piece from it instead of
 * rebuilding from scratch.
 *
 * A snapshot keeps structure only: media clips are session-bound Blobs and are
 * dropped, so `create_from_template` opens the rows and overlays and the agent
 * brings footage back with `import_media`. Declared `slots` are the MOGRT-style
 * essential controls — the handful of fields (a headline, a lower third, a
 * brand colour) a later create fills without touching anything else.
 *
 * Like the project tools, these call the library functions directly rather
 * than compiling steps: creating from a template REPLACES the open project,
 * which is not an undoable edit to this one.
 */
import { loadSnapshotTemplate, storagePersists } from "@/lib/projects";
import {
  deleteUserTemplate,
  getUserTemplate,
  listUserTemplates,
  saveUserTemplate,
  type TemplateSlot,
} from "@/lib/userTemplates";
import { resetActivityTracking } from "@/lib/mcp/activity";
import { READ, WRITE, argString, need, object, str, type ToolDefinition } from "@/lib/mcp/kit";
import { textResult, toolError } from "@/lib/mcp/protocol";
import { editor } from "@/store/editorStore";

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One saved snapshot, as `list_templates` renders it. */
const lineFor = (template: Awaited<ReturnType<typeof listUserTemplates>>[number]): string =>
  [
    `  "${template.id}" — ${template.name} (${template.project.trackIds.length} row(s), ${template.project.layerIds.length} overlay clip(s)${template.slots?.length ? `, ${template.slots.length} slot(s)` : ""})`,
    `    ${template.blurb ?? "no note"}`,
    template.slots?.length
      ? `    slots: ${template.slots.map((slot) => `${slot.name} → ${slot.target}`).join(", ")}`
      : "    no declared slots — open it as-is",
  ].join("\n");

/** Reads the `slots` argument of save_template into validated slot definitions. */
function readSlots(raw: unknown): { slots?: TemplateSlot[]; error?: string } {
  if (raw === undefined) return {};
  if (!Array.isArray(raw)) return { error: "`slots` must be an array of { name, target, description? } objects." };
  const slots: TemplateSlot[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return { error: "Each slot must be an object with `name` and `target`." };
    const { name, target, description } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim()) return { error: "Each slot needs a non-empty `name`." };
    if (typeof target !== "string" || !target.trim()) {
      return { error: `Slot "${name}" needs a \`target\`: "name", "text:<layer name>", "sticker:<layer name>", or "<type>:*".` };
    }
    slots.push({ name: name.trim(), target: target.trim(), description: typeof description === "string" ? description : undefined });
  }
  return { slots: slots.length ? slots : undefined };
}

/** Reads the `slots` argument of create_from_template into string values. */
function readSlotValues(raw: unknown): Record<string, string> {
  const values: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value != null) values[key] = String(value);
    }
  }
  return values;
}

export const TEMPLATE_TOOLS: ToolDefinition[] = [
  {
    name: "list_templates",
    title: "List saved templates",
    description:
      "The saved SNAPSHOT templates — project structures banked with save_template. There are no built-in templates: this list only holds what the agent or user saved. Each row shows its rows, overlay clips and declared slots. Pass `id` to see one in full. Start from one with create_from_template.",
    inputSchema: object({
      id: str("A single template id (or exact name) to show in full."),
    }),
    annotations: READ,
    run: async (args) => {
      const wanted = argString(args, "id");
      if (wanted) {
        const template = await getUserTemplate(wanted);
        if (!template) return toolError(`No template called "${wanted}" — list_templates shows the ids.`);
        const settings = template.project.settings;
        return textResult(
          [
            `Snapshot "${template.id}" — ${template.name}`,
            `  ${template.blurb ?? "no note"}`,
            `  canvas ${settings.width}×${settings.height} @ ${settings.fps}fps · brand ${settings.brandId ?? "none"}`,
            `  rows: ${template.project.trackIds.map((id) => template.project.tracks[id]?.name ?? id).join(" / ")}`,
            template.slots?.length
              ? `  slots: ${template.slots.map((slot) => `${slot.name} → ${slot.target}${slot.description ? ` (${slot.description})` : ""}`).join(", ")}`
              : "  no declared slots — open it as-is",
            `  open with create_from_template { template: "${template.id}"${template.slots?.length ? ", slots: { … }" : ""} }`,
          ].join("\n"),
          {
            ok: true,
            id: template.id,
            name: template.name,
            blurb: template.blurb,
            canvas: { width: settings.width, height: settings.height, fps: settings.fps },
            rows: template.project.trackIds.length,
            overlays: template.project.layerIds.length,
            slots: template.slots ?? [],
          },
        );
      }

      const templates = await listUserTemplates();
      if (!templates.length) {
        return textResult(
          "No templates saved yet. Arrange a project the way you want it, then save_template banks its rows, overlays, brand and canvas as a reusable starting point. Media clips are not saved — import_media brings them back.",
          { ok: true, count: 0, templates: [] },
        );
      }
      return textResult(
        `${templates.length} saved snapshot template(s):\n${templates.map(lineFor).join("\n")}\n  create_from_template { template } opens one as a fresh project.`,
        {
          ok: true,
          count: templates.length,
          templates: templates.map((template) => ({
            id: template.id,
            name: template.name,
            blurb: template.blurb,
            rows: template.project.trackIds.length,
            overlays: template.project.layerIds.length,
            slots: template.slots ?? [],
          })),
        },
      );
    },
  },
  {
    name: "save_template",
    title: "Save the project as a template",
    description:
      "Save the CURRENT project's structure as a reusable SNAPSHOT template: its canvas, background and brand, every row, and the overlay layers (text, sticker, effect). Media clips (video/image/audio) are session-only and are NOT saved — re-import them with import_media after starting from the snapshot. Optionally declare `slots`, the changeable fields (a headline, a lower third, a brand colour), so a later create_from_template can fill them without rebuilding. The open project is not modified.",
    inputSchema: object({
      name: str("Name for the template. Defaults to the current project's name."),
      blurb: str("Short note on what this template is for."),
      slots: {
        type: "array",
        description:
          'Changeable fields, e.g. [{ "name": "headline", "target": "text:Title", "description": "the big word" }]. A target is "name" (project title), "text:<layer name>" (its content), "sticker:<layer name>" (its fill), or "text:*" / "sticker:*" for every layer of that type.',
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "The slot's key in create_from_template's `slots` object." },
            target: { type: "string", description: 'What it writes: "name", "text:<layer name>", "sticker:<layer name>", "text:*" or "sticker:*".' },
            description: { type: "string", description: "What this field is for, shown by list_templates." },
          },
          required: ["name", "target"],
        },
      },
    }),
    annotations: WRITE,
    run: async (args) => {
      const project = editor().project;
      if (!project.layerIds.length) {
        return toolError("The project is empty — there is no structure to save. Add rows and overlays first.");
      }
      const { slots, error } = readSlots(args.slots);
      if (error) return toolError(error);

      const name = argString(args, "name")?.trim() || project.settings.name;
      let template;
      try {
        template = await saveUserTemplate(name, argString(args, "blurb"), project, slots);
      } catch (err) {
        return toolError(`The template could not be saved: ${describe(err)}`);
      }

      const overlays = template.project.layerIds.length;
      const dropped = project.layerIds.length - overlays;
      return textResult(
        [
          `Saved template "${template.name}" (${template.id}) — ${template.project.trackIds.length} row(s), ${overlays} overlay clip(s).`,
          dropped > 0 ? `  · ${dropped} media clip(s) were left out — snapshots keep structure only; import_media brings footage back` : "  · no media clips to leave out",
          slots?.length ? `  · slots: ${slots.map((slot) => `${slot.name} → ${slot.target}`).join(", ")}` : "  · no slots declared — it will open as-is",
          storagePersists()
            ? "  · held in this browser's storage, so it survives a reload"
            : "  ! this browser has no durable storage here, so the template lasts only for this session",
          `  · open it with create_from_template { template: "${template.id}"${slots?.length ? ", slots: { … }" : ""} }`,
        ].join("\n"),
        { ok: true, templateId: template.id, name: template.name, rows: template.project.trackIds.length, overlays, dropped, slots: slots ?? [] },
      );
    },
  },
  {
    name: "get_template",
    title: "Get a template's full definition",
    description:
      "The whole saved snapshot as JSON: its rows, overlay layers, brand, canvas and declared slots. Read this to inspect exactly what a template will open, or to copy its structure into another tool. list_templates { id } gives the same in a compact line.",
    inputSchema: object({ id: str("The template id, or its exact name.") }, ["id"]),
    annotations: READ,
    run: async (args) => {
      const id = need(args, "id");
      const template = await getUserTemplate(id);
      if (!template) return toolError(`No template called "${id}" — list_templates shows the ids.`);
      return textResult(
        `Snapshot "${template.id}" — ${template.name}, ${template.project.trackIds.length} row(s). Full project in the structured payload.`,
        {
          ok: true,
          id: template.id,
          name: template.name,
          blurb: template.blurb,
          slots: template.slots ?? [],
          project: template.project,
        },
      );
    },
  },
  {
    name: "delete_template",
    title: "Delete a saved template",
    description:
      "Delete a saved snapshot template permanently. There is no undo. Projects already created from it are unaffected — a snapshot is a starting point, not a link.",
    inputSchema: object({ id: str("The template id to delete, from list_templates.") }, ["id"]),
    annotations: { ...WRITE, destructiveHint: true },
    run: async (args) => {
      const id = need(args, "id");
      const template = await getUserTemplate(id);
      if (!template) return toolError(`No template called "${id}" — list_templates shows the ids.`);
      try {
        await deleteUserTemplate(template.id);
      } catch (err) {
        return toolError(`The template could not be deleted: ${describe(err)}`);
      }
      return textResult(`Deleted template "${template.name}" (${template.id}). Projects created from it are unaffected.`, {
        ok: true,
        templateId: template.id,
        name: template.name,
      });
    },
  },
  {
    name: "create_from_template",
    title: "Start a project from a template",
    description:
      "Replace the open project with a fresh one built from a saved snapshot template (from list_templates), fill its declared `slots`, and save it to the library. THIS REPLACES WHAT IS OPEN and clears undo history — the outgoing project is autosaved first, so it stays in list_projects. Media clips are not in a snapshot: import_media brings them in afterwards. For a blank project use new_project instead.",
    inputSchema: object({
      template: str("The snapshot template id (or exact name) from list_templates."),
      name: str("Name for the new project. Defaults to the template's name."),
      slots: {
        type: "object",
        description: 'Values for the template\'s declared slots, e.g. { "headline": "BREAKING" }. list_templates { id } shows the slot names; unmatched keys are reported, not silently dropped.',
        additionalProperties: true,
      },
    }, ["template"]),
    annotations: WRITE,
    run: async (args) => {
      const wanted = need(args, "template");
      const name = argString(args, "name");
      const values = readSlotValues(args.slots);
      const before = editor().project.settings.name;

      const template = await getUserTemplate(wanted);
      if (!template) return toolError(`No template called "${wanted}" — list_templates shows the ids.`);

      // Report slot keys the template never declared, rather than letting the
      // caller believe an override landed when it matched nothing.
      const declared = new Set((template.slots ?? []).map((slot) => slot.name));
      const unknown = Object.keys(values).filter((key) => !declared.has(key));

      let record;
      try {
        record = await loadSnapshotTemplate(template.id, { name, slots: values });
      } catch (err) {
        return toolError(`The template could not be opened: ${describe(err)}`);
      }
      if (!record) return toolError(`No template called "${wanted}" — list_templates shows the ids.`);

      resetActivityTracking();
      const settings = editor().project.settings;
      return textResult(
        [
          `Opened template "${template.name}" into "${record.name}" (${record.id}) — ${editor().project.trackIds.length} row(s), ${editor().project.layerIds.length} overlay clip(s).`,
          `  · canvas ${settings.width}×${settings.height} @ ${settings.fps}fps · brand ${settings.brandId ?? "none"}`,
          `  · replaced "${before}" — it was autosaved to the library, and undo history went with the old project`,
          Object.keys(values).length ? `  · slots filled: ${Object.keys(values).filter((key) => declared.has(key)).join(", ") || "none"}` : "  · no slot values given — opened as saved",
          ...(unknown.length ? [`  ! unknown slot key(s) ignored: ${unknown.join(", ")} — list_templates { id: "${template.id}" } shows the declared slots`] : []),
          "  · media clips are not in a snapshot: import_media brings them in",
        ].join("\n"),
        {
          ok: true,
          projectId: record.id,
          name: record.name,
          templateId: template.id,
          replaced: before,
          rows: editor().project.trackIds.length,
          overlays: editor().project.layerIds.length,
          slotsApplied: Object.keys(values).filter((key) => declared.has(key)),
          slotsUnknown: unknown,
          canvas: { width: settings.width, height: settings.height, fps: settings.fps },
        },
      );
    },
  },
];

