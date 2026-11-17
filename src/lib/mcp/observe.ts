/**
 * OBSERVATION — the agent's eyes.
 *
 * Every read tool is a pure function from the live `EditorState` to a plain JSON
 * payload. Because the MCP server runs in the same page as the editor, this is
 * not a copy or a poll: it is the actual state, read at the instant the agent
 * asked. That is what makes "the agent knows exactly what is happening in the
 * editor" literally true rather than approximately true.
 *
 * Two principles shape the payloads:
 *
 *   · A CLIP is reported with its source in-point, its length on the timeline
 *     and its length in source media, because that distinction is where every
 *     real editing bug lives.
 *   · Anything an agent would otherwise have to infer — what is visible right
 *     now, which junctions exist, whether a filter is neutral — is computed here
 *     and stated outright.
 */
import { evaluateLayer, filterString, isNeutralGrade } from "@/lib/anim";
import { boxBounds, evaluatedBox } from "@/lib/geometry";
import { junctionsOnTrack } from "@/lib/bonds";
import {
  BACKGROUND_PRESETS,
  BLEND_OPTIONS,
  EFFECT_GROUPS,
  EFFECT_PRESETS,
  FILTER_LOOKS,
  FONT_OPTIONS,
  SHAPE_PRESETS,
  STICKER_PACKS,
  TEXT_PRESETS,
} from "@/lib/library";
import { LAYER_LABELS, layerEnd, orderedLayers, projectDuration } from "@/lib/project";
import { listProjectSummaries, storagePersists, type ProjectSummary } from "@/lib/projects";
import { SOUND_CATEGORIES, SOUND_PRESETS } from "@/lib/sound";
import { formatFrames, formatTimecode, round } from "@/lib/time";
import { layersOnTrack, topFirstTracks } from "@/lib/tracks";
import { DEFAULT_SOFTNESS, TRANSITION_CATEGORIES, TRANSITION_DEFS, isShaderTransition } from "@/lib/transitions";
import type { EditorStoreState } from "@/store/editorStore";
import { timelineDuration } from "@/store/editorStore";
import type { Asset, Layer, LayerId, Project } from "@/types/editor";

type Json = Record<string, unknown>;

/* ------------------------------------------------------------------ *
 * Small formatters shared by the readers
 * ------------------------------------------------------------------ */

const secs = (value: number) => round(value, 3);

/** "3 minutes ago" — the only way an `updatedAt` timestamp reads as a line of text. */
function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Where a transition is in its ramp at `localTime`, or null when inactive. */
function transitionState(layer: Layer, localTime: number) {
  const active = (t: Layer["transitionIn"], at: number, span: number) => {
    if (!t || t.type === "none" || t.type === "cut" || t.duration <= 0) return null;
    if (at < 0 || at > t.duration) return null;
    return {
      type: t.type,
      duration: round(t.duration, 3),
      progress: round(Math.max(0, Math.min(1, at / t.duration)), 3),
      direction: t.direction,
      softness: t.softness ?? DEFAULT_SOFTNESS,
      intensity: t.intensity ?? 1,
      color: t.color,
      shader: isShaderTransition(t.type) ? true : undefined,
      span,
    };
  };
  return {
    in: active(layer.transitionIn, localTime, layer.transitionIn.duration),
    out: active(layer.transitionOut, localTime - (layer.duration - layer.transitionOut.duration), layer.transitionOut.duration),
  };
}

/** Non-neutral filters and grade, so an agent can see at a glance what is applied. */
function lookState(layer: Layer) {
  const filter = filterString(layer);
  return {
    filters: filter === "none" ? null : filter,
    filterValues: filter === "none" ? null : layer.filters,
    grade: isNeutralGrade(layer.grade) ? null : layer.grade,
  };
}

function clipBrief(project: Project, layer: Layer): Json {
  const out: Json = {
    id: layer.id,
    name: layer.name,
    type: layer.type,
    label: LAYER_LABELS[layer.type],
    trackId: layer.trackId,
    start: secs(layer.startTime),
    end: secs(layerEnd(layer)),
    duration: secs(layer.duration),
    timecode: `${formatTimecode(layer.startTime)} → ${formatTimecode(layerEnd(layer))}`,
  };
  if (layer.assetId) out.assetId = layer.assetId;
  // Source in-point only means something for media clips.
  if (layer.type === "video" || layer.type === "audio") {
    out.sourceIn = secs(layer.inPoint);
    out.sourceOut = secs(layer.inPoint + layer.duration);
  }
  if (layer.type === "text") out.content = layer.text?.content;
  if (layer.type === "sticker") out.glyph = layer.sticker?.glyph ?? layer.sticker?.shape;
  if (layer.type === "effect") out.effect = layer.effect?.kind;
  if (layer.transitionIn.type !== "none") out.transitionIn = layer.transitionIn.type;
  if (layer.transitionOut.type !== "none") out.transitionOut = layer.transitionOut.type;
  if (layer.keyframes.length) out.keyframes = layer.keyframes.length;
  if (layer.locked) out.locked = true;
  if (layer.hidden) out.hidden = true;
  if (layer.opacity !== 1) out.opacity = round(layer.opacity, 3);
  if (layer.volume !== 1) out.volume = round(layer.volume, 3);
  return out;
}

