/**
 * THE PROJECT LIBRARY — saving work, listing it, and opening it again.
 *
 * A saved project is a DOCUMENT plus the MEDIA its clips point at, and the
 * media means Blobs. `lib/storage.ts` holds both, in two object stores; this
 * module is what decides what goes in them.
 *
 * Three rules shape everything here:
 *
 *   A RECORD'S ID IS THE LIVE PROJECT'S ID. Saving the demo twice updates one
 *   record instead of leaving two, and autosave always lands on the thing you
 *   are actually editing rather than spawning a copy per keystroke.
 *
 *   STATUS IS DERIVED, NEVER TYPED IN. "In processing" means there is content
 *   but nothing has been rendered out of it yet; "ready" means at least one
 *   export has finished. Nothing else can set it, so the library cannot drift
 *   from what actually happened. This is why `ExportJob` carries a `projectId`:
 *   the export queue deliberately outlives the project it was made for, and
 *   without that attribution every project would look rendered.
 *
 *   SAVING IS IDEMPOTENT AND NON-DESTRUCTIVE. Nothing in here mutates the live
 *   editor state except `openProject` / `newProject`, which replace it wholesale
 *   exactly as `loadProject` is meant to.
 */
import { drawFrame } from "@/lib/compositor";
import { assetMetaPatch, loadAudioMeta, loadImageMeta, loadVideoMeta } from "@/lib/media";
import { layerEnd, orderedLayers, projectDuration } from "@/lib/project";
import { ASSET_STORE, PROJECT_STORE, storeDelete, storeGet, storeGetAll, storePut } from "@/lib/storage";
import { applySnapshotSlots, getUserTemplate, instantiateSnapshot } from "@/lib/userTemplates";
import {
  buildTemplateProject,
  templateById,
  type BuildTemplateOptions,
  type BuiltProject,
  type ProjectTemplate,
} from "@/lib/templates";
import { uid } from "@/lib/time";
import { DEFAULT_SETTINGS, createEmptyProject, editor, editorStore } from "@/store/editorStore";
import type { Asset, AssetId, AssetProvenance, ExportJob, MediaKind, Project } from "@/types/editor";

export { storagePersists } from "@/lib/storage";

/** `empty` has no clips, `processing` has clips but no finished render. */
export type ProjectStatus = "empty" | "processing" | "ready";

/* ------------------------------------------------------------------ *
 * What a stored asset looks like
 * ------------------------------------------------------------------ */

/**
 * The half of an `Asset` that can be written down: everything except the two
 * fields that only make sense in a live session — the DOM element the
 * compositor draws from, and the decoded AudioBuffer — plus the `url`, which is
 * derived from the bytes on the way back in.
 */
interface StoredAsset {
  id: AssetId;
  kind: MediaKind;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  thumbnail?: string;
  waveform?: number[];
  generated?: boolean;
  source?: AssetProvenance;
  /** The file itself, so a reopened project draws real media and not a dead URL. */
  blob?: Blob;
  /** The original remote URL, for stock media the browser will not let us read. */
  href?: string;
}

/* ------------------------------------------------------------------ *
 * Project records
 * ------------------------------------------------------------------ */

export interface ProjectRecord {
  id: string;
  name: string;
  /** The template this began as, when it began as one. */
  templateId?: string;
  createdAt: number;
  updatedAt: number;
  status: ProjectStatus;
  clipCount: number;
  trackCount: number;
  duration: number;
  canvas: { width: number; height: number; fps: number };
  /** JPEG data URL of a representative frame. */
  poster?: string;
  /** The latest render out of this project, as the export queue recorded it. */
  exported?: { name: string; size: number };
  project: Project;
  assetIds: AssetId[];
}

/** A record without its (large) document — what a list or a tool response needs. */
export type ProjectSummary = Omit<ProjectRecord, "project" | "assetIds"> & { assetCount: number };

export const summarize = ({ project: _project, assetIds, ...rest }: ProjectRecord): ProjectSummary => ({
  ...rest,
  assetCount: assetIds.length,
});

/**
 * The one place status is decided. A project with no clips is neither in
 * processing nor ready, and calling it either would be a small lie the library
 * would then have to live with.
 */
export function statusOf(project: Project, rendered: boolean): ProjectStatus {
  if (!project.layerIds.length) return "empty";
  return rendered ? "ready" : "processing";
}

/* ------------------------------------------------------------------ *
 * Poster frames
 * ------------------------------------------------------------------ */

/**
 * A moment worth showing on the card: the time where the most layers are on
 * screen. A fixed "always the midpoint" pick lands on whatever happens to be
 * there — often a gap between two shots, which is a black rectangle in a grid
 * of projects.
 */
