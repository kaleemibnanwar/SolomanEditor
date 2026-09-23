/**
 * JUNCTIONS & TRANSITION BONDS.
 *
 * A transition used to be a property of a *clip edge*: it ramps inside the
 * clip's own time, so at a hard cut the incoming clip fades up over whatever
 * happens to be underneath it — which is not the same thing as dissolving FROM
 * the outgoing clip. A BOND fixes that: it makes two clips that touch on a
 * track overlap physically, so the incoming clip's enter-ramp really does draw
 * over the outgoing clip's tail.
 *
 * The recipe, chosen so that no renderer has to change:
 *
 *   applying a bond of length `d` between A → B
 *     · extends A's duration by `d` (past the seam),
 *     · clears A's out-transition, and
 *     · gives B an in-transition of `d` seconds.
 *
 * The seam is B's `startTime`. A now covers the whole overlap window with solid
 * footage while only B ramps, which is exactly what a cross-dissolve, a wipe, a
 * slide or a shader cross-transition needs — and it is why A must NOT ramp
 * during a bond (a second ramp on top would double-fade, and the shader tier
 * snapshots the frame below, so a fading A would poison frame A).
 *
 * Removing a bond is the exact inverse: A's tail is trimmed back to the seam
 * and B's in-transition is cleared, leaving a clean cut.
 *
 * If A is a video with no material left past its out point, its final frame is
 * held for the length of the bond (the compositor and the exporter both clamp
 * to the end of the source). A bond therefore always succeeds rather than
 * silently refusing because a clip happens to be at full length.
 */
import { MIN_LAYER_DURATION, NO_TRANSITION, layerEnd, withNormalizedZ } from "@/lib/project";
import { layersOnTrack } from "@/lib/tracks";
import { DEFAULT_SOFTNESS, isNoopTransition } from "@/lib/transitions";
import { clamp } from "@/lib/time";
import type { Layer, LayerId, Project, Transition, TrackId } from "@/types/editor";

/** Clips closer than this count as touching (frame-rounding slack). */
export const JUNCTION_EPSILON = 0.04;
/** A bond can never be longer than this, however much room the clips have. */
export const MAX_BOND_OVERLAP = 6;
/** Below this an overlap is not worth having — it reads as a cut. */
export const MIN_BOND_OVERLAP = 0.05;

/** Used when a bond is applied without naming a transition: a plain crossfade. */
export const DEFAULT_BOND: Transition = { type: "fade", duration: 0.5, direction: "left" };

/**
 * The join between two consecutive clips on one track. Junctions are *derived*
 * from geometry — nothing is stored — so a junction exists for as long as the
 * clips actually touch.
 */
export interface Junction {
  trackId: TrackId;
  /** the outgoing clip — it ends at the seam */
  from: LayerId;
  /** the incoming clip — its `startTime` IS the seam */
  to: LayerId;
  /** where the two clips meet, in project seconds */
  seam: number;
  /** how far the incoming clip overlaps the outgoing one; 0 at a plain cut */
  overlap: number;
  /** true when a transition bond is in force across this junction */
  bonded: boolean;
  /** the bond's transition — or the one a new bond would start from */
  transition: Transition;
}

export const junctionKey = (from: LayerId, to: LayerId): string => `${from}>${to}`;

/**
 * Do two transitions resolve to the same behaviour? Compared field by field
 * against the engine's own defaults, because rewriting `intensity` from
 * `undefined` to `1` is not an edit worth recording as a history step.
 */
function sameTransition(a: Transition, b: Transition): boolean {
  return (
    a.type === b.type &&
    Math.abs(a.duration - b.duration) < 1e-6 &&
    (a.direction ?? "left") === (b.direction ?? "left") &&
    Math.abs((a.softness ?? DEFAULT_SOFTNESS) - (b.softness ?? DEFAULT_SOFTNESS)) < 1e-4 &&
    (a.color ?? "#ffffff") === (b.color ?? "#ffffff") &&
    Math.abs((a.intensity ?? 1) - (b.intensity ?? 1)) < 1e-4
  );
}

/** The longest bond these two clips can currently carry, from their geometry. */
export function maxBondDuration(project: Project, fromId: LayerId, toId: LayerId): number {
  const from = project.layers[fromId];
  const to = project.layers[toId];
  if (!from || !to) return 0;
  const lead = to.startTime - from.startTime;
  if (lead <= MIN_LAYER_DURATION) return 0;
  return Math.max(0, Math.min(MAX_BOND_OVERLAP, lead, to.duration));
}

/* ------------------------------------------------------------------ *
 * Reading junctions
 * ------------------------------------------------------------------ */

/** Every join on a track, left to right. */
export function junctionsOnTrack(project: Project, trackId: TrackId): Junction[] {
  const layers = layersOnTrack(project, trackId)
    .slice()
    .sort(
      (a, b) =>
        a.startTime - b.startTime || project.layerIds.indexOf(a.id) - project.layerIds.indexOf(b.id),
    );

  const out: Junction[] = [];
  for (let i = 0; i < layers.length - 1; i++) {
    const from = layers[i];
    const to = layers[i + 1];
    // Clips stacked on top of each other are not a sequence, so they cannot join.
    if (to.startTime - from.startTime <= MIN_LAYER_DURATION) continue;

    const gap = to.startTime - layerEnd(from);
    if (gap > JUNCTION_EPSILON) continue;
    if (gap < -maxBondDuration(project, from.id, to.id)) continue;

    const overlap = Math.max(0, -gap);
    out.push({
      trackId,
      from: from.id,
      to: to.id,
      seam: to.startTime,
      overlap,
      bonded: overlap > JUNCTION_EPSILON && !isNoopTransition(to.transitionIn),
      transition: { ...to.transitionIn },
    });
  }
  return out;
}

