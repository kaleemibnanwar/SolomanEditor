/**
 * PROJECT TOOLS — starting, saving, opening and deleting whole documents.
 *
 * These are the only tools that work at the PROJECT level rather than on the
 * timeline, and they are built differently from every other tool for that
 * reason. A timeline tool compiles a `Step[]` and lets the executor run it:
 * that is what makes a call undoable as one edit. A project tool cannot work
 * that way, because "open another project" is not an edit to this one — it
 * replaces it, and `loadProject` already clears the history that an undo would
 * need. So these call the `lib/projects.ts` functions directly, and report.
 *
 * The media the library holds is Blobs in IndexedDB, so every one of these is
 * asynchronous — a fact the catalogue reflects rather than hides. Three
 * consequences are stated in the responses themselves, because an agent cannot
 * see them and a client would otherwise over-promise:
 *
 *   · a save only survives a reload where IndexedDB exists (`storagePersists`);
 *   · opening or creating REPLACES the open project and clears undo history;
 *   · the project that is open cannot be deleted, because autosave would write
 *     it straight back and the library would appear to disobey.
 */
import {
  createFromTemplate,
  deleteProject,
  listProjectSummaries,
  loadSnapshotTemplate,
  newProject,
  openProject,
  saveProject,
  saveProjectAsCopy,
  storagePersists,
} from "@/lib/projects";
import { TEMPLATES, templateById, templateSummaries } from "@/lib/templates";
import { deleteUserTemplate, getUserTemplate, listUserTemplates, saveUserTemplate } from "@/lib/userTemplates";
import { resetActivityTracking } from "@/lib/mcp/activity";
import { buildProjects, type ProjectListing } from "@/lib/mcp/observe";
import {
  NO_ARGS,
  READ,
  WRITE,
  argBool,
  argString,
  bool,
  choice,
  need,
  object,
  str,
  type ToolDefinition,
} from "@/lib/mcp/kit";
import { textResult, toolError } from "@/lib/mcp/protocol";
import { round } from "@/lib/time";
import { editor } from "@/store/editorStore";

const TEMPLATE_IDS = TEMPLATES.map((template) => template.id);

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** One library row, as `list_projects` renders it. */
const lineFor = (project: ProjectListing): string =>
  [
    `  ${project.isOpen ? "* " : "  "}"${project.name}" — ${project.status}, ${project.clipCount} clip(s), ${Math.round(
      project.duration,
    )}s`,
    `${project.canvas.width}×${project.canvas.height}`,
    `edited ${project.updatedAgo}`,
    `id ${project.id}`,
  ].join(" · ");

/**
 * Resolves a project the caller named by id or by name.
 *
 * Name matching is deliberately generous — an agent that saw "News bulletin" in
 * a list should not have to have copied the id — but never ambiguous: when a
 * name matches several records the caller is told which ones rather than
 * getting whichever happened to sort first.
 */
async function resolveProject(nameOrId: string): Promise<{ id: string; name: string } | { error: string }> {
  const records = await listProjectSummaries();
  if (!records.length) return { error: "The library is empty — there is nothing to open yet." };

  const byId = records.find((record) => record.id === nameOrId);
  if (byId) return { id: byId.id, name: byId.name };

  const lower = nameOrId.trim().toLowerCase();
  const exact = records.filter((record) => record.name.trim().toLowerCase() === lower);
  const matches = exact.length ? exact : records.filter((record) => record.name.toLowerCase().includes(lower));
  if (!matches.length) {
    return {
      error: `No saved project called "${nameOrId}". The library holds: ${records
        .map((record) => `"${record.name}" (${record.id})`)
        .join(", ")}.`,
    };
  }
  if (matches.length > 1) {
    return {
      error: `"${nameOrId}" matches ${matches.length} projects — pass the id instead: ${matches
        .map((record) => `"${record.name}" (${record.id})`)
        .join(", ")}.`,
    };
  }
  return { id: matches[0].id, name: matches[0].name };
}