/** Everything about one clip, including the parts a summary leaves out. */
function clipDetail(project: Project, assets: Record<string, Asset>, layer: Layer): Json {
  const source = layer.assetId ? assets[layer.assetId] : undefined;
  return {
    ...clipBrief(project, layer),
    frames: Math.round(layer.duration * project.settings.fps),
    transform: {
      x: round(layer.transform.x, 2),
      y: round(layer.transform.y, 2),
      scale: round(layer.transform.scale, 4),
      rotation: round(layer.transform.rotation, 2),
    },
    ...lookState(layer),
    transitionIn: layer.transitionIn,
    transitionOut: layer.transitionOut,
    keyframes: layer.keyframes.map((k) => ({
      id: k.id,
      prop: k.prop,
      at: round(k.time, 3),
      value: round(k.value, 4),
      easing: k.easing,
    })),
    audio: {
      volume: round(layer.volume, 3),
      fadeIn: round(layer.audioFadeIn, 3),
      fadeOut: round(layer.audioFadeOut, 3),
      rate: layer.rate ?? 1,
      loop: layer.mediaLoop ?? false,
    },
    text: layer.text,
    sticker: layer.sticker,
    effect: layer.effect,
    source: source
      ? {
          assetId: source.id,
          name: source.name,
          kind: source.kind,
          mime: source.mime,
          naturalDuration: source.duration ? round(source.duration, 3) : undefined,
          naturalSize: source.width && source.height ? { width: source.width, height: source.height } : undefined,
          generated: source.generated ?? false,
          provider: source.source?.provider,
        }
      : null,
    // How much source is left on each side — the numbers an editor trims against.
    sourceRemaining:
      source?.duration !== undefined && layer.type !== "text" && layer.type !== "sticker" && layer.type !== "effect"
        ? {
            headroomBeforeInPoint: secs(layer.inPoint),
            headroomAfterOutPoint: secs(Math.max(0, source.duration - (layer.inPoint + layer.duration))),
          }
        : null,
    isMainSequence: project.tracks[layer.trackId]?.main ?? false,
  };
}

/* ------------------------------------------------------------------ *
 * Readers
 * ------------------------------------------------------------------ */

/** The whole timeline, track by track, with every junction stated explicitly. */
export function buildTimeline(state: EditorStoreState): Json {
  const project = state.project;
  const fps = project.settings.fps;

  const tracks = topFirstTracks(project).map((track, row) => {
    const clips = layersOnTrack(project, track.id)
      .slice()
      .sort((a, b) => a.startTime - b.startTime);
    const junctions = junctionsOnTrack(project, track.id);
    return {
      row,
      id: track.id,
      name: track.name,
      main: track.main,
      clipCount: clips.length,
      clips: clips.map((clip) => clipBrief(project, clip)),
      junctions: junctions.map((j) => ({
        from: j.from,
        to: j.to,
        seam: secs(j.seam),
        overlap: secs(j.overlap),
        bonded: j.bonded,
        transition: j.transition.type,
        duration: round(j.transition.duration, 3),
      })),
      empty: clips.length === 0,
    };
  });

  return {
    settings: { width: project.settings.width, height: project.settings.height, fps },
    duration: secs(projectDuration(project)),
    durationTimecode: formatFrames(projectDuration(project), fps),
    trackCount: tracks.length,
    clipCount: project.layerIds.length,
    mainTrackId: project.trackIds.find((id) => project.tracks[id]?.main) ?? null,
    tracks,
  };
}

