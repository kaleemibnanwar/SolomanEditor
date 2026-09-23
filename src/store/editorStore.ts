/**
 * THE SINGLE SOURCE OF TRUTH.
 *
 * All timeline state (layers, in/out points, z-order, keyframes) lives here in a
 * normalized shape. The canvas preview, the side panels and the export renderer
 * all read from this store; nothing keeps a private copy of timeline state.
 *
 * History is snapshot based and covers the project graph only (layers +
 * settings). Selection, playhead, zoom and UI state are intentionally outside it
 * so undoing never fights with scrubbing.
 */
import { shallowArrayEqual, createStore, useStore, type StoreApi } from "@/store/createStore";
import { NEUTRAL_FILTERS, NEUTRAL_GRADE, layerEnd } from "@/lib/anim";
import { FILTER_LOOK_BY_ID, lookValues, type BackgroundPreset } from "@/lib/library";
import {
  MIN_LAYER_DURATION,
  NO_TRANSITION,
  createEffectLayer,
  createMediaLayer,
  createShapeLayer,
  createStickerLayer,
  createTextLayer,
  createBackgroundLayer,
  nextZIndex,
  orderedLayers,
  projectDuration,
  withNormalizedZ,
} from "@/lib/project";
import { clamp, uid } from "@/lib/time";
import { applyBond, clearBond } from "@/lib/bonds";
import {
  CAPTIONS_TRACK_NAME,
  MAIN_TRACK_NAME,
  appendTrack,
  captionsTrackId,
  createTrack,
  layersOnTrack,
  mainTrackId,
  moveLayerToTrackIn,
  normalizeTracks,
  placeLayer,
  pruneTracks,
  removeTrackFrom,
  renameTrackIn,
  reorderTrackIn,
  setMainTrackIn,
  trackSpan,
  withTrackOrder,
} from "@/lib/tracks";
import type {
  AnimatableProp,
  Asset,
  EffectStyle,
  EditorState,
  ExportJob,
  ExportOptions,
  Keyframe,
  Layer,
  LayerFilters,
  LayerGrade,
  LayerId,
  Project,
  ProjectSettings,
  ShapeId,
  StickerStyle,
  Track,
  TrackId,
  Transition,
  TransitionType,
  VoiceoverJob,
  VoiceoverOptions,
} from "@/types/editor";

const HISTORY_LIMIT = 80;

export const DEFAULT_SETTINGS: ProjectSettings = {
  name: "Untitled project",
  width: 1920,
  height: 1080,
  fps: 30,
  backgroundColor: "#000000",
  backgroundKind: "color",
  backgroundGradient: "linear-gradient(120deg, #1e3a8a 0%, #020617 100%)",
  backgroundAngle: 120,
};

export function createEmptyProject(settings: ProjectSettings = DEFAULT_SETTINGS): Project {
  // A brand new project starts with the main layer already in place, so the
  // first imported clip has somewhere to land without a row appearing as a
  // side effect of the import.
  const main = createTrack(MAIN_TRACK_NAME, true);
  return {
    id: uid("project"),
    settings: { ...settings },
    layers: {},
    layerIds: [],
    trackIds: [main.id],
    tracks: { [main.id]: main },
  };
}

/** Every mutation the UI can perform. */
export interface EditorActions {
  addAsset: (asset: Asset) => void;
  updateAsset: (id: string, patch: Partial<Asset>) => void;
  removeAsset: (id: string) => void;

  addLayer: (layer: Layer) => LayerId;
  addMediaLayer: (assetId: string, startTime?: number, trackId?: TrackId) => LayerId | null;
  addTextLayer: (content?: string) => LayerId;
  addStickerLayer: (sticker: StickerStyle, name?: string) => LayerId;
  addShapeLayer: (shape: ShapeId) => LayerId;
  addEffectLayer: (style: EffectStyle, name?: string) => LayerId;
  addBackgroundLayer: (preset: BackgroundPreset) => LayerId;

  updateLayer: (id: LayerId, patch: Partial<Layer>, record?: boolean) => void;
  updateLayers: (ids: LayerId[], patch: Partial<Layer>, record?: boolean) => void;
  updateSelected: (patch: Partial<Layer>, record?: boolean) => void;
  updateLayerTransform: (id: LayerId, patch: Partial<Layer["transform"]>, record?: boolean) => void;
  updateLayerFilters: (id: LayerId, patch: Partial<LayerFilters>, record?: boolean) => void;
  updateSelectedFilters: (patch: Partial<LayerFilters>, record?: boolean) => void;
  updateSelectedGrade: (patch: Partial<LayerGrade>, record?: boolean) => void;
  applyFilterLook: (lookId: string) => void;
  resetFilters: (id: LayerId) => void;
  toggleHidden: (id: LayerId) => void;
  toggleLocked: (id: LayerId) => void;
  renameLayer: (id: LayerId, name: string) => void;
  removeLayers: (ids: LayerId[]) => void;
  duplicateLayers: (ids: LayerId[]) => void;

