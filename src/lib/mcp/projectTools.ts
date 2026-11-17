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
  deleteProject,
  listProjectSummaries,
  newProject,
  openProject,
  saveProject,
  saveProjectAsCopy,
  storagePersists,
} from "@/lib/projects";
import { resetActivityTracking } from "@/lib/mcp/activity";
import { buildProjects, type ProjectListing } from "@/lib/mcp/observe";
import {
  NO_ARGS,
  READ,
  WRITE,
  argBool,
  argString,
  bool,
  need,
  object,
  str,
  type ToolDefinition,
} from "@/lib/mcp/kit";
import { textResult, toolError } from "@/lib/mcp/protocol";
import { round } from "@/lib/time";
import { editor } from "@/store/editorStore";

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
    name: "list_projects",
    title: "List saved projects",
    description:
      "Show every project in the local library. Each row is one saved document with its status (empty / processing / ready), its clip count, its canvas size, and whether it is the one currently open (marked with *). Use this before opening or deleting to confirm the id.",
    inputSchema: NO_ARGS,
    annotations: READ,
    run: async () => {
      const library = await buildProjects(editor());
      if (!library.projects.length) return textResult("The library is empty — there are no saved projects yet.", { ok: true, projects: [] });

      const open = library.projects.find((project) => project.isOpen);
      const header = open
        ? `The library holds ${library.count} project(s). The open project is "${open.name}" (${open.id}).`
        : `The library holds ${library.count} project(s). No project is currently open.`;

      return textResult(
        `${header}\n\n${library.projects.map(lineFor).join("\n")}`,
        {
          ok: true,
          count: library.count,
          openId: open?.id ?? null,
          projects: library.projects.map((project) => ({
            id: project.id,
            name: project.name,
            status: project.status,
            clipCount: project.clipCount,
            duration: round(project.duration, 3),
            canvas: project.canvas,
            isOpen: project.isOpen,
            updatedAgo: project.updatedAgo,
          })),
        },
      );
    },
  },
  {
    name: "open_project",
    title: "Open a saved project",
    description:
      "Replace the open project with one from the library, named by id or by name. This clears undo history — the project you were editing is not lost (it is still in the library if it was saved), but you cannot undo back into it from the new one. The project that is open is marked with * in list_projects.",
    inputSchema: object(
      { project: str("The project's id, or its name — a partial name works as long as it is unambiguous.") },
      ["project"],
    ),
    annotations: WRITE,
    run: async (args) => {
      const wanted = argString(args, "project") ?? "";
      const resolved = await resolveProject(wanted);
      if ("error" in resolved) return toolError(resolved.error);

      const record = await openProject(resolved.id);
      if (!record) return toolError(`"${resolved.name}" could not be opened — it may have been deleted.`);

      resetActivityTracking();

      return textResult(
        `Opened "${record.name}" (${record.id}). It has ${record.clipCount} clip(s) across ${record.trackCount} row(s), ${round(record.duration, 3)}s long. Undo history was cleared for the switch.`,
        {
          ok: true,
          projectId: record.id,
          name: record.name,
          status: record.status,
          clipCount: record.clipCount,
          trackCount: record.trackCount,
          duration: round(record.duration, 3),
        },
      );
    },
  },
  {
    name: "new_project",
    title: "Start a blank project",
    description:
      "Replace the open project with a fresh, empty one. The canvas size carries over from the project you were editing — change it with set_canvas if you need a different aspect. The previous project is not deleted; if it was saved it is still in the library.",
    inputSchema: object({ name: str("A name for the new project. Defaults to \"Untitled project\".") }),
    annotations: WRITE,
    run: async (args) => {
      const name = argString(args, "name") ?? "Untitled project";
      newProject(name);
      resetActivityTracking();
      const { project } = editor();
      return textResult(
        `Started a blank project called "${name}" (${project.id}). Canvas is ${project.settings.width}×${project.settings.height} at ${project.settings.fps}fps. Undo history was cleared for the switch.`,
        {
          ok: true,
          projectId: project.id,
          name,
          canvas: { width: project.settings.width, height: project.settings.height, fps: project.settings.fps },
        },
      );
    },
  },
  {
    name: "save_project",
    title: "Save the open project",
    description:
      "Write the open project to the local library. A save is an upsert: the first save creates the record and every later one updates it in place, because the record's id is the project's own id. Pass `as_copy: true` to save under a new id instead, leaving the original record untouched. A save only survives a reload where IndexedDB is available (check with `storage_persists`).",
    inputSchema: object({
      name: str("Override the project's name on the record. Leave blank to use the project's own name."),
      as_copy: bool("Save as a new record instead of updating the existing one. Defaults to false."),
    }),
    annotations: WRITE,
    run: async (args) => {
      const name = argString(args, "name");
      const asCopy = argBool(args, "as_copy");

      const record = asCopy ? await saveProjectAsCopy(name) : await saveProject({ name, capturePoster: true });
      if (!record) return toolError("The save did not produce a record — the library may be unavailable.");

      const persistent = await storagePersists();

      return textResult(
        [
          `Saved "${record.name}" (${record.id}) — ${record.status}, ${record.clipCount} clip(s), ${round(record.duration, 3)}s.`,
          asCopy
            ? "  · this is a new record; the project it came from is left as it was"
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
          `"${resolved.name}" is the project that is open, so it cannot be deleted — autosave would write it straight back. Open another project first (open_project), or start a blank one (new_project).`,
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