/** Every clip at a moment, top of the stack first — literally what is on screen. */
export function buildOnScreen(state: EditorStoreState, time: number): Json {
  const project = state.project;
  const at = Math.max(0, time);
  const rowOf = new Map(topFirstTracks(project).map((t, i) => [t.id, i]));

  const visible = orderedLayers(project)
    .filter((l) => at >= l.startTime && at < layerEnd(l) - 1e-6)
    .reverse() // orderedLayers is back→front; on screen the front-most reads first
    .map((layer) => {
      const evaluated = evaluateLayer(layer, at);
      const local = at - layer.startTime;
      const transition = transitionState(layer, local);
      return {
        id: layer.id,
        name: layer.name,
        type: layer.type,
        row: rowOf.get(layer.trackId) ?? null,
        isMainSequence: project.tracks[layer.trackId]?.main ?? false,
        hidden: layer.hidden,
        // Evaluated at THIS instant, so keyframes and fades are already applied.
        opacity: round(evaluated.opacity, 4),
        visibleOpacity: layer.hidden ? 0 : round(evaluated.opacity, 4),
        transform: {
          x: round(evaluated.x, 2),
          y: round(evaluated.y, 2),
          scale: round(evaluated.scale, 4),
          rotation: round(evaluated.rotation, 2),
        },
        volume: round(evaluated.volume, 4),
        ...lookState(layer),
        transition: transition.in ?? transition.out,
        text: layer.text?.content,
        effect: layer.effect?.kind,
      };
    });

  return {
    time: secs(at),
    timecode: formatFrames(at, project.settings.fps),
    frame: Math.round(at * project.settings.fps),
    canvas: { width: project.settings.width, height: project.settings.height },
    playing: state.isPlaying,
    layerCount: visible.length,
    /** Front-most first: the first entry is the top of the stack. */
    layers: visible,
    hiddenByFlags: visible.filter((l) => l.hidden).map((l) => l.id),
    note: visible.length
      ? "Listed front-most first. `visibleOpacity` accounts for the layer's own hidden flag."
      : "Nothing is on screen at this time — the compositor would render the project background.",
  };
}

/**
 * The still-image verification report: every layer at `t = 0`, front-most first,
 * with its evaluated opacity, transform and the axis-aligned on-canvas bounding
 * box (project pixels, origin top-left), plus which layers are clipped by the
 * canvas edge or fully off it. This is the image mode's "what will actually come
 * out" check — geometry is computed from the same `evaluatedBox` the stage draws
 * selection boxes from, so the numbers match what a person sees.
 */
export function buildImageVerify(state: EditorStoreState): Json {
  const { project, assets } = state;
  const settings = project.settings;
  const W = settings.width;
  const H = settings.height;
  const rowOf = new Map(topFirstTracks(project).map((t, i) => [t.id, i]));

  const layers = orderedLayers(project)
    .filter((layer) => layer.type !== "audio" && !layer.hidden)
    .reverse() // orderedLayers is back→front; front-most reads first
    .map((layer) => {
      const evaluated = evaluateLayer(layer, 0);
      const box = evaluatedBox(layer, assets, settings, 0);
      const bounds = box ? boxBounds(box) : null;
      const clipped = bounds && (bounds.left < 0 || bounds.top < 0 || bounds.right > W || bounds.bottom > H);
      const off = bounds && (bounds.right <= 0 || bounds.bottom <= 0 || bounds.left >= W || bounds.top >= H);
      return {
        id: layer.id,
        name: layer.name,
        type: layer.type,
        row: rowOf.get(layer.trackId) ?? null,
        z: layer.zIndex,
        opacity: round(evaluated.opacity, 4),
        transform: {
          x: round(evaluated.x, 2),
          y: round(evaluated.y, 2),
          scale: round(evaluated.scale, 4),
          rotation: round(evaluated.rotation, 2),
        },
        bounds: bounds
          ? { left: round(bounds.left, 1), top: round(bounds.top, 1), right: round(bounds.right, 1), bottom: round(bounds.bottom, 1) }
          : null,
        clippedByCanvas: !!clipped,
        offCanvas: !!off,
      };
    });

  const offCanvas = layers.filter((l) => l.offCanvas).map((l) => l.name as string);
  const clipped = layers.filter((l) => l.clippedByCanvas && !l.offCanvas).map((l) => l.name as string);

  return {
    canvas: { width: W, height: H },
    layerCount: layers.length,
    layers,
    offCanvas,
    clippedByCanvas: clipped,
    note: layers.length
      ? `Front-most first; bounds are project pixels (origin top-left).${
          offCanvas.length ? ` Off-canvas: ${offCanvas.join(", ")}.` : ""
        }${clipped.length ? ` Partly clipped by the canvas edge: ${clipped.join(", ")}.` : ""}`
      : `Nothing is on the canvas — an export would be the project background alone (${W}×${H}).`,
  };
}