export interface LayerJunctions {
  in?: Junction;
  out?: Junction;
}

/** Per-clip view of a track's junctions, for the rows that draw the clips. */
export function junctionIndex(junctions: Junction[]): Map<LayerId, LayerJunctions> {
  const index = new Map<LayerId, LayerJunctions>();
  const slot = (id: LayerId) => {
    let entry = index.get(id);
    if (!entry) {
      entry = {};
      index.set(id, entry);
    }
    return entry;
  };
  for (const junction of junctions) {
    slot(junction.from).out = junction;
    slot(junction.to).in = junction;
  }
  return index;
}

/** The junction on one edge of a clip, or null when that edge ends the track. */
export function junctionAt(project: Project, layerId: LayerId, edge: "in" | "out"): Junction | null {
  const layer = project.layers[layerId];
  if (!layer) return null;
  return (
    junctionsOnTrack(project, layer.trackId).find((j) =>
      edge === "out" ? j.from === layerId : j.to === layerId,
    ) ?? null
  );
}

/* ------------------------------------------------------------------ *
 * Writing bonds
 * ------------------------------------------------------------------ */

/**
 * Bonds two touching clips with a transition of `duration` seconds, or re-sizes
 * an existing bond. Returns the project untouched when the pair is not a
 * junction, or when the transition asked for is "none"/"cut" — which is a
 * removal, and is routed to `clearBond`.
 *
 * The bond takes ownership of the overlap: it sets it to exactly `duration`,
 * growing or shrinking the outgoing clip's tail to suit. A pair that happened
 * to be dragged into an overlap is therefore absorbed rather than added to.
 */
export function applyBond(
  project: Project,
  fromId: LayerId,
  toId: LayerId,
  patch: Partial<Transition> = {},
): Project {
  const from = project.layers[fromId];
  const to = project.layers[toId];
  if (!from || !to || fromId === toId) return project;

  const transition: Transition = { ...to.transitionIn, ...patch };
  if (transition.type === "none" || transition.type === "cut") return clearBond(project, fromId, toId);

  const limit = maxBondDuration(project, fromId, toId);
  if (limit < MIN_BOND_OVERLAP) return project;

  const gap = to.startTime - layerEnd(from);
  const existing = Math.max(0, -gap);
  // Length policy: an explicit request wins; otherwise an existing bond keeps
  // the overlap the clips currently have, so changing a bond's colour or
  // direction never quietly re-times it. Re-bonding a plain cut falls back to
  // the length already stored on the transition.
  const requested = patch.duration ?? (existing > MIN_BOND_OVERLAP ? existing : transition.duration);
  const duration = clamp(requested > 0 ? requested : DEFAULT_BOND.duration, MIN_BOND_OVERLAP, limit);

  const next: Transition = { ...transition, duration };
  // Nothing to do — same length AND same resolved transition. Comparing the
  // whole transition, not just the length, is what lets a colour or direction
  // change through to the layer.
  if (Math.abs(duration - existing) < 1e-6 && sameTransition(next, to.transitionIn)) return project;

  // The incoming clip has to draw over the outgoing one through the overlap.
  let layerIds = project.layerIds;
  const fromIndex = layerIds.indexOf(fromId);
  const toIndex = layerIds.indexOf(toId);
  if (fromIndex > toIndex) {
    layerIds = [...layerIds];
    layerIds[fromIndex] = toId;
    layerIds[toIndex] = fromId;
  }

  return withNormalizedZ({
    ...project,
    layerIds,
    layers: {
      ...project.layers,
      [fromId]: {
        ...from,
        duration: from.duration + (duration - existing),
        transitionOut: { ...NO_TRANSITION },
      },
      [toId]: { ...to, transitionIn: next },
    },
  });
}

/**
 * Removes a bond, restoring a plain cut: the outgoing clip's tail is trimmed
 * back to the seam and the incoming clip's enter-ramp is cleared.
 */
export function clearBond(project: Project, fromId: LayerId, toId: LayerId): Project {
  const from = project.layers[fromId];
  const to = project.layers[toId];
  if (!from || !to) return project;

  const overlap = Math.max(0, layerEnd(from) - to.startTime);
  if (overlap < 1e-6 && isNoopTransition(to.transitionIn)) return project;

  return {
    ...project,
    layers: {
      ...project.layers,
      [fromId]: { ...from, duration: Math.max(MIN_LAYER_DURATION, from.duration - overlap) },
      [toId]: { ...to, transitionIn: { ...NO_TRANSITION } },
    },
  };
}

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

/** Does this junction hold real material for the outgoing clip's tail? */
export function bondHoldsLastFrame(layer: Layer, sourceDuration: number): boolean {
  if (layer.type !== "video" && layer.type !== "audio") return false;
  if (!sourceDuration) return false;
  return layer.inPoint + layer.duration >= sourceDuration - 1e-3;
}