  setLayerStart: (id: LayerId, startTime: number, record?: boolean) => void;
  setLayersStart: (moves: [LayerId, number][], record?: boolean) => void;
  trimStart: (id: LayerId, newStart: number, record?: boolean) => void;
  trimEnd: (id: LayerId, newEnd: number, record?: boolean) => void;
  reorderLayer: (id: LayerId, targetIndex: number) => void;
  nudgeLayerZ: (id: LayerId, direction: "up" | "down" | "top" | "bottom") => void;
  splitAtPlayhead: () => number;
  setTransition: (id: LayerId, edge: "in" | "out", patch: Partial<Transition>) => void;
  /** Applies a transition to every selected layer, on the edge the library is pointed at. */
  applyTransition: (type: TransitionType, patch?: Partial<Transition>) => void;
  /** Joins two touching clips on one track with a transition bond. */
  bondTransition: (fromId: LayerId, toId: LayerId, patch?: Partial<Transition>, record?: boolean) => void;
  /** Removes a bond, restoring a plain cut between the two clips. */
  unbondTransition: (fromId: LayerId, toId: LayerId) => void;

  addTrack: (name?: string) => TrackId;
  /** Finds the captions track, creating it (below the main layer) the first time it's needed. */
  ensureCaptionsTrack: () => TrackId;
  renameTrack: (id: TrackId, name: string) => void;
  removeTrack: (id: TrackId) => void;
  setMainTrack: (id: TrackId) => void;
  moveLayerToTrack: (layerId: LayerId, trackId: TrackId) => void;
  /** Reorders a whole row forward/backward in the drawing stack (the main layer stays at the back). */
  nudgeTrackZ: (trackId: TrackId, direction: "up" | "down" | "top" | "bottom") => void;

  addKeyframe: (layerId: LayerId, prop: AnimatableProp, value?: number, time?: number) => void;
  updateKeyframe: (layerId: LayerId, keyframeId: string, patch: Partial<Keyframe>) => void;
  removeKeyframe: (layerId: LayerId, keyframeId: string) => void;
  clearKeyframes: (layerId: LayerId, prop?: AnimatableProp) => void;

  select: (ids: LayerId[]) => void;
  toggleSelect: (id: LayerId) => void;
  clearSelection: () => void;
  selectAll: () => void;

  setCurrentTime: (time: number) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  setLoop: (loop: boolean) => void;
  seekBy: (delta: number) => void;
  seekFrame: (frames: number) => void;

  setZoom: (pixelsPerSecond: number) => void;
  zoomBy: (factor: number) => void;

  updateSettings: (patch: Partial<ProjectSettings>) => void;
  setUi: (patch: Partial<EditorState["ui"]>) => void;

  enqueueExport: (options: ExportOptions) => void;
  patchExportJob: (id: string, patch: Partial<ExportJob>) => void;
  removeExportJob: (id: string) => void;

  enqueueVoiceover: (script: string, options: VoiceoverOptions) => string;
  patchVoiceoverJob: (id: string, patch: Partial<VoiceoverJob>) => void;
  removeVoiceoverJob: (id: string) => void;

  pushHistory: () => void;
  undo: () => void;
  redo: () => void;

  loadProject: (project: Project, assets: Record<string, Asset>) => void;
  resetProject: () => void;
}

export type EditorStoreState = EditorState & EditorActions;

const initialState: EditorState = {
  project: createEmptyProject(),
  assets: {},
  assetIds: [],
  selection: [],
  currentTime: 0,
  isPlaying: false,
  loop: true,
  pixelsPerSecond: 90,
  history: { past: [], future: [] },
  lastAction: "New project",
  ui: {
    libraryTab: "media",
    libraryQuery: "",
    inspectorTab: "transform",
    snapEnabled: true,
    showGrid: false,
    showSafeArea: false,
    muted: false,
    exporting: false,
    booting: true,
    transitionEdge: "in",
    settingsOpen: false,
    projectsOpen: false,
    voiceScript: "",
    voiceId: "af_heart",
  },
  exportJobs: [],
  voiceoverJobs: [],
};