/** The full live state of the editor, not just the project. */
export function buildEditorState(state: EditorStoreState): Json {
  const project = state.project;
  const duration = projectDuration(project);
  const selected = state.selection;

  const byType: Record<string, number> = {};
  for (const layer of orderedLayers(project)) byType[layer.type] = (byType[layer.type] ?? 0) + 1;

  const named = new Set(FILTER_LOOKS.map((l) => l.id));

  return {
    project: {
      id: project.id,
      name: project.settings.name,
      canvas: {
        width: project.settings.width,
        height: project.settings.height,
        fps: project.settings.fps,
        aspect: `${project.settings.width}:${project.settings.height}`,
        orientation:
          project.settings.height > project.settings.width
            ? "portrait"
            : project.settings.width > project.settings.height
              ? "landscape"
              : "square",
      },
      background: {
        kind: project.settings.backgroundKind,
        color: project.settings.backgroundColor,
        gradient: project.settings.backgroundGradient,
        angle: project.settings.backgroundAngle,
      },
    },
    playhead: {
      time: secs(state.currentTime),
      timecode: formatFrames(state.currentTime, project.settings.fps),
      frame: Math.round(state.currentTime * project.settings.fps),
      playing: state.isPlaying,
      looping: state.loop,
      timelineDuration: secs(timelineDuration(state)),
    },
    selection: {
      count: selected.length,
      clipIds: selected,
      names: selected.map((id) => project.layers[id]?.name ?? "(missing)"),
      /** What the agent's next un-scoped edit would hit. */
      drivesUnscopedEdits: selected.length > 0,
    },
    content: {
      clipCount: project.layerIds.length,
      trackCount: project.trackIds.length,
      duration: secs(duration),
      durationTimecode: formatFrames(duration, project.settings.fps),
      layersByType: byType,
      mainTrackId: project.trackIds.find((id) => project.tracks[id]?.main) ?? null,
      empty: project.layerIds.length === 0,
    },
    assets: {
      count: state.assetIds.length,
      byKind: state.assetIds.reduce<Record<string, number>>((acc, id) => {
        const kind = state.assets[id]?.kind ?? "unknown";
        acc[kind] = (acc[kind] ?? 0) + 1;
        return acc;
      }, {}),
    },
    history: {
      canUndo: state.history.past.length > 0,
      canRedo: state.history.future.length > 0,
      undoDepth: state.history.past.length,
      lastAction: state.lastAction,
    },
    export: {
      exporting: state.ui.exporting,
      jobs: state.exportJobs.length,
      activeJobs: state.exportJobs.filter((j) => j.status !== "done" && j.status !== "error" && j.status !== "canceled").length,
    },
    view: {
      libraryTab: state.ui.libraryTab,
      inspectorTab: state.ui.inspectorTab,
      zoomPxPerSecond: state.pixelsPerSecond,
      snapEnabled: state.ui.snapEnabled,
      muted: state.ui.muted,
      transitionEdge: state.ui.transitionEdge,
    },
    /** A nudge toward the right starting point. */
    hints: {
      unknownLookIds: named.size ? undefined : "library unavailable",
      suggestedNext: project.layerIds.length
        ? selected.length
          ? "get_clip on the selection, or whats_on_screen at the playhead"
          : "get_timeline, or select_clips before an unscoped edit"
        : "list_assets, then flow_assembly_cut",
    },
  };
}

export function buildSelection(state: EditorStoreState): Json {
  const project = state.project;
  return {
    count: state.selection.length,
    clips: state.selection
      .map((id) => project.layers[id])
      .filter((l): l is Layer => !!l)
      .map((layer) => clipBrief(project, layer)),
    missing: state.selection.filter((id) => !project.layers[id]),
  };
}

export function buildClip(state: EditorStoreState, clipId: string): Json | null {
  const layer = state.project.layers[clipId];
  if (!layer) return null;
  return clipDetail(state.project, state.assets, layer);
}

export function buildAssets(state: EditorStoreState): Json {
  return {
    count: state.assetIds.length,
    assets: state.assetIds.map((id) => {
      const asset = state.assets[id];
      if (!asset) return { id, missing: true };
      return {
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
        duration: asset.duration ? secs(asset.duration) : null,
        size: asset.width && asset.height ? { width: asset.width, height: asset.height } : null,
        generated: asset.generated ?? false,
        provenance: asset.source?.provider ?? (asset.generated ? "generated" : "import"),
        /** Peaks let an agent reason about loudness without decoding audio. */
        hasWaveform: !!asset.waveform?.length,
        timesUsed: orderedLayers(state.project).filter((l) => l.assetId === id).length,
      };
    }),
    note: "Use these ids with add_media_clip, flow_assembly_cut or flow_trim_silence.",
  };
}

