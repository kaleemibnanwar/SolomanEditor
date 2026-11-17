/**
 * USER SNAPSHOT TEMPLATES — reusable starting points, saved from real work.
 *
 * The editor ships with NO built-in templates. A template here is always a
 * SNAPSHOT of a project the agent (or person) already arranged, saved verbatim
 * so a later `create_from_template` opens the same rows, overlays, brand and
 * canvas without rebuilding from scratch. The MCP template tools
 * (`lib/mcp/templateTools.ts`) are the only surface that reads or writes these.
 *
 * Only the structure survives the round trip. Media layers (video / image /
 * audio) point at `blob:` URLs and decoded buffers that live for one session,
 * so they are dropped here; a snapshot keeps the settings (brand, aspect,
 * background), every row, and the overlay layers (text / sticker / effect)
 * that define the look. The agent brings the media back in with `import_media`.
 */
import { normalizeTracks } from "@/lib/tracks";
import { TEMPLATE_STORE, storeDelete, storeGetAll, storePut } from "@/lib/storage";
import { uid } from "@/lib/time";
import type { Layer, Project, StickerStyle, TextStyle } from "@/types/editor";

/** One changeable field a template exposes — the MOGRT "essential control". */
export interface TemplateSlot {
  name: string;
  description?: string;
  /** What the slot writes: "name" (the project title), or "<type>:<layerName>" / "<type>:*". */
  target: string;
}

export interface UserTemplate {
  id: string;
  name: string;
  blurb?: string;
  createdAt: number;
  project: Project;
  /** The fields a later create_from_template { slots } may override. */
  slots?: TemplateSlot[];
}

/** Layer types that are pure data and survive a reload — the visual overlay set. */
const SNAPSHOT_TYPES = new Set<Layer["type"]>(["text", "sticker", "effect"]);

/** The current project, reduced to what can round-trip. Does not mutate it. */
export function snapshotProject(project: Project): Project {
  const layers: Record<string, Layer> = {};
  const layerIds: string[] = [];
  for (const id of project.layerIds) {
    const layer = project.layers[id];
    if (!layer || !SNAPSHOT_TYPES.has(layer.type)) continue;
    layers[id] = layer;
    layerIds.push(id);
  }
  return {
    id: "",
    settings: { ...project.settings },
    layers,
    layerIds,
    trackIds: [...project.trackIds],
    tracks: { ...project.tracks },
  };
}

/** Rebuilds a snapshot as a fresh, blank-id project ready to edit. */
export function instantiateSnapshot(snapshot: Project, name: string): Project {
  const trackIdMap = new Map<string, string>();
  for (const oldId of snapshot.trackIds) trackIdMap.set(oldId, uid("track"));

  const tracks: Project["tracks"] = {};
  for (const [oldId, track] of Object.entries(snapshot.tracks)) {
    const id = trackIdMap.get(oldId) ?? uid("track");
    tracks[id] = { ...track, id };
  }

  const layers: Record<string, Layer> = {};
  const layerIds: string[] = [];
  for (const oldId of snapshot.layerIds) {
    const layer = snapshot.layers[oldId];
    if (!layer) continue;
    const id = uid("layer");
    const trackId = trackIdMap.get(layer.trackId);
    layers[id] = { ...layer, id, trackId: trackId ?? layer.trackId, assetId: undefined };
    layerIds.push(id);
  }

  const trackIds = snapshot.trackIds.map((oldId) => trackIdMap.get(oldId) ?? oldId);
  return normalizeTracks({
    id: uid("project"),
    settings: { ...snapshot.settings, name },
    layers,
    layerIds,
    trackIds,
    tracks,
  });
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

export async function listUserTemplates(): Promise<UserTemplate[]> {
  const templates = await storeGetAll<UserTemplate>(TEMPLATE_STORE);
  return templates.sort((a, b) => b.createdAt - a.createdAt);
}

/** Look one up by id, or by exact name when the id does not match. */
export async function getUserTemplate(idOrName: string): Promise<UserTemplate | undefined> {
  const templates = await listUserTemplates();
  return (
    templates.find((template) => template.id === idOrName) ??
    templates.find((template) => template.name.trim().toLowerCase() === idOrName.trim().toLowerCase())
  );
}

export async function saveUserTemplate(
  name: string,
  blurb: string | undefined,
  project: Project,
  slots?: TemplateSlot[],
): Promise<UserTemplate> {
  const template: UserTemplate = {
    id: uid("template"),
    name,
    blurb,
    createdAt: Date.now(),
    project: snapshotProject(project),
    slots: slots?.length ? slots : undefined,
  };
  await storePut(TEMPLATE_STORE, template);
  return template;
}

export async function deleteUserTemplate(id: string): Promise<void> {
  await storeDelete(TEMPLATE_STORE, id);
}

/* ------------------------------------------------------------------ *
 * Slot application — the changeable fields a snapshot exposes
 * ------------------------------------------------------------------ */

/**
 * Overrides a snapshot's declared slots with the caller's values, on a copy.
 *
 * A slot's `target` decides what it writes:
 *   · "name"                — the project title
 *   · "text:<name>"         — the text layer(s) named <name> (their content)
 *   · "sticker:<name>"      — the sticker layer(s) named <name> (their fill)
 *   · "text:*" / "sticker:*" — every layer of that type
 *
 * Unmatched slot values are reported, not silently dropped — the caller should
 * know their override landed nowhere rather than assume it did.
 */
export function applySnapshotSlots(
  project: Project,
  slots: TemplateSlot[] | undefined,
  values: Record<string, string>,
): { project: Project; applied: string[]; missing: string[] } {
  const defs = new Map((slots ?? []).map((slot) => [slot.name, slot]));
  const applied: string[] = [];
  const missing: string[] = [];

  let next = project;
  for (const [key, value] of Object.entries(values)) {
    const def = defs.get(key);
    if (!def) {
      missing.push(key);
      continue;
    }

    if (def.target === "name") {
      next = { ...next, settings: { ...next.settings, name: value } };
      applied.push(key);
      continue;
    }

    const [type, name] = def.target.split(":");
    const match = (layer: Layer) => layer.type === type && (name === "*" || layer.name === name);
    let touched = 0;

    if (type === "text") {
      const layers = { ...next.layers };
      for (const id of next.layerIds) {
        const layer = layers[id];
        if (!layer || !match(layer)) continue;
        layers[id] = { ...layer, text: { ...(layer.text as TextStyle), content: value } };
        touched += 1;
      }
      next = { ...next, layers };
    } else if (type === "sticker") {
      const layers = { ...next.layers };
      for (const id of next.layerIds) {
        const layer = layers[id];
        if (!layer || !match(layer)) continue;
        layers[id] = { ...layer, sticker: { ...(layer.sticker as StickerStyle), fill: value } };
        touched += 1;
      }
      next = { ...next, layers };
    } else {
      missing.push(`${key} (unknown slot target "${def.target}")`);
      continue;
    }

    if (touched) applied.push(key);
    else missing.push(`${key} (matched nothing for "${def.target}")`);
  }

  return { project: next, applied, missing };
}
