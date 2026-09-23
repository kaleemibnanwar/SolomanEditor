/**
 * TRACKS — the timeline's rows.
 *
 * A layer is a thing that draws; a track is where it lives. Turning tracks into
 * real entities (instead of "one row per layer") is what lets a sequence of
 * clips sit side by side on a single row, and that in turn is what makes a
 * JUNCTION possible — two touching clips on one track, joined by a transition
 * bond (see `lib/bonds.ts`).
 *
 * The important invariant is that `project.layerIds` stays the canonical
 * bottom→top z-order, only *grouped* by track. `orderedLayers` (and therefore
 * the compositor, the export engine and playback) keeps working untouched —
 * tracks only decide which row a clip is drawn on.
 *
 * Exactly one track is the MAIN LAYER: the primary visual sequence. New video
 * and image clips land there by default, which means importing a batch of media
 * immediately produces a row of adjacent clips — i.e. junctions.
 *
 * THE MAIN LAYER IS ALWAYS THE TOP ROW, AND ALWAYS THE BACK OF THE STACK. That
 * is one invariant, enforced in `withTrackOrder` — the only writer of
 * `trackIds` — rather than trusted to each caller: the main track is hoisted to
 * `trackIds[0]`, which is the back of the z-stack, and the rail reads
 * `trackIds` straight down, so row 0 is always it. Everything else stacks
 * *below* it, and because reading down the rail means moving forward through
 * the stack, a title on the row under the main layer draws over the picture.
 * Nothing can end up above the main layer, because there is no "above".
 */
import { layerEnd, withNormalizedZ } from "@/lib/project";
import { clamp, uid } from "@/lib/time";
import type { Layer, LayerId, Project, Track, TrackId } from "@/types/editor";

export const MAIN_TRACK_NAME = "Main layer";

/** Layer types that belong on the main layer by default. */
const VISUAL_TYPES = new Set<Layer["type"]>(["video", "image"]);

const FALLBACK_NAME: Record<Layer["type"], string> = {
  video: "Video",
  image: "Image",
  text: "Text",
  audio: "Audio",
  sticker: "Sticker",
  effect: "Effect",
};

export function createTrack(name: string, main = false, captions = false): Track {
  return { id: uid("track"), name, main, ...(captions ? { captions: true } : {}) };
}

export const CAPTIONS_TRACK_NAME = "Captions";

/* ------------------------------------------------------------------ *
 * Readers
 * ------------------------------------------------------------------ */

/**
 * Tracks in stack order, back to front. This IS the rail order read downwards:
 * the main layer is the top row, and each row further down sits one step closer
 * to the viewer.
 */
export function orderedTracks(project: Project): Track[] {
  return project.trackIds.map((id) => project.tracks[id]).filter((t): t is Track => !!t);
}

/**
 * Tracks in ROW order — the top row of the rail first, which is the main layer.
 *
 * The main track is hoisted here as well as in `withTrackOrder`, so a project
 * saved by an older build (or hand-edited) still shows its main layer on top
 * rather than quietly stacking something over it.
 */
export function topFirstTracks(project: Project): Track[] {
  const ordered = orderedTracks(project);
  const main = ordered.findIndex((t) => t.main);
  if (main <= 0) return ordered;
  return [ordered[main], ...ordered.slice(0, main), ...ordered.slice(main + 1)];
}

export function mainTrack(project: Project): Track | undefined {
  return orderedTracks(project).find((t) => t.main);
}

/**
 * The track new visual media should land on. Falls back to the first row so an
 * un-normalised project still has somewhere to put a clip.
 */
export function mainTrackId(project: Project): TrackId | undefined {
  return mainTrack(project)?.id ?? project.trackIds[0];
}

/** The track auto-generated captions land on, if one has been created yet. */
export function captionsTrackId(project: Project): TrackId | undefined {
  return orderedTracks(project).find((t) => t.captions)?.id;
}

/** Every layer on a track, in bottom→top z-order. */
export function layersOnTrack(project: Project, trackId: TrackId): Layer[] {
  return project.layerIds.map((id) => project.layers[id]).filter((l): l is Layer => !!l && l.trackId === trackId);
}

export const trackClipCount = (project: Project, trackId: TrackId) => layersOnTrack(project, trackId).length;

/** Row index in display space (top-first), or -1. */
export function trackRowIndex(project: Project, trackId: TrackId): number {
  return topFirstTracks(project).findIndex((t) => t.id === trackId);
}

/**
 * The half-open range of `layerIds` indices a track's clips occupy — `[first,
 * last]`, or `[0, -1]` when the track is empty. Because `layerIds` is kept
 * grouped by track, this is the window a clip may be re-ordered inside without
 * breaking the grouping.
 */
export function trackSpan(project: Project, trackId: TrackId): [number, number] {
  let first = -1;
  let last = -1;
  project.layerIds.forEach((id, index) => {
    if (project.layers[id]?.trackId !== trackId) return;
    if (first < 0) first = index;
    last = index;
  });
  return [first < 0 ? 0 : first, last];
}