/* ------------------------------------------------------------------ *
 * Pure project recipes
 * ------------------------------------------------------------------ */

export function patchLayer(project: Project, id: LayerId, patch: Partial<Layer>): Project {
  const layer = project.layers[id];
  if (!layer) return project;
  return { ...project, layers: { ...project.layers, [id]: { ...layer, ...patch } } };
}

function patchLayerOrSame(project: Project, id: LayerId, patch: Partial<Layer>): Project {
  const layer = project.layers[id];
  if (!layer) return project;
  const same = (Object.keys(patch) as (keyof Layer)[]).every((k) => Object.is(layer[k], patch[k]));
  return same ? project : patchLayer(project, id, patch);
}

/**
 * Adds a layer, giving it a row first. `placeLayer` decides which track that is
 * (see `lib/tracks.ts`); the re-grouping afterwards keeps `layerIds` canonical
 * so the compositor still reads a correct bottom→top order.
 */
function insertLayer(project: Project, layer: Layer): Project {
  const placed = placeLayer(project, layer);
  const withLayer: Project = {
    ...placed.project,
    layerIds: [...placed.project.layerIds, layer.id],
    layers: {
      ...placed.project.layers,
      [layer.id]: { ...layer, trackId: placed.trackId, zIndex: nextZIndex(placed.project) },
    },
  };
  return withTrackOrder(withLayer);
}

function removeLayersFromProject(project: Project, ids: LayerId[]): Project {
  const layers = { ...project.layers };
  const touched = new Set<TrackId>();
  for (const id of ids) {
    const layer = layers[id];
    if (!layer) continue;
    delete layers[id];
    touched.add(layer.trackId);
  }
  const lean: Project = {
    ...project,
    layers,
    layerIds: project.layerIds.filter((id) => !ids.includes(id)),
  };
  // Only rows this delete actually acted on can disappear — a hand-made row the
  // user has not filled yet survives.
  return withNormalizedZ(pruneTracks(lean, touched));
}

/**
 * Re-orders a clip inside its own track. Track order owns the rows, so a clip
 * cannot be nudged past another track's clips: vertical movement between rows
 * is a drag in the timeline, not a layer-list reorder.
 */
function reorderWithinTrack(project: Project, id: LayerId, targetIndex: number): Project {
  const from = project.layerIds.indexOf(id);
  const layer = project.layers[id];
  if (from < 0 || !layer) return project;
  const [lo, hi] = trackSpan(project, layer.trackId);
  const to = clamp(targetIndex, lo, hi);
  if (from === to) return project;
  const ids = [...project.layerIds];
  ids.splice(from, 1);
  ids.splice(to, 0, id);
  return withNormalizedZ({ ...project, layerIds: ids });
}

const hasSourceMedia = (layer: Layer) => layer.type === "video" || layer.type === "audio";

const pushPast = (past: Project[], project: Project) => [...past, project].slice(-HISTORY_LIMIT);

/** Length of the timeline surface (always a little longer than the content). */
export const timelineDuration = (state: EditorState) => Math.max(projectDuration(state.project), 2);

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