function posterTime(project: Project): number {
  const layers = orderedLayers(project).filter((layer) => !layer.hidden);
  if (!layers.length) return 0;
  const candidates = [
    projectDuration(project) / 2,
    ...layers.map((layer) => layer.startTime + Math.min(0.35, layer.duration / 2)),
  ];
  let best = candidates[0];
  let bestCount = -1;
  for (const time of candidates) {
    const count = layers.filter((layer) => time >= layer.startTime && time < layerEnd(layer)).length;
    if (count > bestCount) {
      bestCount = count;
      best = time;
    }
  }
  return Math.max(0, best);
}

/**
 * Renders one frame of the project and scales it down to a card-sized JPEG.
 * Best-effort by design: a poster is a nicety, and a video element that has not
 * decoded yet must not be able to fail a save.
 */
export function capturePoster(project: Project, assets: Record<AssetId, Asset>, maxWidth = 480): string | undefined {
  const layers = orderedLayers(project).filter((layer) => !layer.hidden && layer.type !== "audio");
  if (!layers.length) return undefined;
  const { width, height } = project.settings;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    drawFrame({ ctx, settings: project.settings, layers, assets, time: posterTime(project) });

    const scale = Math.min(1, maxWidth / width);
    const thumb = document.createElement("canvas");
    thumb.width = Math.max(2, Math.round(width * scale));
    thumb.height = Math.max(2, Math.round(height * scale));
    const thumbCtx = thumb.getContext("2d");
    if (!thumbCtx) return undefined;
    thumbCtx.drawImage(canvas, 0, 0, thumb.width, thumb.height);
    return thumb.toDataURL("image/jpeg", 0.72);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Media in and out of storage
 * ------------------------------------------------------------------ */

/** Reads an asset's bytes back out of the URL it is currently playing from. */
async function readBlob(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

async function packAsset(asset: Asset): Promise<StoredAsset | null> {
  const { el: _el, audioBuffer: _audioBuffer, url, ...rest } = asset;
  const stored: StoredAsset = { ...rest };
  const blob = await readBlob(url);
  if (blob) stored.blob = blob;
  // Stock media served from someone else's origin cannot always be read back
  // (no CORS header), so the URL is kept and re-fetched on open. Anything else
  // — a blob URL whose bytes we could not read — is unpublishable.
  else if (/^https?:/i.test(url)) stored.href = url;
  else return null;
  return stored;
}

async function unpackAsset(stored: StoredAsset): Promise<Asset | null> {
  const url = stored.blob ? URL.createObjectURL(stored.blob) : stored.href;
  if (!url) return null;

  const base: Asset = {
    id: stored.id,
    kind: stored.kind,
    name: stored.name,
    mime: stored.mime,
    url,
    size: stored.size,
    width: stored.width,
    height: stored.height,
    duration: stored.duration,
    thumbnail: stored.thumbnail,
    waveform: stored.waveform,
    generated: stored.generated,
    source: stored.source,
  };

  try {
    const meta =
      stored.kind === "video"
        ? await loadVideoMeta(url)
        : stored.kind === "image"
          ? await loadImageMeta(url)
          : await loadAudioMeta(url);
    const patch = assetMetaPatch(meta);
    // Stored values win where they exist: a re-load can only ever approximate
    // what the asset had when it was saved (`loadAudioMeta` falls back to a
    // 5-second stub if decoding fails, which must not become the duration).
    return {
      ...base,
      el: patch.el,
      audioBuffer: patch.audioBuffer,
      width: patch.width ?? base.width,
      height: patch.height ?? base.height,
      duration: patch.duration ?? base.duration,
      thumbnail: base.thumbnail ?? patch.thumbnail,
      waveform: base.waveform?.length ? base.waveform : patch.waveform,
    };
  } catch {
    return base;
  }
}

/* ------------------------------------------------------------------ *
 * Saving
 * ------------------------------------------------------------------ */

export interface SaveProjectOptions {
  /** Overrides `project.settings.name` on the record. */
  name?: string;
  templateId?: string;
  /** Capture a fresh poster frame. Defaults to "only when the record has none". */
  capturePoster?: boolean;
  poster?: string;
}

/**
 * Writes the live project to the library and returns the record.
 *
 * The record's id is the project's own id, so this is an upsert: the first save
 * creates the record and every later one updates it in place.
 */
export async function saveProject(options: SaveProjectOptions = {}): Promise<ProjectRecord | null> {
  const state = editor();
  const { project, assets } = state;
  const previous = await storeGet<ProjectRecord>(PROJECT_STORE, project.id);

  // Media first: a record naming an asset that never landed would open with a
  // hole in it, which is worse than the save having failed outright.
  const assetIds: AssetId[] = [];
  for (const assetId of state.assetIds) {
    const asset = assets[assetId];
    if (!asset) continue;
    const stored = await packAsset(asset);
    if (!stored) continue;
    await storePut(ASSET_STORE, stored);
    assetIds.push(assetId);
  }

  const renders = state.exportJobs
    .filter((job: ExportJob) => job.projectId === project.id && job.status === "done")
    .sort((a, b) => a.createdAt - b.createdAt);
  const latest = renders[renders.length - 1];

  let poster = previous?.poster;
  if (options.poster) poster = options.poster;
  else if (options.capturePoster ?? !previous?.poster) poster = capturePoster(project, assets) ?? poster;

  const record: ProjectRecord = {
    id: project.id,
    name: (options.name ?? project.settings.name).trim() || "Untitled project",
    templateId: options.templateId ?? project.templateId ?? previous?.templateId,
    createdAt: previous?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    status: statusOf(project, renders.length > 0),
    clipCount: project.layerIds.length,
    trackCount: project.trackIds.length,
    duration: projectDuration(project),
    canvas: { width: project.settings.width, height: project.settings.height, fps: project.settings.fps },
    poster,
    exported: latest
      ? { name: latest.resultName ?? latest.options.fileName, size: latest.resultSize ?? 0 }
      : previous?.exported,
    project,
    assetIds,
  };

  await storePut(PROJECT_STORE, record);
  return record;
}

/**
 * Saves the live project under a NEW id and name, leaving the record it came
 * from untouched. The store is repointed at the new id first, so the autosave
 * that follows keeps writing to the copy rather than the original.
 */
export async function saveProjectAsCopy(name?: string): Promise<ProjectRecord | null> {
  const project = editor().project;
  const previousId = project.id;
  const nextId = uid("project");
  const nextName = name?.trim() || `${project.settings.name} copy`;

  editorStore.setState({
    project: { ...project, id: nextId, settings: { ...project.settings, name: nextName } },
    lastAction: "Save as copy",
  });

  const record = await saveProject({ capturePoster: true });
  if (!record) {
    editorStore.setState({ project: { ...editor().project, id: previousId } });
    return null;
  }
  return record;
}

/* ------------------------------------------------------------------ *
 * Listing, opening, deleting
 * ------------------------------------------------------------------ */

export async function listProjects(): Promise<ProjectRecord[]> {
  const records = await storeGetAll<ProjectRecord>(PROJECT_STORE);
  return records.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listProjectSummaries(): Promise<ProjectSummary[]> {
  return (await listProjects()).map(summarize);
}

export async function getProjectRecord(id: string): Promise<ProjectRecord | undefined> {
  return storeGet<ProjectRecord>(PROJECT_STORE, id);
}

/** Rebuilds a record's assets — real DOM elements, waveforms and all. */
export async function restoreProject(
  record: ProjectRecord,
): Promise<{ project: Project; assets: Record<AssetId, Asset> }> {
  const assets: Record<AssetId, Asset> = {};
  for (const assetId of record.assetIds ?? []) {
    const stored = await storeGet<StoredAsset>(ASSET_STORE, assetId);
    if (!stored) continue;
    const asset = await unpackAsset(stored);
    if (asset) assets[asset.id] = asset;
  }
  return { project: record.project, assets };
}

/**
 * Replaces the editor's contents with a saved project. Pending edits are
 * flushed first — switching project is not a way to lose the last stroke of
 * work — and `loadProject` clears history, so undo cannot walk back into the
 * project you just left.
 */
export async function openProject(id: string): Promise<ProjectRecord | null> {
  const record = await storeGet<ProjectRecord>(PROJECT_STORE, id);
  if (!record) return null;
  await flushAutosave();
  const { project, assets } = await restoreProject(record);
  editor().loadProject(project, assets);
  editor().setCurrentTime(0);
  return record;
}

export async function duplicateProject(id: string, name?: string): Promise<ProjectRecord | null> {
  const source = await storeGet<ProjectRecord>(PROJECT_STORE, id);
  if (!source) return null;
  const nextId = uid("project");
  const copy: ProjectRecord = {
    ...source,
    id: nextId,
    name: name?.trim() || `${source.name} copy`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // The copy is its own project from here on, so its document has to agree
    // with the record about which one that is.
    project: { ...source.project, id: nextId },
  };
  await storePut(PROJECT_STORE, copy);
  return copy;
}

export async function deleteProject(id: string): Promise<void> {
  await storeDelete(PROJECT_STORE, id);
  await collectGarbage();
}

/**
 * Drops media no remaining record refers to. Two projects sharing a clip keep
 * it; a deleted project's footage does not linger forever.
 */
async function collectGarbage(): Promise<void> {
  const records = await storeGetAll<ProjectRecord>(PROJECT_STORE);
  const referenced = new Set<AssetId>();
  for (const record of records) for (const assetId of record.assetIds ?? []) referenced.add(assetId);
  for (const asset of await storeGetAll<StoredAsset>(ASSET_STORE)) {
    if (!referenced.has(asset.id)) await storeDelete(ASSET_STORE, asset.id);
  }
}

/* ------------------------------------------------------------------ *
 * Starting points
 * ------------------------------------------------------------------ */

/**
 * Lays a template down as the live project AND saves it, so it appears in the
 * library straight away as `processing` rather than only existing in memory
 * until the first edit. Pending work is flushed first, for the same reason
 * `openProject` does it.
 */
export async function createFromTemplate(
  template: string | ProjectTemplate,
  options: BuildTemplateOptions = {},
): Promise<{ record: ProjectRecord | null; built: BuiltProject } | null> {
  const spec = typeof template === "string" ? templateById(template) : template;
  if (!spec) return null;
  await flushAutosave();
  const built = await buildTemplateProject(spec, options);
  editor().loadProject(built.project, built.assets);
  editor().setCurrentTime(0);
  const record = await saveProject({ capturePoster: true, templateId: spec.id });
  return { record, built };
}

/**
 * Starts a blank project on a fresh id, so it becomes its own library record
 * rather than overwriting whatever was there before. The canvas carries over —
 * a portrait project is a standing choice, not a property of the last edit.
 */
export function newProject(name = "Untitled project"): void {
  const { width, height, fps } = editor().project.settings;
  editor().loadProject(createEmptyProject({ ...DEFAULT_SETTINGS, width, height, fps, name }), {});
  editor().setCurrentTime(0);
}

/**
 * Opens a saved snapshot template as the live project, exactly as
 * `createFromTemplate` opens a recipe: the snapshot is instantiated with fresh
 * ids, loaded, and saved so it joins the library immediately.
 */
export async function loadSnapshotTemplate(
  idOrName: string,
  opts: { name?: string; slots?: Record<string, string> } = {},
): Promise<ProjectRecord | null> {
  const template = await getUserTemplate(idOrName);
  if (!template) return null;
  await flushAutosave();
  const instantiated = instantiateSnapshot(template.project, opts.name?.trim() || template.name);
  const { project } = opts.slots
    ? applySnapshotSlots(instantiated, template.slots, opts.slots)
    : { project: instantiated };
  editor().loadProject(project, {});
  editor().setCurrentTime(0);
  return saveProject({ capturePoster: true });
}

/* ------------------------------------------------------------------ *
 * Autosave
 * ------------------------------------------------------------------ */

/** How long the editor has to be quiet before a save is worth making. */
const AUTOSAVE_DELAY = 2500;
/** A poster is a full-size render, so autosave only refreshes it this often. */
const POSTER_INTERVAL = 60_000;

let autosaveTimer: number | null = null;
let saving = false;
let lastPosterAt = 0;
/** The state slices a save actually depends on. */
let watched: { project: Project; assetIds: AssetId[]; exportJobs: ExportJob[] } | null = null;

/**
 * Persists work as it happens.
 *
 * This is a store subscription rather than a React effect on purpose: it must
 * not care how many components happen to be mounted, and it must not re-run on
 * render. It compares the three slices a save depends on BY REFERENCE, so
 * scrubbing the playhead — a `set` per frame — cannot queue a write, while
 * every real edit does.
 */
export function installAutosave(): () => void {
  const unsubscribe = editorStore.subscribe(() => {
    const state = editorStore.getState();
    if (
      watched &&
      watched.project === state.project &&
      watched.assetIds === state.assetIds &&
      watched.exportJobs === state.exportJobs
    ) {
      return;
    }
    watched = { project: state.project, assetIds: state.assetIds, exportJobs: state.exportJobs };
    if (autosaveTimer !== null) window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => void autosave(), AUTOSAVE_DELAY);
  });

  return () => {
    unsubscribe();
    if (autosaveTimer !== null) window.clearTimeout(autosaveTimer);
    autosaveTimer = null;
  };
}

/**
 * Writes a pending autosave now. Call it before anything that replaces the
 * project, so the edits in flight are not the ones that get dropped.
 */
export async function flushAutosave(): Promise<void> {
  if (autosaveTimer === null) return;
  window.clearTimeout(autosaveTimer);
  autosaveTimer = null;
  await autosave();
}

async function autosave(): Promise<void> {
  autosaveTimer = null;
  if (saving) return;
  const state = editorStore.getState();
  // An empty project is not work. Saving the blank slate would put a row in the
  // library that says nothing, and the boot overlay's placeholder is not even
  // the user's project yet.
  if (state.ui.booting || !state.project.layerIds.length) return;

  const capturePoster = Date.now() - lastPosterAt > POSTER_INTERVAL;
  if (capturePoster) lastPosterAt = Date.now();
  saving = true;
  try {
    await saveProject({ capturePoster });
  } finally {
    saving = false;
  }
}