/** The track drawn at a display row index — the inverse of `trackRowIndex`. */
export function trackAtRow(project: Project, rowIndex: number): Track | undefined {
  return topFirstTracks(project)[rowIndex];
}

/** True when the layer's time range is clear of everything already on the track. */
export function trackHasRoom(project: Project, trackId: TrackId, layer: Layer): boolean {
  const start = layer.startTime;
  const end = layerEnd(layer);
  return layersOnTrack(project, trackId).every(
    (other) => other.id === layer.id || layerEnd(other) <= start + 1e-6 || other.startTime >= end - 1e-6,
  );
}

/* ------------------------------------------------------------------ *
 * Writers
 * ------------------------------------------------------------------ */

/**
 * Rebuilds `layerIds` so layers are grouped by track, in track order — the
 * first track's clips come first, i.e. they are the back of the z-stack.
 *
 * This is also the single place the main-layer invariant is applied: the main
 * track is hoisted to the front, so it is always `trackIds[0]` and therefore
 * always the top row of the rail. Every writer of `trackIds` funnels through
 * here, which is why `setMainTrackIn`, `appendTrack`, `placeLayer` and
 * `pruneTracks` cannot disagree about where the main layer lives.
 *
 * Layers whose track has vanished keep their relative order at the top of the
 * stack, which keeps this safe to call on a half-normalised project.
 */
export function withTrackOrder(project: Project, trackIds: TrackId[] = project.trackIds): Project {
  const ids = trackIds.filter((id) => !!project.tracks[id]);
  const mainIndex = ids.findIndex((id) => project.tracks[id].main);
  if (mainIndex > 0) ids.unshift(ids.splice(mainIndex, 1)[0]);
  const grouped: LayerId[] = [];
  for (const trackId of ids) {
    for (const layerId of project.layerIds) {
      if (project.layers[layerId]?.trackId === trackId) grouped.push(layerId);
    }
  }
  for (const layerId of project.layerIds) {
    if (!ids.includes(project.layers[layerId]?.trackId)) grouped.push(layerId);
  }
  return withNormalizedZ({ ...project, trackIds: ids, layerIds: grouped });
}

function withTracks(project: Project, track: Track, trackIds: TrackId[]): Project {
  return withTrackOrder({ ...project, tracks: { ...project.tracks, [track.id]: track }, trackIds });
}

/**
 * Adds a track below every existing row and returns the id it was given.
 *
 * "Below" is "in front": the rail reads back-to-front downwards, so a newly
 * appended row draws over everything above it. Finishing layers — titles,
 * stickers, overlays — rely on that. The main layer still owns the top row,
 * because `withTrackOrder` hoists it there no matter where it was.
 */
export function appendTrack(project: Project, track: Track): { project: Project; trackId: TrackId } {
  return { project: withTracks(project, track, [...project.trackIds, track.id]), trackId: track.id };
}

/**
 * Gives a layer a row, creating a track when it needs one.
 *
 * Video and image clips go to the main layer whenever it is free, so a run of
 * imported media chains up and forms junctions. Everything else — text,
 * stickers, effects, audio — gets a row of its own, named after the layer,
 * which is how the timeline behaved before tracks existed.
 */
export function placeLayer(project: Project, layer: Layer): { project: Project; trackId: TrackId } {
  if (project.tracks[layer.trackId]) return { project, trackId: layer.trackId };

  if (VISUAL_TYPES.has(layer.type)) {
    const main = mainTrackId(project);
    if (main && trackHasRoom(project, main, layer)) return { project, trackId: main };
    // No main layer yet: this clip *is* the main sequence, so it belongs at the
    // back of the stack, where the pictures live.
    if (!main) {
      const track = createTrack(MAIN_TRACK_NAME, true);
      return { project: withTracks(project, track, [track.id, ...project.trackIds]), trackId: track.id };
    }
    // A second visual sequence gets its own row just below the main layer, so
    // it draws over the picture while still sitting behind the finishing layers
    // (titles, stickers, overlays), which append to the bottom of the rail.
    const track = createTrack(layer.name || FALLBACK_NAME[layer.type]);
    const at = Math.max(1, project.trackIds.indexOf(main) + 1);
    const trackIds = [...project.trackIds];
    trackIds.splice(at, 0, track.id);
    return { project: withTracks(project, track, trackIds), trackId: track.id };
  }

  return appendTrack(project, createTrack(layer.name || FALLBACK_NAME[layer.type]));
}

/** Moves a layer onto another track, keeping the row order canonical. */
export function moveLayerToTrackIn(project: Project, layerId: LayerId, trackId: TrackId): Project {
  const layer = project.layers[layerId];
  if (!layer || !project.tracks[trackId] || layer.trackId === trackId) return project;
  return withTrackOrder({ ...project, layers: { ...project.layers, [layerId]: { ...layer, trackId } } });
}

/**
 * Deletes a track. Its clips go with it — a row that silently kept orphaned
 * layers alive would be worse than an honest delete, and either way it is one
 * undo step. The main layer itself cannot be removed.
 */