export const PROJECT_TOOLS: ToolDefinition[] = [
  {
    name: "list_templates",
    title: "List project templates",
    description:
      "The starting points: seven built-in RECIPE templates (a news bulletin, a step-by-step tutorial, a vertical fact list, an infographic explainer, an A-vs-B comparison, a lyric video and a short-form reel) plus any SNAPSHOT templates saved with save_template. A recipe is a structure built fresh from beats and cards; a snapshot is a project's saved rows, overlays, brand, canvas and its changeable slots. Narrow with `section` (\"recipes\" or \"snapshots\") or `id` (a single template, shown in full) to keep the payload small.",
    inputSchema: object({
      id: str("A single template id to show in full — a built-in recipe or a saved snapshot."),
      section: choice("Only one kind of template.", ["recipes", "snapshots"]),
    }),
    annotations: READ,
    run: async (args) => {
      const wanted = argString(args, "id");
      const section = argString(args, "section");
      const templates = templateSummaries();
      const saved = await listUserTemplates();

      if (wanted) {
        const recipe = templates.find((template) => template.id === wanted);
        const snapshot = await getUserTemplate(wanted);
        if (recipe) {
          return textResult(
            `Recipe "${recipe.id}" — ${recipe.name} (${recipe.aspect}, ${recipe.seconds}s${recipe.music ? ", music bed" : ""}): ${recipe.blurb} Use it for: ${recipe.use}. Beats: ${recipe.beats.map((b) => `${b.label} ${b.seconds}s`).join(" → ")}. Rows: ${recipe.rows.join(" / ")}.`,
            { id: recipe.id, kind: "recipe", template: recipe },
          );
        }
        if (snapshot) {
          return textResult(
            [
              `Snapshot "${snapshot.id}" — ${snapshot.name} (${snapshot.project.trackIds.length} row(s))`,
              `  ${snapshot.blurb ?? "no note"}`,
              snapshot.slots?.length
                ? `  slots: ${snapshot.slots.map((s) => `${s.name} (${s.target})`).join(", ")}`
                : "  no declared slots — open it as-is",
              `  open with create_project { snapshot: "${snapshot.id}"${snapshot.slots?.length ? ", slots: { … }" : ""} }`,
            ].join("\n"),
            { id: snapshot.id, kind: "snapshot", name: snapshot.name, blurb: snapshot.blurb, slots: snapshot.slots },
          );
        }
        return toolError(`No template called "${wanted}" — list_templates shows the ids.`);
      }

      const showRecipes = !section || section === "recipes";
      const showSnapshots = !section || section === "snapshots";

      const lines: string[] = [];
      if (showRecipes && showSnapshots) {
        lines.push(`${templates.length} built-in recipe(s) + ${saved.length} saved snapshot(s) — each a structure to edit into, not a finished piece:`);
      } else if (showRecipes) {
        lines.push(`${templates.length} built-in recipe(s):`);
      } else {
        lines.push(`${saved.length} saved snapshot(s):`);
      }

      if (showRecipes) {
        lines.push(
          ...templates.map((template) =>
            [
              `  "${template.id}" — ${template.name} (recipe, ${template.aspect}, ${template.seconds}s${template.music ? ", music bed" : ""})`,
              `    ${template.blurb}`,
              `    use it for: ${template.use}`,
              `    beats: ${template.beats.map((beat) => `${beat.label} ${beat.seconds}s`).join(" → ")}`,
              `    rows: ${template.rows.join(" / ")}`,
            ].join("\n"),
          ),
        );
      }
      if (showSnapshots) {
        lines.push(
          ...saved.map((template) =>
            [
              `  "${template.id}" — ${template.name} (snapshot, ${template.project.trackIds.length} row(s)${template.slots?.length ? `, ${template.slots.length} slot(s)` : ""})`,
              `    ${template.blurb ?? "no note"}`,
              `    a saved project structure — open it with create_project { snapshot: "${template.id}" }`,
            ].join("\n"),
          ),
        );
      }
      lines.push("  create_project takes a built-in id via `template`, a saved snapshot via `snapshot` (plus `slots`), or neither for a blank project.");

      return textResult(
        lines.join("\n"),
        {
          count: templates.length,
          saved: saved.length,
          templates,
          snapshots: saved.map((template) => ({
            id: template.id,
            name: template.name,
            blurb: template.blurb,
            rows: template.project.trackIds.length,
            slots: template.slots,
          })),
        },
      );
    },
  },
  {
    name: "save_template",
    title: "Save the project as a template",
    description:
      "Save the CURRENT project's structure as a reusable SNAPSHOT template: its canvas, background and brand, every row, and the overlay layers (text, sticker, effect). Media clips (video/image/audio) are session-only and are NOT saved, so re-import them with import_media after starting from the snapshot. Optionally declare `slots` — the changeable fields (e.g. the massive word, the lower third) — so a later create_project { snapshot, slots } can fill them instead of rebuilding.",
    inputSchema: object({
      name: str("Name for the template. Defaults to the current project's name."),
      blurb: str("Short note on what this template is for."),
      slots: {
        type: "array",
        description: 'Changeable fields, e.g. [{ "name": "word", "target": "text:OIL", "description": "The massive word" }].',
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            target: { type: "string", description: '"name" (the title), or "text:<layerName>" / "sticker:<layerName>" / "text:*".' },
            description: { type: "string" },
          },
          required: ["name", "target"],
          additionalProperties: true,
        },
      },
    }),
    annotations: WRITE,
    run: async (args) => {
      const name = (argString(args, "name") ?? editor().project.settings.name).trim() || "Untitled template";
      const project = editor().project;
      const overlays = project.layerIds.filter(
        (id) => project.layers[id] && ["text", "sticker", "effect"].includes(project.layers[id].type),
      ).length;

      const slots = Array.isArray(args.slots)
        ? (args.slots as { name?: unknown; target?: unknown; description?: unknown }[])
            .filter((s) => s && typeof s.name === "string" && typeof s.target === "string")
            .map((s) => ({
              name: s.name as string,
              target: s.target as string,
              description: typeof s.description === "string" ? s.description : undefined,
            }))
        : undefined;

      const template = await saveUserTemplate(name, argString(args, "blurb"), project, slots);
      return textResult(
        [
          `Saved snapshot template "${template.name}" (${template.id}).`,
          `  · canvas ${project.settings.width}×${project.settings.height} @ ${project.settings.fps}fps`,
          `  · ${project.trackIds.length} row(s), ${overlays} overlay clip(s) kept`,
          `  · brand: ${project.settings.brandId ?? "none"}`,
          slots?.length ? `  · ${slots.length} slot(s): ${slots.map((s) => s.name).join(", ")}` : "  · no slots declared",
          "  · media clips are dropped — re-import them with import_media once open",
          `  · start from it with create_project { snapshot: "${template.id}"${slots?.length ? ", slots: { … }" : ""} }`,
        ].join("\n"),
        { ok: true, templateId: template.id, name: template.name, rows: project.trackIds.length, overlays, slots },
      );
    },
  },
  {
    name: "get_template",
    title: "Get a template's full definition",
    description:
      "The whole template as JSON: a built-in recipe (its beats, rows and cards) or a saved snapshot (its rows, overlays, brand, canvas and declared slots). Read this to inspect or export a template — list_templates { id } gives the same in a compact line.",
    inputSchema: object({ id: str("The template id — a recipe or a saved snapshot.") }, ["id"]),
    annotations: READ,
    run: async (args) => {
      const id = need(args, "id");
      const recipe = templateById(id);
      if (recipe) {
        return textResult(`Recipe "${recipe.id}" — ${recipe.name}. Full definition in the structured payload.`, {
          id: recipe.id,
          kind: "recipe",
          template: recipe,
        });
      }
      const snapshot = await getUserTemplate(id);
      if (!snapshot) return toolError(`No template called "${id}" — list_templates shows the ids.`);
      return textResult(
        `Snapshot "${snapshot.id}" — ${snapshot.name}, ${snapshot.project.trackIds.length} row(s). Full project in the structured payload.`,
        { id: snapshot.id, kind: "snapshot", name: snapshot.name, blurb: snapshot.blurb, slots: snapshot.slots, project: snapshot.project },
      );
    },
  },
  {
    name: "delete_template",
    title: "Delete a saved template",
    description:
      "Delete a saved snapshot template permanently. Built-in recipes cannot be deleted (they are code, not data). The open project is never affected.",
    inputSchema: object({ id: str("The snapshot template id to delete.") }, ["id"]),
    annotations: { ...WRITE, destructiveHint: true },
    run: async (args) => {
      const id = need(args, "id");
      const snapshot = await getUserTemplate(id);
      if (!snapshot) return toolError(`No saved snapshot called "${id}" — built-in recipes cannot be deleted.`);
      await deleteUserTemplate(id);
      return textResult(`Deleted snapshot template "${snapshot.name}" (${id}).`, { ok: true, templateId: id, name: snapshot.name });
    },
  },
  {
    name: "list_projects",
    title: "List saved projects",
    description:
      "The saved work: each project's name, status, clip count, duration, canvas, when it was last edited and its id. A project is saved automatically a couple of seconds after any edit, so this is usually current. Status is derived from what actually happened — \"empty\" has no clips, \"processing\" has clips but no finished render, \"ready\" has had one.",
    inputSchema: NO_ARGS,
    annotations: READ,
    run: async () => {
      const library = await buildProjects(editor());
      const { projects, persistent } = library;

      return textResult(
        projects.length
          ? [
              `${projects.length} saved project(s), most recently edited first. The one marked * is open now.`,
              ...projects.map((project) => lineFor(project)),
              persistent ? "" : "  ! this browser has no IndexedDB here — these saves will not survive a reload",
            ]
              .filter(Boolean)
              .join("\n")
          : "No projects have been saved yet. list_templates shows the starting points, and any edit will save the open project automatically.",
        { ...library },
      );
    },
  },
  {
    name: "create_project",
    title: "Start a project",
    description:
      "Replace the open project with a new one — from a built-in template id (`template`), a saved snapshot (`snapshot`, both from list_templates), or blank when neither is given — and save it to the library. THIS REPLACES WHAT IS OPEN and clears the undo history: the project you were editing has already been autosaved, so it is in list_projects, but nothing here can undo the swap. Use it to begin work, not to experiment on someone's cut.",
    inputSchema: object({
      template: choice("A built-in recipe template id from list_templates. Omit for a blank project.", TEMPLATE_IDS),
      snapshot: str("A saved snapshot template id from list_templates. Mutually exclusive with `template`."),
      name: str("Name for the new project. Defaults to the template's name, or \"Untitled project\"."),
      music: bool("Render the procedural music bed onto the music row. Defaults to whatever the template asks for."),
      slots: {
        type: "object",
        description: "Values for the snapshot's declared slots, e.g. { \"word\": \"IRAN\" }. See list_templates { id } for the slot names.",
        additionalProperties: true,
      },
    }),
    annotations: WRITE,
    run: async (args) => {
      const templateId = argString(args, "template");
      const snapshotId = argString(args, "snapshot");
      const name = argString(args, "name");
      const before = editor().project.settings.name;

      if (templateId && snapshotId) {
        return toolError("Give either `template` (a built-in recipe) or `snapshot` (a saved snapshot), not both.");
      }

      if (!templateId && !snapshotId) {
        const canvas = editor().project.settings;
        newProject(name ?? "Untitled project");
        resetActivityTracking();
        return textResult(
          [
            `Started a blank project "${editor().project.settings.name}" (${canvas.width}×${canvas.height} @ ${canvas.fps}fps).`,
            `  · replaced "${before}" — it was autosaved to the library, and undo history went with the old project`,
            "  · nothing is on the timeline yet, so there is nothing to save: it joins the library once there is a first clip",
            "  · list_assets shows the media available, or create_project with a template id gives you a structure",
          ].join("\n"),
          {
            ok: true,
            projectId: editor().project.id,
            name: editor().project.settings.name,
            templateId: null,
            saved: false,
            replaced: before,
            canvas: { width: canvas.width, height: canvas.height, fps: canvas.fps },
          },
        );
      }

      if (snapshotId) {
        let record;
        try {
          const slots: Record<string, string> = {};
          const rawSlots = (args.slots ?? {}) as Record<string, unknown>;
          for (const [key, value] of Object.entries(rawSlots)) if (value != null) slots[key] = String(value);
          record = await loadSnapshotTemplate(snapshotId, { name, slots });
        } catch (error) {
          return toolError(`The snapshot could not be opened: ${describe(error)}`);
        }
        if (!record) return toolError(`No saved snapshot template called "${snapshotId}" — list_templates shows the ids.`);

        resetActivityTracking();
        const settings = editor().project.settings;
        return textResult(
          [
            `Opened snapshot template into "${record.name}" — ${editor().project.trackIds.length} row(s), ${editor().project.layerIds.length} clip(s).`,
            `  · canvas ${settings.width}×${settings.height} @ ${settings.fps}fps`,
            `  · replaced "${before}" — it was autosaved to the library, and undo history went with the old project`,
            `  · brand: ${settings.brandId ?? "none"} — set_brand can change it`,
            "  · media clips are not in a snapshot: import_media brings them in",
          ].join("\n"),
          {
            ok: true,
            projectId: record.id,
            name: record.name,
            snapshotId,
            saved: true,
            replaced: before,
            rows: editor().project.trackIds.length,
            canvas: { width: settings.width, height: settings.height, fps: settings.fps },
          },
        );
      }

      const spec = templateById(templateId);
      if (!spec) return toolError(`No template called "${templateId}" — list_templates shows the ids.`);

      let built;
      try {
        built = await createFromTemplate(spec, { name, music: argBool(args, "music") });
      } catch (error) {
        return toolError(`The project could not be built: ${describe(error)}`);
      }
      if (!built) return toolError(`No template called "${templateId}" — list_templates shows the ids.`);

      resetActivityTracking();
      const { record, built: project } = built;
      const settings = editor().project.settings;

      return textResult(
        [
          `Created "${record?.name ?? settings.name}" from the "${spec.name}" template — ${Math.round(
            record?.duration ?? project.duration,
          )}s, ${editor().project.layerIds.length} clip(s) on ${editor().project.trackIds.length} row(s).`,
          `  · canvas ${settings.width}×${settings.height} @ ${settings.fps}fps (${spec.aspect})`,
          `  · replaced "${before}" — it was autosaved to the library, and undo history went with the old project`,
          ...project.notes.map((note) => `  · ${note}`),
          `  · rows top to bottom: ${project.rows.join(" / ")}`,
          `  · saved to the library as ${record ? `"${record.name}" (${record.id})` : "(not saved)"}`,
          "  · get_timeline shows the beat cards and the seams between them",
        ].join("\n"),
        {
          ok: true,
          projectId: record?.id ?? editor().project.id,
          name: record?.name ?? settings.name,
          templateId: spec.id,
          saved: !!record,
          replaced: before,
          duration: round(record?.duration ?? project.duration, 3),
          rows: project.rows,
          notes: project.notes,
        },
      );
    },
  },
  {
    name: "open_project",
    title: "Open a saved project",
    description:
      "Replace the open project with a saved one, named by id or by name. THIS REPLACES WHAT IS OPEN and clears the undo history. Anything already saved is safe — the open project is flushed to the library first — so what is lost is only the ability to undo back into the project you left.",
    inputSchema: object(
      { project: str("The project's id, or its name — a partial name works as long as it is unambiguous.") },
      ["project"],
    ),
    annotations: WRITE,
    run: async (args) => {
      const wanted = argString(args, "project") ?? "";
      const resolved = await resolveProject(wanted);
      if ("error" in resolved) return toolError(resolved.error);

      const before = editor().project.settings.name;
      const alreadyOpen = resolved.id === editor().project.id;

      let record;
      try {
        record = await openProject(resolved.id);
      } catch (error) {
        return toolError(`"${resolved.name}" could not be opened: ${describe(error)}`);
      }
      if (!record) return toolError(`"${resolved.name}" is no longer in the library — call list_projects for what is there.`);

      resetActivityTracking();
      const settings = editor().project.settings;
      return textResult(
        [
          `Opened "${record.name}" — ${record.clipCount} clip(s), ${round(record.duration, 2)}s, ${settings.width}×${settings.height} @ ${settings.fps}fps.`,
          `  · status ${record.status}${record.exported ? `, last render "${record.exported.name}"` : ""}`,
          `  · ${record.assetIds.length} asset(s) restored with it`,
          alreadyOpen
            ? "  · this was already the open project, so this reloaded it from the library and cleared the undo history"
            : `  · replaced "${before}" — it was autosaved first, and undo history went with the old project`,
          "  · get_timeline shows the rows and clips",
        ].join("\n"),
        {
          ok: true,
          projectId: record.id,
          name: record.name,
          status: record.status,
          clipCount: record.clipCount,
          duration: round(record.duration, 3),
          trackCount: record.trackCount,
          assetCount: record.assetIds.length,
          replaced: alreadyOpen ? null : before,
        },
      );
    },
  },
  {
    name: "save_project",
    title: "Save the project",
    description:
      "Write the open project to the library now, rather than waiting for the autosave that follows each edit. Pass a name to rename it as it saves, or copy: true to save under a NEW id and leave the original alone — after which autosave keeps the copy up to date and the original stops receiving edits. Media is written with the document, so a reopened project plays real footage.",
    inputSchema: object({
      name: str("Rename the project while saving. Updates the document's name as well as the library record's."),
      copy: bool("Save as a copy under a new id and name, leaving the original record untouched."),
    }),
    annotations: WRITE,
    run: async (args) => {
      const name = argString(args, "name");
      const asCopy = argBool(args, "copy") ?? false;
      const project = editor().project;

      if (!project.layerIds.length) {
        return toolError(
          "There is nothing on the timeline to save — an empty project is not written to the library, because a record with no clips in it says nothing.",
        );
      }

      if (name) editor().updateSettings({ name });

      let record;
      try {
        record = asCopy ? await saveProjectAsCopy(name) : await saveProject({ name, capturePoster: true });
      } catch (error) {
        return toolError(`The save did not go through: ${describe(error)}`);
      }
      if (!record) return toolError("The save did not go through — the browser refused the write. Nothing was lost from the open project.");

      const persistent = await storagePersists();
      return textResult(
        [
          asCopy ? `Saved the copy "${record.name}" (${record.id}).` : `Saved "${record.name}" (${record.id}).`,
          `  · ${record.clipCount} clip(s), ${record.trackCount} row(s), ${round(record.duration, 2)}s, status ${record.status}`,
          `  · ${record.assetIds.length} asset(s) written alongside the document`,
          asCopy
            ? "  · autosave now keeps THIS copy up to date; the project it came from is left as it was"
            : "  · this is the record autosave writes to from here on",
          persistent
            ? "  · held in this browser's IndexedDB, so it survives a reload"
            : "  ! this browser has no IndexedDB here, so the save lasts only for this session",
        ].join("\n"),
        {
          ok: true,
          projectId: record.id,
          name: record.name,
          status: record.status,
          clipCount: record.clipCount,
          trackCount: record.trackCount,
          duration: round(record.duration, 3),
          assetCount: record.assetIds.length,
          copied: asCopy,
          persistent,
        },
      );
    },
  },
  {
    name: "delete_project",
    title: "Delete a saved project",
    description:
      "Delete a saved project from the library, named by id or by name. This is permanent — there is no undo, and the project's media is dropped with it once no other project refers to it. The project currently open cannot be deleted, because autosave would write it straight back.",
    inputSchema: object(
      { project: str("The project's id, or its name — a partial name works as long as it is unambiguous.") },
      ["project"],
    ),
    annotations: { ...WRITE, destructiveHint: true },
    run: async (args) => {
      const wanted = argString(args, "project") ?? "";
      const resolved = await resolveProject(wanted);
      if ("error" in resolved) return toolError(resolved.error);

      if (resolved.id === editor().project.id) {
        return toolError(
          `"${resolved.name}" is the project that is open, so it cannot be deleted — autosave would write it straight back. Open another project first (open_project), or start a blank one (create_project).`,
        );
      }

      try {
        await deleteProject(resolved.id);
      } catch (error) {
        return toolError(`"${resolved.name}" could not be deleted: ${describe(error)}`);
      }

      const remaining = await listProjectSummaries();
      return textResult(
        `Deleted "${resolved.name}" (${resolved.id}). ${remaining.length} project(s) left in the library. Its media was dropped with it, unless another project still refers to the same asset.`,
        { ok: true, deleted: { id: resolved.id, name: resolved.name }, remaining: remaining.length },
      );
    },
  },
];