export const editorStore: StoreApi<EditorStoreState> = createStore<EditorStoreState>((set, get) => {
  const mutate = (recipe: (project: Project) => Project, label: string, recordChange = true) =>
    set((s) => {
      const next = recipe(s.project);
      if (next === s.project) return {};
      return {
        project: next,
        lastAction: label,
        history: recordChange ? { past: pushPast(s.history.past, s.project), future: [] } : s.history,
      };
    });

  const record = (label: string) =>
    set((s) => ({ history: { past: pushPast(s.history.past, s.project), future: [] }, lastAction: label }));

  return {
    ...initialState,

    /* ---------------- assets ---------------- */

    addAsset: (asset) =>
      set((s) => ({
        assets: { ...s.assets, [asset.id]: asset },
        assetIds: s.assetIds.includes(asset.id) ? s.assetIds : [...s.assetIds, asset.id],
      })),

    updateAsset: (id, patch) =>
      set((s) => (s.assets[id] ? { assets: { ...s.assets, [id]: { ...s.assets[id], ...patch } } } : {})),

    removeAsset: (id) =>
      set((s) => {
        const assets = { ...s.assets };
        delete assets[id];
        return { assets, assetIds: s.assetIds.filter((a) => a !== id) };
      }),

    /* ---------------- layer creation ---------------- */

    addLayer: (layer) => {
      mutate((p) => insertLayer(p, layer), "Add layer");
      set({ selection: [layer.id] });
      return layer.id;
    },

    addMediaLayer: (assetId, startTime, trackId) => {
      const s = get();
      const asset = s.assets[assetId];
      if (!asset) return null;
      const layer = createMediaLayer(asset, s.project.settings, startTime ?? s.currentTime);
      // An explicit row overrides the choice `placeLayer` would make on its own,
      // which is what dropping onto a particular timeline row asks for. Left
      // undefined (or stale), the layer is placed for us as usual.
      if (trackId) layer.trackId = trackId;
      return get().addLayer(layer);
    },

    addTextLayer: (content) => {
      const id = get().addLayer(createTextLayer(get().project.settings, get().currentTime, content));
      set((s) => ({ ui: { ...s.ui, inspectorTab: "text" } }));
      return id;
    },

    addStickerLayer: (sticker, name) =>
      get().addLayer(createStickerLayer(get().project.settings, get().currentTime, sticker, name)),

    addShapeLayer: (shape) =>
      get().addLayer(createShapeLayer(get().project.settings, get().currentTime, shape)),

    addEffectLayer: (style, name) => {
      const id = get().addLayer(createEffectLayer(get().project.settings, get().currentTime, style, name));
      set((s) => ({ ui: { ...s.ui, inspectorTab: "effect" } }));
      return id;
    },

    addBackgroundLayer: (preset) => {
      const id = get().addLayer(createBackgroundLayer(get().project.settings, get().currentTime, preset));
      // A preset that also names a flat backdrop keeps the empty timeline from
      // flashing black wherever the layer does not reach.
      if (preset.project) get().updateSettings(preset.project);
      return id;
    },

    /* ---------------- layer mutation ---------------- */

    updateLayer: (id, patch, recordChange = true) =>
      mutate((p) => patchLayer(p, id, patch), "Edit layer", recordChange),

    updateLayers: (ids, patch, recordChange = true) =>
      mutate((p) => ids.reduce((acc, id) => patchLayer(acc, id, patch), p), "Edit layers", recordChange),

    updateSelected: (patch, recordChange = true) =>
      mutate((p) => get().selection.reduce((acc, id) => patchLayer(acc, id, patch), p), "Edit selection", recordChange),

    updateLayerTransform: (id, patch, recordChange = true) =>
      mutate(
        (p) => {
          const layer = p.layers[id];
          if (!layer) return p;
          return patchLayer(p, id, { transform: { ...layer.transform, ...patch } });
        },
        "Transform",
        recordChange,
      ),

    updateLayerFilters: (id, patch, recordChange = true) =>
      mutate(
        (p) => {
          const layer = p.layers[id];
          if (!layer) return p;
          const filters: LayerFilters = { ...layer.filters, ...patch };
          const same = (Object.keys(patch) as (keyof LayerFilters)[]).every((k) => filters[k] === layer.filters[k]);
          return same ? p : patchLayer(p, id, { filters });
        },
        "Filter",
        recordChange,
      ),

    updateSelectedFilters: (patch, recordChange = true) =>
      mutate(
        (p) => {
          let next = p;
          for (const id of get().selection) {
            const layer = next.layers[id];
            if (!layer) continue;
            const filters: LayerFilters = { ...layer.filters, ...patch };
            const same = (Object.keys(patch) as (keyof LayerFilters)[]).every((k) => filters[k] === layer.filters[k]);
            if (same) continue;
            next = patchLayer(next, id, { filters });
          }
          return next;
        },
        "Filter",
        recordChange,
      ),

    updateSelectedGrade: (patch, recordChange = true) =>
      mutate(
        (p) => {
          let next = p;
          for (const id of get().selection) {
            const layer = next.layers[id];
            if (!layer) continue;
            const grade: LayerGrade = { ...layer.grade, ...patch };
            const same = (Object.keys(patch) as (keyof LayerGrade)[]).every((k) => grade[k] === layer.grade[k]);
            if (same) continue;
            next = patchLayer(next, id, { grade });
          }
          return next;
        },
        "Colour grade",
        recordChange,
      ),

    applyFilterLook: (lookId) =>
      mutate(
        (p) => {
          const look = FILTER_LOOK_BY_ID[lookId];
          const ids = get().selection;
          if (!look || !ids.length) return p;
          const values = lookValues(look);
          let next = p;
          for (const id of ids) {
            if (!next.layers[id]) continue;
            next = patchLayer(next, id, { filters: { ...values.filters }, grade: { ...values.grade } });
          }
          return next;
        },
        "Apply filter",
      ),

    resetFilters: (id) =>
      mutate(
        (p) => patchLayerOrSame(p, id, { filters: { ...NEUTRAL_FILTERS }, grade: { ...NEUTRAL_GRADE } }),
        "Reset filters",
      ),

    toggleHidden: (id) => mutate((p) => patchLayerOrSame(p, id, { hidden: !p.layers[id]?.hidden }), "Visibility"),

    toggleLocked: (id) => mutate((p) => patchLayerOrSame(p, id, { locked: !p.layers[id]?.locked }), "Lock"),

    renameLayer: (id, name) => mutate((p) => patchLayerOrSame(p, id, { name }), "Rename layer"),

    removeLayers: (ids) => {
      if (!ids.length) return;
      mutate((p) => removeLayersFromProject(p, ids), "Delete layer");
      set((s) => ({ selection: s.selection.filter((id) => !ids.includes(id)) }));
    },

    duplicateLayers: (ids) => {
      if (!ids.length) return;
      const created: LayerId[] = [];
      mutate((p) => {
        let next = p;
        for (const id of ids) {
          const layer = p.layers[id];
          if (!layer) continue;
          const copy: Layer = {
            ...layer,
            id: uid("layer"),
            name: `${layer.name} copy`,
            startTime: layerEnd(layer),
            // An empty trackId asks `placeLayer` to re-home the copy. Dropping it
            // onto the original's row would put two clips on top of each other
            // whenever the row is already busy past the original.
            trackId: "",
            keyframes: layer.keyframes.map((k) => ({ ...k, id: uid("kf") })),
          };
          created.push(copy.id);
          next = insertLayer(next, copy);
        }
        return next;
      }, "Duplicate layer");
      if (created.length) set({ selection: created });
    },

    setLayerStart: (id, startTime, recordChange = true) =>
      mutate(
        (p) => {
          const layer = p.layers[id];
          if (!layer) return p;
          const next = Math.max(0, startTime);
          if (Math.abs(next - layer.startTime) < 1e-6) return p;
          return patchLayer(p, id, { startTime: next });
        },
        "Move layer",
        recordChange,
      ),

    setLayersStart: (moves, recordChange = true) =>
      mutate(
        (p) => {
          let next = p;
          for (const [id, start] of moves) {
            const layer = next.layers[id];
            if (!layer) continue;
            const target = Math.max(0, start);
            if (Math.abs(target - layer.startTime) < 1e-6) continue;
            next = patchLayer(next, id, { startTime: target });
          }
          return next;
        },
        "Move layers",
        recordChange,
      ),

    trimStart: (id, newStart, recordChange = true) =>
      mutate(
        (p) => {
          const layer = p.layers[id];
          if (!layer) return p;
          const asset = layer.assetId ? get().assets[layer.assetId] : undefined;
          let startTime = clamp(newStart, 0, layerEnd(layer) - MIN_LAYER_DURATION);
          let inPoint = layer.inPoint;
          let duration = layer.duration - (startTime - layer.startTime);

          if (hasSourceMedia(layer) && asset?.duration) {
            const maxIn = Math.max(0, asset.duration - MIN_LAYER_DURATION);
            const nextIn = clamp(layer.inPoint + (startTime - layer.startTime), 0, maxIn);
            const consumed = nextIn - layer.inPoint;
            startTime = layer.startTime + consumed;
            inPoint = nextIn;
            duration = layer.duration - consumed;
          }
          if (Math.abs(startTime - layer.startTime) < 1e-6 && Math.abs(inPoint - layer.inPoint) < 1e-6) return p;
          return patchLayer(p, id, { startTime, inPoint, duration });
        },
        "Trim in",
        recordChange,
      ),

    trimEnd: (id, newEnd, recordChange = true) =>
      mutate(
        (p) => {
          const layer = p.layers[id];
          if (!layer) return p;
          const asset = layer.assetId ? get().assets[layer.assetId] : undefined;
          let end = Math.max(layer.startTime + MIN_LAYER_DURATION, newEnd);
          if (hasSourceMedia(layer) && asset?.duration) {
            end = Math.min(end, layer.startTime + (asset.duration - layer.inPoint));
          }
          const duration = end - layer.startTime;
          if (Math.abs(duration - layer.duration) < 1e-6) return p;
          return patchLayer(p, id, { duration });
        },
        "Trim out",
        recordChange,
      ),

    reorderLayer: (id, targetIndex) => mutate((p) => reorderWithinTrack(p, id, targetIndex), "Reorder layer"),

    nudgeLayerZ: (id, direction) =>
      mutate((p) => {
        const from = p.layerIds.indexOf(id);
        const layer = p.layers[id];
        if (from < 0 || !layer) return p;
        const [lo, hi] = trackSpan(p, layer.trackId);
        const to =
          direction === "up" ? from + 1 : direction === "down" ? from - 1 : direction === "top" ? hi : lo;
        return reorderWithinTrack(p, id, to);
      }, "Reorder layer"),

    splitAtPlayhead: () => {
      const s = get();
      const t = s.currentTime;
      const scope = s.selection.length ? s.selection : s.project.layerIds;
      const targets = orderedLayers(s.project).filter(
        (l) => scope.includes(l.id) && t > l.startTime + 0.03 && t < layerEnd(l) - 0.03,
      );
      if (!targets.length) return 0;

      const createdIds: LayerId[] = [];
      record("Split clip");
      mutate(
        (p) => {
          let next = p;
          for (const layer of targets) {
            const local = t - layer.startTime;
            const tail: Layer = {
              ...layer,
              id: uid("layer"),
              startTime: t,
              duration: layerEnd(layer) - t,
              inPoint: hasSourceMedia(layer) ? layer.inPoint + local : 0,
              keyframes: layer.keyframes
                .filter((k) => k.time > local)
                .map((k) => ({ ...k, id: uid("kf"), time: k.time - local })),
              transitionIn: { ...NO_TRANSITION },
            };
            createdIds.push(tail.id);
            const head: Layer = {
              ...layer,
              duration: local,
              keyframes: layer.keyframes.filter((k) => k.time <= local),
              transitionOut: { ...NO_TRANSITION },
            };
            const ids = [...next.layerIds];
            const index = ids.indexOf(layer.id);
            ids.splice(index + 1, 0, tail.id);
            next = withNormalizedZ({
              ...next,
              layers: { ...next.layers, [layer.id]: head, [tail.id]: tail },
              layerIds: ids,
            });
          }
          return next;
        },
        "Split clip",
        false,
      );
      set((st) => ({ selection: [...st.selection, ...createdIds] }));
      return targets.length;
    },

    setTransition: (id, edge, patch) =>
      mutate((p) => {
        const layer = p.layers[id];
        if (!layer) return p;
        const key = edge === "in" ? "transitionIn" : "transitionOut";
        return patchLayer(p, id, { [key]: { ...layer[key], ...patch } } as Partial<Layer>);
      }, "Transition"),

    applyTransition: (type, patch) =>
      mutate(
        (p) => {
          const ids = get().selection;
          if (!ids.length) return p;
          const key = get().ui.transitionEdge === "in" ? "transitionIn" : "transitionOut";
          let next = p;
          for (const id of ids) {
            const layer = next.layers[id];
            if (!layer) continue;
            const base = type === "none" ? { ...NO_TRANSITION } : { ...layer[key], type };
            next = patchLayer(next, id, { [key]: { ...base, ...patch } } as Partial<Layer>);
          }
          return next;
        },
        type === "none" ? "Remove transition" : "Apply transition",
      ),

    bondTransition: (fromId, toId, patch, recordChange = true) =>
      mutate(
        // `applyBond` routes a "none"/"cut" patch to `clearBond` itself; only the
        // label needs to know which of the two this is.
        (p) => applyBond(p, fromId, toId, patch),
        patch?.type === "none" || patch?.type === "cut" ? "Remove transition bond" : "Transition bond",
        recordChange,
      ),

    unbondTransition: (fromId, toId) => mutate((p) => clearBond(p, fromId, toId), "Remove transition bond"),

    /* ---------------- tracks ---------------- */

    addTrack: (name) => {
      const track = createTrack(name?.trim() || `Track ${get().project.trackIds.length + 1}`);
      mutate((p) => appendTrack(p, track).project, "Add track");
      return track.id;
    },

    ensureCaptionsTrack: () => {
      const existing = captionsTrackId(get().project);
      if (existing) return existing;
      const track = createTrack(CAPTIONS_TRACK_NAME, false, true);
      mutate((p) => appendTrack(p, track).project, "Add captions track");
      return track.id;
    },

    renameTrack: (id, name) => mutate((p) => renameTrackIn(p, id, name.trim()), "Rename track"),

    removeTrack: (id) => {
      const track = get().project.tracks[id];
      if (!track || track.main) return;
      const doomed = new Set(layersOnTrack(get().project, id).map((l) => l.id));
      mutate((p) => removeTrackFrom(p, id), "Delete track");
      set((s) => ({ selection: s.selection.filter((layerId) => !doomed.has(layerId)) }));
    },

    setMainTrack: (id) => mutate((p) => setMainTrackIn(p, id), "Set main layer"),

    moveLayerToTrack: (layerId, trackId) => mutate((p) => moveLayerToTrackIn(p, layerId, trackId), "Move to track"),

    nudgeTrackZ: (trackId, direction) =>
      mutate((p) => {
        const from = p.trackIds.indexOf(trackId);
        if (from < 0) return p;
        const to =
          direction === "up"
            ? from + 1
            : direction === "down"
              ? from - 1
              : direction === "top"
                ? p.trackIds.length - 1
                : 1;
        return reorderTrackIn(p, trackId, to);
      }, "Reorder track"),

    /* ---------------- keyframes ---------------- */

    addKeyframe: (layerId, prop, value, time) =>
      mutate(
        (p) => {
          const layer = p.layers[layerId];
          if (!layer) return p;
          const localTime = clamp(time ?? get().currentTime - layer.startTime, 0, layer.duration);
          const nextValue = value ?? currentPropValue(layer, prop, localTime);
          const existing = layer.keyframes.find((k) => k.prop === prop && Math.abs(k.time - localTime) < 1e-3);
          const keyframes = (
            existing
              ? layer.keyframes.map((k) => (k === existing ? { ...k, value: nextValue } : k))
              : [...layer.keyframes, { id: uid("kf"), prop, time: localTime, value: nextValue, easing: "easeInOut" as const }]
          ).sort((a, b) => a.time - b.time);
          return patchLayer(p, layerId, { keyframes });
        },
        "Add keyframe",
      ),

    updateKeyframe: (layerId, keyframeId, patch) =>
      mutate(
        (p) => {
          const layer = p.layers[layerId];
          if (!layer) return p;
          const keyframes = layer.keyframes
            .map((k) =>
              k.id === keyframeId
                ? { ...k, ...patch, time: patch.time !== undefined ? clamp(patch.time, 0, layer.duration) : k.time }
                : k,
            )
            .sort((a, b) => a.time - b.time);
          return patchLayer(p, layerId, { keyframes });
        },
        "Edit keyframe",
      ),

    removeKeyframe: (layerId, keyframeId) =>
      mutate(
        (p) => {
          const layer = p.layers[layerId];
          if (!layer) return p;
          return patchLayer(p, layerId, { keyframes: layer.keyframes.filter((k) => k.id !== keyframeId) });
        },
        "Delete keyframe",
      ),

    clearKeyframes: (layerId, prop) =>
      mutate(
        (p) => {
          const layer = p.layers[layerId];
          if (!layer) return p;
          return patchLayer(p, layerId, { keyframes: prop ? layer.keyframes.filter((k) => k.prop !== prop) : [] });
        },
        "Clear keyframes",
      ),

    /* ---------------- selection ---------------- */

    select: (ids) => set({ selection: [...new Set(ids)] }),
    toggleSelect: (id) =>
      set((s) => ({
        selection: s.selection.includes(id) ? s.selection.filter((x) => x !== id) : [...s.selection, id],
      })),
    clearSelection: () => set({ selection: [] }),
    selectAll: () => set((s) => ({ selection: [...s.project.layerIds] })),

    /* ---------------- playback & time ---------------- */

    setCurrentTime: (time) => set((s) => ({ currentTime: clamp(time, 0, timelineDuration(s) + 1) })),
    play: () => set({ isPlaying: true }),
    pause: () => set({ isPlaying: false }),
    togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),
    setLoop: (loop) => set({ loop }),
    seekBy: (delta) => set((s) => ({ currentTime: clamp(s.currentTime + delta, 0, timelineDuration(s) + 1) })),
    seekFrame: (frames) =>
      set((s) => {
        const fps = s.project.settings.fps;
        const next = Math.round((s.currentTime + frames / fps) * fps) / fps;
        return { currentTime: clamp(next, 0, timelineDuration(s) + 1) };
      }),

    setZoom: (pixelsPerSecond) => set({ pixelsPerSecond: clamp(pixelsPerSecond, 12, 900) }),
    zoomBy: (factor) => set((s) => ({ pixelsPerSecond: clamp(s.pixelsPerSecond * factor, 12, 900) })),

    /* ---------------- settings & ui ---------------- */

    updateSettings: (patch) => mutate((p) => ({ ...p, settings: { ...p.settings, ...patch } }), "Project settings"),
    setUi: (patch) => set((s) => ({ ui: { ...s.ui, ...patch } })),

    /* ---------------- export queue ---------------- */

    enqueueExport: (options) =>
      set((s) => ({
        exportJobs: [
          ...s.exportJobs,
          {
            id: uid("job"),
            projectId: s.project.id,
            createdAt: Date.now(),
            status: "queued",
            progress: 0,
            message: "Queued",
            options,
          },
        ],
      })),

    patchExportJob: (id, patch) =>
      set((s) => ({ exportJobs: s.exportJobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) })),

    removeExportJob: (id) => set((s) => ({ exportJobs: s.exportJobs.filter((j) => j.id !== id) })),

    /* ---------------- voiceover queue ---------------- */

    enqueueVoiceover: (script, options) => {
      const id = uid("voiceover");
      set((s) => ({
        voiceoverJobs: [
          ...s.voiceoverJobs,
          { id, createdAt: Date.now(), status: "queued", progress: 0, message: "Queued", script, options },
        ],
      }));
      return id;
    },

    patchVoiceoverJob: (id, patch) =>
      set((s) => ({ voiceoverJobs: s.voiceoverJobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) })),

    removeVoiceoverJob: (id) => set((s) => ({ voiceoverJobs: s.voiceoverJobs.filter((j) => j.id !== id) })),

    /* ---------------- history ---------------- */

    pushHistory: () => record("Change"),

    undo: () =>
      set((s) => {
        if (!s.history.past.length) return {};
        return {
          project: s.history.past[s.history.past.length - 1],
          history: {
            past: s.history.past.slice(0, -1),
            future: [s.project, ...s.history.future].slice(0, HISTORY_LIMIT),
          },
          lastAction: "Undo",
        };
      }),

    redo: () =>
      set((s) => {
        if (!s.history.future.length) return {};
        return {
          project: s.history.future[0],
          history: { past: pushPast(s.history.past, s.project), future: s.history.future.slice(1) },
          lastAction: "Redo",
        };
      }),

    /* ---------------- project lifecycle ---------------- */

    loadProject: (project, assets) =>
      set({
        project: normalizeTracks(project),
        assets,
        assetIds: Object.keys(assets),
        selection: [],
        currentTime: 0,
        isPlaying: false,
        history: { past: [], future: [] },
        lastAction: "Load project",
      }),

    resetProject: () => set({ ...initialState, ui: { ...initialState.ui, booting: false } }),
  };
});