/** Every id an agent may pass to a preset-taking tool. */
export function buildLibrary(): Json {
  return {
    transitions: TRANSITION_DEFS.map((t) => ({
      id: t.id,
      label: t.label,
      category: t.category,
      hint: t.hint,
      directional: t.directional ?? false,
      shader: isShaderTransition(t.id),
    })),
    transitionCategories: TRANSITION_CATEGORIES,
    filters: FILTER_LOOKS.map((l) => ({ id: l.id, name: l.name, hint: l.hint })),
    effects: EFFECT_PRESETS.map((e) => ({ id: e.id, label: e.label, group: e.group, hint: e.hint, kind: e.style.kind })),
    effectGroups: EFFECT_GROUPS,
    backgrounds: BACKGROUND_PRESETS.map((b) => ({ id: b.id, label: b.label, hint: b.hint })),
    shapes: SHAPE_PRESETS.map((s) => ({ id: s.id, label: s.label })),
    textPresets: TEXT_PRESETS.map((t) => ({ id: t.id, label: t.label, hint: t.hint, sample: t.sample })),
    stickers: STICKER_PACKS.map((p) => ({ pack: p.id, label: p.label, glyphs: p.glyphs })),
    fonts: FONT_OPTIONS,
    blendModes: BLEND_OPTIONS.map((b) => b.value),
    // Sound presets carry a render function — never serialise it to the client.
    sounds: SOUND_PRESETS.map((s) => ({ id: s.id, name: s.name, category: s.category, blurb: s.blurb, seconds: s.seconds })),
    soundCategories: SOUND_CATEGORIES,
  };
}

/** A summary as this module reports it: no poster blob, and the timestamp spelled out. */
export type ProjectListing = Omit<ProjectSummary, "poster"> & { isOpen: boolean; updatedAgo: string };

export interface ProjectLibrary {
  count: number;
  persistent: boolean;
  currentProjectId: string;
  currentProjectSaved: boolean;
  projects: ProjectListing[];
  note: string;
}

/**
 * The saved library.
 *
 * The one reader that is NOT a pure function of live state, and the only one
 * that is asynchronous: what has been written to disk lives outside the store,
 * in IndexedDB, and both reading it and asking whether this browser will keep
 * it are promise-shaped. Shared by the `list_projects` tool and the
 * `soloman-editor://projects` resource so the two can never disagree.
 *
 * The poster data URL is dropped deliberately — it is a full JPEG of a frame,
 * and it would swamp every payload it appeared in.
 */
export async function buildProjects(state: EditorStoreState): Promise<ProjectLibrary> {
  const [records, persistent] = await Promise.all([listProjectSummaries(), storagePersists()]);
  const currentId = state.project.id;

  return {
    count: records.length,
    persistent,
    currentProjectId: currentId,
    currentProjectSaved: records.some((record) => record.id === currentId),
    projects: records.map((record) => {
      const { poster: _poster, ...rest } = record;
      return { ...rest, isOpen: record.id === currentId, updatedAgo: ago(record.updatedAt) };
    }),
    note: persistent
      ? "Saves are held in this browser's IndexedDB and survive a reload. A project saves itself a couple of seconds after each edit."
      : "This browser is NOT giving the page IndexedDB (a sandboxed frame or private mode), so these saves last only for this session.",
  };
}

export function buildExportStatus(state: EditorStoreState): Json {
  return {
    exporting: state.ui.exporting,
    jobs: state.exportJobs.map((job) => ({
      id: job.id,
      status: job.status,
      progress: round(job.progress, 3),
      message: job.message,
      createdAt: job.createdAt,
      options: job.options,
      resultName: job.resultName,
      resultSize: job.resultSize,
      mimeType: job.mimeType,
      error: job.error,
    })),
    note: "Export is a realtime capture: it runs at playback speed and only while the tab is in the foreground.",
  };
}

export function buildVoiceoverStatus(state: EditorStoreState): Json {
  return {
    jobs: state.voiceoverJobs.map((job) => ({
      id: job.id,
      status: job.status,
      progress: round(job.progress, 3),
      message: job.message,
      createdAt: job.createdAt,
      script: job.script,
      options: job.options,
      segments: job.segments,
      error: job.error,
    })),
    note: "Narration, captions and B-roll fetching all run on-device in the background — poll this between checks rather than blocking on one call.",
  };
}

/** One clip id, resolved into the detail payload — shared by a tool and a resource. */
export const readClip = buildClip;

/** Ids of the clips a write should act on when the caller named none. */
export function resolveTargets(state: EditorStoreState, ids: string[] | undefined): LayerId[] {
  if (ids?.length) return [...new Set(ids)];
  return state.selection.length ? [...state.selection] : [];
}
