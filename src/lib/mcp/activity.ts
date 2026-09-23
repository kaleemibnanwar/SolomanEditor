/**
 * THE ACTIVITY BASELINE — what "since you last looked" is measured against.
 *
 * `get_activity` is the only tool whose answer depends on when it was last
 * called, so something has to remember. That something is module state rather
 * than editor state on purpose: there is exactly one editor and one server per
 * page, and a baseline kept in the project document would be saved, undone and
 * copied along with it — all three of which would be nonsense.
 *
 * It lives here rather than in `tools.ts` because two catalogues and the UI all
 * need it: the tools read and advance it, and anything that REPLACES the open
 * project clears it. That last part is the point — after a project swap, a diff
 * against the previous project's clips would list every clip in both projects
 * as changed, which is noise dressed up as information.
 */
import { editor } from "@/store/editorStore";

export interface ActivitySnapshot {
  layerIds: string[];
  names: Record<string, string>;
  undoDepth: number;
  lastAction: string;
  selection: string[];
  playhead: number;
  playing: boolean;
  at: number;
}

export function snapshotActivity(): ActivitySnapshot {
  const state = editor();
  return {
    layerIds: [...state.project.layerIds],
    names: Object.fromEntries(state.project.layerIds.map((id) => [id, state.project.layers[id]?.name ?? id])),
    undoDepth: state.history.past.length,
    lastAction: state.lastAction,
    selection: [...state.selection],
    playhead: state.currentTime,
    playing: state.isPlaying,
    at: Date.now(),
  };
}

let baseline: ActivitySnapshot | null = null;

/**
 * Reads the baseline and advances it to `now` in one step, so a caller cannot
 * forget to update it and report the same diff twice. Returns null the first
 * time, which is how the tool knows it is reporting a baseline rather than a
 * change.
 */
export function takeActivityBaseline(now: ActivitySnapshot): ActivitySnapshot | null {
  const before = baseline;
  baseline = now;
  return before;
}

/** Forget the baseline — call it whenever the open project is replaced. */
export function resetActivityTracking(): void {
  baseline = null;
}
