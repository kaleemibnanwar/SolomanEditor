/**
 * THE PROJECT LIBRARY, AS THE UI NEEDS IT — the list, and the actions on it.
 *
 * The work itself is in `lib/projects.ts`. This is the React-shaped layer over
 * it: one place holding the summaries, one place reloading them after a change,
 * and one place turning a failed write into a message instead of a silent
 * no-op.
 *
 * The list is RE-READ after every action rather than patched in memory. A record
 * is not one value: its status is derived from the export queue and its poster
 * comes from a render, so a local patch could say "ready" about something that
 * has never been rendered.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { resetActivityTracking } from "@/lib/mcp/activity";
import {
  createFromTemplate,
  deleteProject,
  duplicateProject,
  listProjectSummaries,
  loadSnapshotTemplate,
  newProject,
  openProject,
  saveProject,
  saveProjectAsCopy,
  storagePersists,
  type ProjectRecord,
  type ProjectSummary,
} from "@/lib/projects";
import { deleteUserTemplate, listUserTemplates, saveUserTemplate, type UserTemplate } from "@/lib/userTemplates";
import { editor, useEditor } from "@/store/editorStore";

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Save the live project and say so — shared by the top bar and ⌘S. */
export async function saveProjectNow(): Promise<ProjectRecord | null> {
  try {
    const record = await saveProject({ capturePoster: true });
    toast.success("Project saved", {
      description: `${record.name} · ${record.clipCount} ${record.clipCount === 1 ? "clip" : "clips"} · ${Math.round(record.duration)}s`,
    });
    return record;
  } catch (error) {
    toast.error("That save did not go through", { description: describe(error) });
    return null;
  }
}

export function useProjectLibrary(open: boolean) {
  const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
  const [userTemplates, setUserTemplates] = useState<UserTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  /** Whether a write made here survives a reload, or only lasts this session. */
  const [persistent, setPersistent] = useState(true);
  /** The action in flight, as a key the buttons can compare against. */
  const [busy, setBusy] = useState<string | null>(null);
  const currentId = useEditor((s) => s.project.id);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [records, templates, persists] = await Promise.all([listProjectSummaries(), listUserTemplates(), storagePersists()]);
      setSummaries(records);
      setUserTemplates(templates);
      setPersistent(persists);
    } finally {
      setLoading(false);
    }
  }, []);

  /** Read the library as soon as the dialog opens, so it is never stale. */
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  /**
   * Runs one action, then re-reads the list and says what happened. `work`
   * returns the line to report, or nothing when it has already reported itself.
   *
   * The outcome is returned as well as reported, so a caller can act on success
   * — closing the dialog because a template opened, say — without having to
   * tell a failure from a success by inspecting its own state.
   */
  const run = useCallback(
    async (key: string, work: () => Promise<string | void>): Promise<{ ok: boolean }> => {
      setBusy(key);
      try {
        const message = await work();
        await refresh();
        if (message) toast.success(message);
        return { ok: true };
      } catch (error) {
        toast.error("That did not work", { description: describe(error) });
        return { ok: false };
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const createTemplate = useCallback(
    (templateId: string) =>
      run(`template:${templateId}`, async () => {
        const result = await createFromTemplate(templateId);
        if (!result) throw new Error(`There is no template called “${templateId}”.`);
        resetActivityTracking();
        return result.built.notes[0] ?? `${result.record?.name ?? "The project"} is ready to edit.`;
      }),
    [run],
  );

  const openSnapshotTemplate = useCallback(
    (snapshotId: string) =>
      run(`snapshot:${snapshotId}`, async () => {
        const result = await loadSnapshotTemplate(snapshotId);
        if (!result) throw new Error(`There is no snapshot called “${snapshotId}”.`);
        resetActivityTracking();
        return `Opened ${result.name} and ready to edit.`;
      }),
    [run],
  );

  const openSaved = useCallback(
    (id: string) =>
      run(`open:${id}`, async () => {
        const record = await openProject(id);
        if (!record) throw new Error("That project is no longer in the library.");
        resetActivityTracking();
        return `${record.name} opened.`;
      }),
    [run],
  );

  const duplicate = useCallback(
    (id: string) =>
      run(`copy:${id}`, async () => {
        const record = await duplicateProject(id);
        if (!record) throw new Error("That project is no longer in the library.");
        return `${record.name} added to the library.`;
      }),
    [run],
  );

  const remove = useCallback(
    (id: string) =>
      run(`delete:${id}`, async () => {
        // The one record that cannot be deleted is the one being edited: it does
        // not actually live in the library yet so much as mirror the open
        // project, and autosave would write it straight back.
        if (id === currentId) throw new Error("This is the project that is open — open another one first.");
        await deleteProject(id);
        return "Project deleted.";
      }),
    [currentId, run],
  );

  const saveCurrent = useCallback(() => run("save", async () => void (await saveProjectNow())), [run]);

  const saveCopy = useCallback(
    () =>
      run("save-copy", async () => {
        const record = await saveProjectAsCopy();
        if (!record) throw new Error("The copy could not be written.");
        return `Saved as ${record.name} — autosave now keeps the copy up to date, not the original.`;
      }),
    [run],
  );

  const saveAsTemplate = useCallback(
    () =>
      run("save-template", async () => {
        const project = editor().project;
        const template = await saveUserTemplate(project.settings.name || "Untitled template", "A saved project snapshot", project);
        return `Saved "${template.name}" to your templates.`;
      }),
    [run],
  );

  const startNew = useCallback(
    () =>
      run("new", async () => {
        newProject();
        resetActivityTracking();
        return "Blank project started — it shows up here once there is something on the timeline.";
      }),
    [run],
  );

  const removeTemplate = async (id: string) => {
    setBusy(`del-template:${id}`);
    try {
      await deleteUserTemplate(id);
      await refresh();
    } catch (error) {
      toast.error("Could not delete template", { description: describe(error) });
    } finally {
      setBusy(null);
    }
  };

  return {
    summaries,
    userTemplates,
    loading,
    persistent,
    busy,
    currentId,
    createTemplate,
    openSnapshotTemplate,
    openSaved,
    duplicate,
    remove,
    removeTemplate,
    saveCurrent,
    saveCopy,
    saveAsTemplate,
    startNew,
    refresh,
  };
}