function currentPropValue(layer: Layer, prop: AnimatableProp, localTime: number): number {
  const keys = layer.keyframes.filter((k) => k.prop === prop).sort((a, b) => a.time - b.time);
  if (!keys.length) return layer[prop] as number;
  if (localTime <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (localTime >= last.time) return last.value;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (localTime >= a.time && localTime <= b.time) {
      const t = (localTime - a.time) / Math.max(1e-6, b.time - a.time);
      return a.value + (b.value - a.value) * t;
    }
  }
  return layer[prop] as number;
}

/* ------------------------------------------------------------------ *
 * Hooks, selectors and the action accessor
 * ------------------------------------------------------------------ */

/** Access the store's actions: `editor().splitAtPlayhead()` */
export const editor = () => editorStore.getState();

export function useEditor<S>(selector: (state: EditorStoreState) => S, isEqual?: (a: S, b: S) => boolean): S {
  return useStore(editorStore, selector, isEqual);
}

export const useSelection = () => useEditor((s) => s.selection, shallowArrayEqual);
export const useAssetIds = () => useEditor((s) => s.assetIds, shallowArrayEqual);
export const useAssets = () => useEditor((s) => s.assets);

export const selectSelectedLayers = (state: EditorStoreState) =>
  orderedLayers(state.project).filter((l) => state.selection.includes(l.id));

export const selectPrimaryLayer = (state: EditorStoreState) =>
  state.selection.length ? state.project.layers[state.selection[state.selection.length - 1]] : undefined;

export const selectCanUndo = (state: EditorStoreState) => state.history.past.length > 0;
export const selectCanRedo = (state: EditorStoreState) => state.history.future.length > 0;
export const selectDuration = (state: EditorStoreState) => timelineDuration(state);