export function removeTrackFrom(project: Project, trackId: TrackId): Project {
  const track = project.tracks[trackId];
  if (!track || track.main) return project;
  const layers = { ...project.layers };
  const removed = new Set<LayerId>();
  for (const id of project.layerIds) {
    if (layers[id]?.trackId === trackId) {
      delete layers[id];
      removed.add(id);
    }
  }
  const tracks = { ...project.tracks };
  delete tracks[trackId];
  return withTrackOrder(
    { ...project, layers, tracks, layerIds: project.layerIds.filter((id) => !removed.has(id)) },
    project.trackIds.filter((id) => id !== trackId),
  );
}

export function renameTrackIn(project: Project, trackId: TrackId, name: string): Project {
  const track = project.tracks[trackId];
  if (!track || !name || track.name === name) return project;
  return { ...project, tracks: { ...project.tracks, [trackId]: { ...track, name } } };
}

/**
 * Promotes a track to be the main layer; exactly one track holds the flag.
 *
 * The flag alone is not enough — the main layer also has to be the top row —
 * so the promoted track is re-hoisted through `withTrackOrder`. Promoting a row
 * therefore visibly moves it to the top of the rail rather than leaving a main
 * layer stranded in the middle of the stack.
 */
export function setMainTrackIn(project: Project, trackId: TrackId): Project {
  const target = project.tracks[trackId];
  if (!target || target.main) return project;
  const tracks: Record<TrackId, Track> = {};
  for (const [id, track] of Object.entries(project.tracks)) tracks[id] = { ...track, main: id === trackId };
  return withTrackOrder({ ...project, tracks });
}

/**
 * Moves a track forward or backward in the drawing stack by re-ordering
 * `trackIds`. This is the "reorder a layer" action: z-order *is* row order, so
 * nudging a row is how a whole visual (a logo row, a text row) goes in front of
 * or behind another. The main layer is hoisted to index 0 (the back) by
 * `withTrackOrder`, so a non-main row's target is clamped to [1, end] — nothing
 * can be nudged behind the main layer, because there is no "behind" it.
 */
export function reorderTrackIn(project: Project, trackId: TrackId, targetIndex: number): Project {
  const track = project.tracks[trackId];
  const from = project.trackIds.indexOf(trackId);
  if (!track || track.main || from < 0) return project;
  const to = clamp(targetIndex, 1, project.trackIds.length - 1);
  if (from === to) return project;
  const trackIds = [...project.trackIds];
  trackIds.splice(from, 1);
  trackIds.splice(to, 0, trackId);
  return withTrackOrder(project, trackIds);
}

/**
 * Drops empty non-main tracks, so deleting every clip on a row tidies it away.
 *
 * `scope` narrows that to the rows a particular edit emptied. Without it, a row
 * the user added by hand and has not filled yet would be swept up by the next
 * unrelated delete.
 */
export function pruneTracks(project: Project, scope?: Iterable<TrackId>): Project {
  const only = scope ? new Set(scope) : null;
  const keep = project.trackIds.filter((id) => {
    const track = project.tracks[id];
    if (!track) return false;
    if (track.main) return true;
    if (only && !only.has(id)) return true;
    return trackClipCount(project, id) > 0;
  });
  if (keep.length === project.trackIds.length) return project;
  const tracks: Record<TrackId, Track> = {};
  for (const id of keep) tracks[id] = project.tracks[id];
  return withTrackOrder({ ...project, tracks }, keep);
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

/**
 * The one entry point every loaded project passes through. Guarantees that
 * at least one track exists, exactly one of them is the main layer, and every
 * layer points at a track that is actually there.
 *
 * A project saved before tracks existed has no rows at all, so the layout is
 * rebuilt: the main layer is filled with the video/image clips that do not
 * overlap each other (in z-order, so a backdrop at 0 claims the row), and every
 * other layer gets a row named after it.
 */
export function normalizeTracks(project: Project): Project {
  const tracks: Record<TrackId, Track> = {};
  const trackIds: TrackId[] = [];
  let changed = false;
  for (const id of project.trackIds) {
    if (project.tracks[id]) {
      tracks[id] = project.tracks[id];
      trackIds.push(id);
    } else {
      changed = true;
    }
  }

  if (!trackIds.some((id) => tracks[id].main)) {
    changed = true;
    const existing = trackIds[0];
    if (existing) {
      // Adopt the oldest row as the main layer rather than inventing a new one.
      for (const id of trackIds) tracks[id] = { ...tracks[id], main: id === existing };
    } else {
      const main = createTrack(MAIN_TRACK_NAME, true);
      tracks[main.id] = main;
      trackIds.push(main.id);
    }
  }

  let next: Project = { ...project, tracks, trackIds };

  for (const layerId of project.layerIds) {
    const layer = next.layers[layerId];
    if (!layer || next.tracks[layer.trackId]) continue;
    const placed = placeLayer(next, layer);
    next = { ...placed.project, layers: { ...placed.project.layers, [layerId]: { ...layer, trackId: placed.trackId } } };
    changed = true;
  }

  return changed ? withTrackOrder(next) : project;
}
