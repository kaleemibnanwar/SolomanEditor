/**
 * THE FLOWS — the multi-step editorial operations.
 *
 * `tools.ts` is one operation per call: move a clip, set a transition. This file
 * is the other half of an editor's vocabulary — the things that are only
 * *one* thing when you stop thinking in mutations. A rough cut, a three-point
 * edit, a J-cut, a picture-lock pass: each is a dozen store actions that only
 * make sense together, and each is exactly one of these calls.
 *
 * What makes a flow a flow rather than a macro is that it computes values the
 * agent cannot know. `flow_assembly_cut` advances its cursor by each shot's
 * REAL length, because a take whose source runs short must not leave a hole —
 * and only the editor can say how long a shot actually is. `flow_push_in`
 * starts from the scale the clip has AT THAT MOMENT, after its own keyframes are
 * evaluated. `flow_picture_lock` reads the geometry of the cut before touching
 * anything. Where a fact only exists after the plan has run — the assembled end,
 * how much a ripple actually pulled back, how much speech survived a silence
 * trim — the flow reports it through `applyPlan`'s `after` hook rather than
 * guessing in advance.
 *
 * Everything here is still just a `Step[]`. One call is one undo step, whatever
 * it compiled to, and every individual change goes through the same store action
 * a human click would use.
 */
import { evaluateLayer } from "@/lib/anim";
import { JUNCTION_EPSILON, junctionsOnTrack } from "@/lib/bonds";
import { getBaseSize } from "@/lib/compositor";
import { BACKGROUND_PRESETS, FILTER_LOOKS, TEXT_PRESETS } from "@/lib/library";
import { createTextLayer, layerEnd, orderedLayers, projectDuration } from "@/lib/project";
import { layersOnTrack, mainTrackId } from "@/lib/tracks";
import { clamp, round } from "@/lib/time";
import {
  EASINGS,
  WRITE,
  argBool,
  argNumber,
  argString,
  argStringList,
  applyPlan,
  bool,
  choice,
  hasKeys,
  layerOf,
  need,
  needNumber,
  num,
  object,
  presetOf,
  present,
  str,
  strList,
  targets,
} from "@/lib/mcp/kit";
import type { ToolDefinition } from "@/lib/mcp/kit";
import { resolveTargets } from "@/lib/mcp/observe";
import type { JsonSchema } from "@/lib/mcp/protocol";
import { toolError } from "@/lib/mcp/protocol";
import type { AssembleClip, Step } from "@/lib/mcp/steps";
import { editor } from "@/store/editorStore";
import type { Easing, Layer, LayerGrade, LayerId, TextStyle } from "@/types/editor";

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

const secs = (value: number) => `${round(value, 2)}s`;
const quoted = (names: string[]) => names.map((name) => `"${name}"`).join(", ");

const isPicture = (layer: Layer) => layer.type === "video" || layer.type === "image";
const isTimed = (layer: Layer) => layer.type === "video" || layer.type === "audio";

/** Clips are addressed by id; a name is only ever used to explain one. */
const namesOf = (ids: string[]) =>
  quoted(ids.map((id) => editor().project.layers[id]?.name ?? "(gone)"));

/** The main visual sequence, left to right — the row a picture edit works on. */
function mainPicture(): Layer[] {
  const trackId = mainTrackId(editor().project);
  if (!trackId) return [];
  return layersOnTrack(editor().project, trackId)
    .filter(isPicture)
    .sort((a, b) => a.startTime - b.startTime);
}

/**
 * The clips a sequence-wide flow should act on: the ones it named, else the
 * human's selection (what they were pointing at), else the whole main picture
 * row. A named id that does not exist is an error; a stale selection entry is
 * simply skipped, because that is not the agent's mistake.
 */
function sequence(args: Record<string, unknown>, key = "clipIds"): LayerId[] {
  const named = argStringList(args, key);
  if (named?.length) {
    for (const id of named) layerOf(id);
    return [...new Set(named)];
  }
  const selected = resolveTargets(editor(), undefined).filter((id) => !!editor().project.layers[id]);
  if (selected.length) return selected;

  const picture = mainPicture().map((layer) => layer.id);
  if (!picture.length) {
    throw new Error(
      "Nothing to work on — nothing is selected and the main layer is empty. Pass clipIds, or lay a cut down first with flow_assembly_cut.",
    );
  }
  return picture;
}

/** The topmost clip the playhead is sitting over. */
function clipAtPlayhead(): Layer | undefined {
  const at = editor().currentTime;
  const crossing = orderedLayers(editor().project).filter(
    (layer) => at >= layer.startTime && at < layerEnd(layer) - 1e-6,
  );
  return crossing[crossing.length - 1];
}

/** The junction on any row whose seam is closest to the playhead. */
function nearestJunction(): { from: string; to: string; seam: number } | undefined {
  const project = editor().project;
  const all = project.trackIds.flatMap((trackId) => junctionsOnTrack(project, trackId));
  if (!all.length) return undefined;
  return all.reduce((best, junction) =>
    Math.abs(junction.seam - editor().currentTime) < Math.abs(best.seam - editor().currentTime) ? junction : best,
  );
}

/** Coerce a raw JSON array into `AssembleClip`s, dropping anything unusable. */
function argClips(args: Record<string, unknown>, key: string): AssembleClip[] {
  const value = args[key];
  if (!Array.isArray(value)) return [];
  const out: AssembleClip[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const assetId = typeof record.assetId === "string" && record.assetId ? record.assetId : undefined;
    if (!assetId) continue;
    const inPoint = argNumber(record, "inPoint");
    const duration = argNumber(record, "duration");
    out.push(present<AssembleClip>({ assetId, inPoint, duration }) as AssembleClip);
  }
  return out;
}

/**
 * A fade in and out, as four opacity keyframes.
 *
 * Four, not two: the hold in the middle is what makes a title sit at full
 * strength instead of sliding up and immediately back down. `at` is in timeline
 * seconds — the executor converts to the layer-local time the store keeps.
 */
function fadeSteps(ref: string, start: number, duration: number, fade: number): Step[] {
  const span = Math.min(fade, duration / 3);
  if (span < 0.02) return [];
  return [
    { kind: "setKeyframes", id: ref, action: "add", prop: "opacity", at: start, value: 0 },
    { kind: "setKeyframes", id: ref, action: "add", prop: "opacity", at: start + span, value: 1, easing: "easeOut" },
    { kind: "setKeyframes", id: ref, action: "add", prop: "opacity", at: start + duration - span, value: 1 },
    { kind: "setKeyframes", id: ref, action: "add", prop: "opacity", at: start + duration, value: 0, easing: "easeIn" },
  ];
}

/** A transition that is actually doing something on one edge. */
const rampOf = (layer: Layer, edge: "in" | "out") => {
  const transition = edge === "in" ? layer.transitionIn : layer.transitionOut;
  const active = transition.type !== "none" && transition.type !== "cut" && transition.duration > 0;
  return active ? transition : null;
};

const ASSEMBLE_CLIP_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    assetId: str("Asset id from list_assets."),
    inPoint: num("Seconds into the source media this shot starts from. Defaults to 0.", { minimum: 0 }),
    duration: num("Seconds of source to use. Defaults to everything left from inPoint.", { minimum: 0.06 }),
  },
  required: ["assetId"],
  additionalProperties: false,
};

/** Sum of an id list's clip lengths, read live. */
const totalLength = (ids: string[]) =>
  ids.reduce((sum, id) => sum + (editor().project.layers[id]?.duration ?? 0), 0);

/* ------------------------------------------------------------------ *
 * The flows
 * ------------------------------------------------------------------ */

export const FLOWS: ToolDefinition[] = [
  /* ------------------------------ assemble and cut ------------------------------ */
  {
    name: "flow_assembly_cut",
    title: "Assemble a rough cut",
    description:
      "The assembly: a list of shots laid end to end on one row, each starting exactly where the last one ended. This is how a first cut is built — one call, one undo step. The plan advances by each shot's REAL length on the timeline, so a take whose source runs short butts the next shot against it instead of leaving a hole (which is the arithmetic an agent cannot do from asset durations alone). Every seam it leaves is a junction, so transitions can be bonded onto it afterwards. Expect the result to be too long: an assembly only has to prove the material covers the story.",
    inputSchema: object(
      {
        clips: {
          type: "array",
          description:
            "The running order. Each entry is { assetId, inPoint?, duration? } — a take, where it starts in the source, and how much of it to use.",
          items: ASSEMBLE_CLIP_SCHEMA,
          minItems: 1,
        },
        start: num("Where the assembly begins on the timeline, in seconds. Defaults to 0.", { minimum: 0 }),
        trackId: str("Row to build on. Omit for the main layer, which is where pictures belong."),
        replace: bool(
          "Remove everything already on that row before assembling, so this replaces the cut rather than adding to it. Defaults to false.",
        ),
      },
      ["clips"],
    ),
    annotations: WRITE,
    run: (args) => {
      const clips = argClips(args, "clips");
      if (!clips.length) {
        return toolError(
          'flow_assembly_cut needs "clips": a non-empty list of { assetId, inPoint, duration }. Call list_assets for the asset ids and get_timeline to see what is already cut.',
        );
      }
      const badIndex = clips.findIndex(
        (clip) => (clip.duration !== undefined && clip.duration <= 0) || (clip.inPoint !== undefined && clip.inPoint < 0),
      );
      if (badIndex >= 0) {
        return toolError(`clips[${badIndex}] has a duration of zero or less, or a negative inPoint — both must be positive.`);
      }

      const state = editor();
      const missing = [...new Set(clips.map((clip) => clip.assetId))].filter((id) => !state.assets[id]);
      if (missing.length) {
        return toolError(`No asset with id "${missing[0]}" — call list_assets for what is in the bin.`, { missing });
      }

      const trackId = argString(args, "trackId") ?? mainTrackId(state.project);
      if (!trackId || !state.project.tracks[trackId]) {
        return toolError("No row to assemble onto. Call get_timeline to see the rows, or call manage_track to add one.");
      }

      const steps: Step[] = [];
      const notes: string[] = [];

      if (argBool(args, "replace")) {
        const doomed = layersOnTrack(state.project, trackId).map((layer) => layer.id);
        if (doomed.length) {
          steps.push({ kind: "remove", ids: doomed });
          notes.push(`replaced ${doomed.length} clip(s) already on "${state.project.tracks[trackId].name}"`);
        }
      }

      steps.push({ kind: "assemble", clips, start: argNumber(args, "start") ?? 0, trackId });

      return applyPlan("flow_assembly_cut", steps, {
        notes,
        after: (report) => {
          const placed = report.created
            .map((id) => editor().project.layers[id])
            .filter((layer): layer is Layer => !!layer);
          if (!placed.length) return;
          const last = placed[placed.length - 1];
          return {
            notes: [
              `${placed.length} shot${placed.length === 1 ? "" : "s"} of screen time: ${secs(totalLength(report.created))}`,
              `the cut runs ${secs(placed[0].startTime)} → ${secs(layerEnd(last))}`,
            ],
            extra: {
              shotCount: placed.length,
              startsAt: round(placed[0].startTime, 3),
              endsAt: round(layerEnd(last), 3),
            },
          };
        },
      });
    },
  },
  {
    name: "flow_three_point_edit",
    title: "Three-point edit",
    description:
      "The canonical NLE move: an in and an out marked in the SOURCE plus one point in the SEQUENCE, and the edit fills the space between them. Overwrite lands the shot on top of whatever is there, splitting the existing clips at both edit points so the join is clean and the timeline keeps its length; insert splits at the record point and ripples everything after it later, so nothing is lost and the piece gets longer. Use it when the material and the hole are already decided.",
    inputSchema: object(
      {
        assetId: str("Asset id from list_assets — the shot being edited in."),
        sourceIn: num("Where in the source media the shot starts, in seconds.", { minimum: 0 }),
        sourceOut: num("Where in the source media it ends, in seconds. The length used is sourceOut − sourceIn.", { minimum: 0 }),
        recordIn: num("Where in the SEQUENCE the shot lands, in timeline seconds.", { minimum: 0 }),
        mode: choice(
          "\"overwrite\" replaces what is under the record range and leaves the timeline length alone; \"insert\" makes room and pushes everything after the point later.",
          ["overwrite", "insert"],
        ),
        trackId: str("Row to edit into. Omit for the main layer."),
      },
      ["assetId", "sourceIn", "sourceOut", "recordIn"],
    ),
    annotations: WRITE,
    run: (args) => {
      const assetId = need(args, "assetId");
      if (!editor().assets[assetId]) {
        return toolError(`No asset with id "${assetId}" — call list_assets for what is in the bin.`);
      }
      const sourceIn = needNumber(args, "sourceIn");
      const sourceOut = needNumber(args, "sourceOut");
      if (sourceOut <= sourceIn) {
        return toolError(`sourceOut (${sourceOut}s) must be after sourceIn (${sourceIn}s) — the length used is sourceOut − sourceIn.`);
      }
      const mode = (argString(args, "mode") ?? "overwrite") as "insert" | "overwrite";
      const recordIn = needNumber(args, "recordIn");

      return applyPlan(
        "flow_three_point_edit",
        [
          {
            kind: "threePointEdit",
            assetId,
            sourceIn,
            sourceOut,
            recordIn,
            mode,
            ...present({ trackId: argString(args, "trackId") }),
          },
        ],
        {
          notes: [
            mode === "insert"
              ? `inserted ${secs(sourceOut - sourceIn)} — everything after ${secs(recordIn)} on that row moved later, so the timeline is longer`
              : `overwrote ${secs(sourceOut - sourceIn)} at ${secs(recordIn)} — the material underneath is gone and the timeline keeps its length`,
          ],
          after: (report) => {
            const layer = report.created[0] ? editor().project.layers[report.created[0]] : undefined;
            if (!layer) return;
            return {
              notes: [`"${layer.name}" now runs ${secs(layer.startTime)} → ${secs(layerEnd(layer))}`],
              extra: { clipId: layer.id, start: round(layer.startTime, 3), end: round(layerEnd(layer), 3) },
            };
          },
        },
      );
    },
  },
  {
    name: "flow_ripple_delete",
    title: "Ripple delete clips",
    description:
      "Remove clips and close the gaps they leave: everything after a removed clip on that same row slides back by its length, so the cut becomes tighter instead of gaining a hole. This is the tool for taking time out of a piece — use delete_clips when the gap should stay. Because it only ripples the row the clip was on, other rows keep their times, and the step says so when the timeline length changes.",
    inputSchema: object({
      clipIds: strList("The clips to remove and close up. Defaults to the current selection.", { minItems: 1 }),
    }),
    annotations: { ...WRITE, destructiveHint: true },
    run: (args) => {
      const ids = targets(args);
      const layers = ids.map(layerOf);
      const project = editor().project;
      const before = projectDuration(project);

      // Earliest first, so each ripple happens against the row as it stands.
      const ordered = [...layers].sort(
        (a, b) => a.trackId.localeCompare(b.trackId) || a.startTime - b.startTime,
      );
      const steps: Step[] = ordered.map((layer) => ({ kind: "rippleDelete", id: layer.id }) as Step);

      // A bonded join depends on both clips being where they are, so removing
      // one of them takes the transition with it. Worth saying out loud.
      const bonded = project.trackIds
        .flatMap((trackId) => junctionsOnTrack(project, trackId))
        .filter((junction) => junction.bonded);
      const breaking = layers.filter((layer) =>
        bonded.some((junction) => junction.from === layer.id || junction.to === layer.id),
      );

      return applyPlan("flow_ripple_delete", steps, {
        notes: [
          `${quoted(ordered.map((layer) => layer.name))} — ${secs(ordered.reduce((sum, layer) => sum + layer.duration, 0))} coming out`,
          ...(breaking.length
            ? [`${namesOf(breaking.map((layer) => layer.id))} ${breaking.length === 1 ? "is" : "are"} part of a transition bond — rippling ${breaking.length === 1 ? "it" : "them"} breaks that join`]
            : []),
          "only the rows these clips were on are rippled — clips on other rows keep their times",
        ],
        after: () => {
          const after = projectDuration(editor().project);
          return {
            notes: [`timeline ${secs(before)} → ${secs(after)} (${secs(Math.max(0, before - after))} shorter)`],
            extra: { durationBefore: round(before, 3), durationAfter: round(after, 3), saved: round(Math.max(0, before - after), 3) },
          };
        },
      });
    },
  },
  {
    name: "flow_split_edit",
    title: "Split edit (J-cut / L-cut)",
    description:
      "Set the sound and the picture of two touching clips to change at DIFFERENT moments — the move that makes cutting feel invisible. A J-cut brings the incoming shot's audio in before its picture (the audience hears the scene coming); an L-cut lets the outgoing shot's audio run on under the next picture (the scene is felt before it is seen). Pick the junction with clipIds, or omit them to use the junction nearest the playhead. Note that this editor has no detached audio, so the sound and picture of each clip are ramped together across the overlap — the stack order is what makes the cut read as a J or an L.",
    inputSchema: object(
      {
        mode: choice("J brings the next shot's audio in early; L lets the current shot's audio run on.", ["j", "l"]),
        overlap: num("How long the two shots overlap, in seconds. 0.5–1.5s is the useful range; keep split edits shorter than the shots they join.", {
          minimum: 0.05,
          maximum: 10,
        }),
        clipIds: strList("Exactly two clips, the outgoing one first. Omit to use the junction nearest the playhead."),
      },
      ["mode", "overlap"],
    ),
    annotations: WRITE,
    run: (args) => {
      const mode = need(args, "mode") as "j" | "l";
      const overlap = needNumber(args, "overlap");
      const named = argStringList(args, "clipIds");
      const project = editor().project;

      let from: Layer;
      let to: Layer;
      let seam: number;

      if (named) {
        if (named.length !== 2) {
          return toolError(
            "Give exactly two clipIds — the outgoing clip first, the incoming one second — or omit them to use the junction nearest the playhead.",
          );
        }
        from = layerOf(named[0]);
        to = layerOf(named[1]);
        if (from.trackId !== to.trackId) {
          return toolError(`"${from.name}" and "${to.name}" are on different rows — a split edit joins two clips that touch on one row.`);
        }
        const junction = junctionsOnTrack(project, from.trackId).find(
          (entry) => entry.from === from.id && entry.to === to.id,
        );
        if (!junction) {
          return toolError(
            `"${from.name}" and "${to.name}" are not a junction — "to" must start where "from" ends (order matters). Call get_timeline to see the junctions.`,
          );
        }
        seam = junction.seam;
      } else {
        const junction = nearestJunction();
        if (!junction) {
          return toolError(
            "There is no junction to split — a split edit needs two clips that touch. Lay shots end to end with flow_assembly_cut first, or pass clipIds.",
          );
        }
        from = layerOf(junction.from);
        to = layerOf(junction.to);
        seam = junction.seam;
      }

      const steps: Step[] = [];
      const notes: string[] = [];

      if (mode === "l") {
        // The outgoing shot's tail — and therefore its sound — extends past the
        // seam, while the incoming shot is stacked in front so its picture is
        // what shows across the overlap.
        const source = from.assetId ? editor().assets[from.assetId] : undefined;
        steps.push({ kind: "setTiming", id: from.id, duration: round(from.duration + overlap, 4) });
        steps.push({ kind: "patchLayer", id: from.id, patch: { audioFadeOut: overlap } });
        steps.push({ kind: "patchLayer", id: to.id, patch: { audioFadeIn: overlap } });
        steps.push({ kind: "reorder", id: to.id, direction: "top" });

        notes.push(
          `L-cut: "${to.name}" is stacked in front, so its picture takes over at ${secs(seam)} while "${from.name}"'s sound runs on beneath it for ${secs(overlap)}.`,
        );
        if (source?.duration && from.inPoint + from.duration + overlap > source.duration + 1e-3) {
          notes.push(
            `"${from.name}" has no material past its out point, so its last frame is held (frozen) for the overlap — trim it back or pick a shorter overlap if that is visible.`,
          );
        }
      } else {
        // The incoming shot starts earlier, so its sound arrives first; the
        // outgoing shot is stacked in front to hold the picture across the join.
        const shift = Math.min(overlap, to.inPoint, to.startTime);
        if (shift < overlap - 1e-3) {
          notes.push(
            `the overlap was reduced to ${secs(shift)} — "${to.name}" has only that much room before its source in-point (or the start of the timeline).`,
          );
        }
        steps.push({
          kind: "setTiming",
          id: to.id,
          start: round(to.startTime - shift, 4),
          inPoint: round(to.inPoint - shift, 4),
          duration: round(to.duration + shift, 4),
        });
        steps.push({ kind: "patchLayer", id: from.id, patch: { audioFadeOut: shift } });
        steps.push({ kind: "patchLayer", id: to.id, patch: { audioFadeIn: shift } });
        steps.push({ kind: "reorder", id: from.id, direction: "top" });

        notes.push(
          `J-cut: "${from.name}" is stacked in front, so its picture holds across the ${secs(shift)} overlap at ${secs(seam)} while "${to.name}"'s sound arrives early.`,
        );
      }

      notes.push(
        "the two audio fade lengths are the only thing carrying the split — check the join with whats_on_screen before moving on",
      );
      return applyPlan("flow_split_edit", steps, { notes });
    },
  },

  /* ------------------------------ graphics ------------------------------ */
  {
    name: "flow_title_sequence",
    title: "Build a title sequence",
    description:
      "An opening title: a headline, an optional subtitle under it, and a fade in and out so it does not appear and vanish abruptly. Optionally puts a background plate behind it first, for a piece that opens on a card rather than on footage. The titles go on their own rows in front of the picture, which is where they belong — they are drawn over the main layer automatically.",
    inputSchema: object(
      {
        title: str("The headline text. Use \\n for a line break.", { minLength: 1 }),
        subtitle: str("A second, smaller line under the headline."),
        start: num("When the title appears, in timeline seconds. Defaults to 0.", { minimum: 0 }),
        duration: num("How long it stays on screen, in seconds. Defaults to 3.5.", { minimum: 0.5 }),
        presetId: choice("A text preset for the headline.", TEXT_PRESETS.map((preset) => preset.id)),
        background: choice("A background plate to open on. Omit to leave the project's own background showing.", BACKGROUND_PRESETS.map((preset) => preset.id)),
        fade: num("Fade up and down length in seconds. Defaults to 0.4.", { minimum: 0, maximum: 3 }),
      },
      ["title"],
    ),
    annotations: WRITE,
    run: (args) => {
      const title = need(args, "title");
      const subtitle = argString(args, "subtitle");
      const start = argNumber(args, "start") ?? 0;
      const duration = Math.max(0.5, argNumber(args, "duration") ?? 3.5);
      const fade = clamp(argNumber(args, "fade") ?? 0.4, 0, duration / 3);
      const preset = presetOf("text preset", TEXT_PRESETS, argString(args, "presetId") ?? "title");
      const background = argString(args, "background");
      if (background) presetOf("background preset", BACKGROUND_PRESETS, background);

      const settings = editor().project.settings;
      const steps: Step[] = [];

      if (background) {
        steps.push({ kind: "addBackground", presetId: background, start, duration });
      }

      // Refs are positional, so the index of each text step is what a later
      // step addresses — that is why they are captured rather than assumed.
      const titleIndex = steps.length;
      steps.push({
        kind: "addText",
        content: title,
        text: { ...preset.text, content: title, align: "center" },
        start,
        duration,
        x: settings.width / 2,
        y: Math.round(settings.height * 0.44),
        name: title.split("\n")[0].slice(0, 32),
      });
      steps.push(...fadeSteps(`$${titleIndex}`, start, duration, fade));

      if (subtitle) {
        const caption = presetOf("text preset", TEXT_PRESETS, "caption");
        const subtitleIndex = steps.length;
        steps.push({
          kind: "addText",
          content: subtitle,
          text: { ...caption.text, content: subtitle, align: "center", backgroundColor: "transparent" },
          start,
          duration,
          x: settings.width / 2,
          y: Math.round(settings.height * 0.44 + settings.height * 0.11),
          name: subtitle.slice(0, 32),
        });
        steps.push(...fadeSteps(`$${subtitleIndex}`, start, duration, fade));
      }

      return applyPlan("flow_title_sequence", steps, {
        notes: [
          `${titleIndex ? "title" : "title"} card on screen ${secs(start)} → ${secs(start + duration)}`,
          fade > 0.02
            ? `fading in over ${secs(fade)} and out over ${secs(fade)}, held at full strength between`
            : "no fade — it cuts on and off",
          ...(background ? [`opened on the "${presetOf("background preset", BACKGROUND_PRESETS, background).label}" plate`] : []),
        ],
      });
    },
  },
  {
    name: "flow_lower_third",
    title: "Add a lower third",
    description:
      "Name someone over their own clip: a name and optional role, placed low in the frame and clear of the edges, timed against the shot rather than against the timeline. Give a clipId and the plate lands 0.8s into that shot and ends with it — which is the difference between a graphic and a graphic that is still on screen after the shot has gone. The placement is measured from the real text block, so a long name does not run off the frame.",
    inputSchema: object(
      {
        name: str("The person's name.", { minLength: 1 }),
        role: str("Their role or title, on a second line."),
        clipId: str("The clip to name, so the plate is timed to it. Defaults to the clip under the playhead."),
        at: num("When the plate appears, in timeline seconds. Defaults to 0.8s into the clip, or the playhead."),
        duration: num("How long it stays up, in seconds. Defaults to 4, capped at the end of the clip.", { minimum: 0.5 }),
        side: choice("Which side of the frame it sits on.", ["left", "right"]),
      },
      ["name"],
    ),
    annotations: WRITE,
    run: (args) => {
      const name = need(args, "name");
      const role = argString(args, "role");
      const side = (argString(args, "side") ?? "left") as "left" | "right";
      const state = editor();

      const clipId = argString(args, "clipId");
      const target = clipId ? layerOf(clipId) : clipAtPlayhead();
      const wantsDuration = argNumber(args, "duration") ?? 4;
      const at = argNumber(args, "at") ?? (target ? target.startTime + 0.8 : state.currentTime);

      const notes: string[] = [];
      let duration = Math.max(0.5, wantsDuration);
      if (target) {
        const room = layerEnd(target) - at;
        if (room < 0.5) {
          return toolError(
            `"${target.name}" ends at ${secs(layerEnd(target))}, so there is no room for a plate from ${secs(at)} — move the time earlier or pick another clip.`,
          );
        }
        if (duration > room) {
          notes.push(`shortened to ${secs(room)} so the plate ends with "${target.name}"`);
          duration = room;
        }
      } else {
        notes.push("no clip given and none under the playhead — the plate is timed against the timeline, not a shot");
      }

      const settings = state.project.settings;
      const preset = presetOf("text preset", TEXT_PRESETS, "lowerThird");
      const content = role ? `${name}\n${role}` : name;

      // The block is measured from a throwaway layer so the margins are real:
      // `x` is the block's CENTRE, so a left-aligned plate is half its own width
      // in from the margin, not at it.
      const probe = createTextLayer(settings, 0, content);
      probe.text = { ...(probe.text as TextStyle), ...preset.text, content, align: side === "right" ? "right" : "left" };
      const block = getBaseSize(probe, settings, state.assets);
      const marginX = settings.width * 0.06;
      const marginY = settings.height * 0.12;
      const x = side === "right" ? settings.width - marginX - block.width / 2 : marginX + block.width / 2;
      const y = settings.height - marginY - block.height / 2;

      return applyPlan(
        "flow_lower_third",
        [
          {
            kind: "addText",
            content,
            text: { ...preset.text, content, align: side === "right" ? "right" : "left" },
            start: at,
            duration,
            x: Math.round(x),
            y: Math.round(y),
            name: name.slice(0, 32),
          },
        ],
        {
          notes: [
            `${side} side, ${secs(at)} → ${secs(at + duration)}${target ? ` (against "${target.name}")` : ""}`,
            ...notes,
          ],
        },
      );
    },
  },
  {
    name: "flow_grade_sequence",
    title: "Grade a sequence",
    description:
      "Give a whole sequence one look in a single call, so nothing drifts clip to clip. A look replaces each clip's filters and grade together — it is designed to sit on a neutral baseline — and any grade values you also pass are applied on top of it for the whole sequence, which is where a temperature or a vignette for the whole piece belongs. Grade for consistency first; adjust individual clips afterwards with set_clip_grade.",
    inputSchema: object(
      {
        lookId: choice("Which look. list_library with section \"filters\" lists them.", FILTER_LOOKS.map((look) => look.id)),
        clipIds: strList("The clips to grade. Defaults to the selection, else the whole main picture sequence."),
        temperature: num("Cool to warm, -1 to 1.", { minimum: -1, maximum: 1 }),
        tint: num("Green to magenta, -1 to 1.", { minimum: -1, maximum: 1 }),
        fade: num("Lifted, milky blacks, 0 to 1.", { minimum: 0, maximum: 1 }),
        vignette: num("Corner darkening, 0 to 1.", { minimum: 0, maximum: 1 }),
        grain: num("Film grain, 0 to 1.", { minimum: 0, maximum: 1 }),
      },
      ["lookId"],
    ),
    annotations: WRITE,
    run: (args) => {
      const lookId = need(args, "lookId");
      const look = presetOf("filter look", FILTER_LOOKS, lookId);
      const wanted = sequence(args);
      const ids = wanted.filter((id) => layerOf(id).type !== "audio");
      if (!ids.length) {
        return toolError("Only audio clips were given — filters and grade affect picture, not sound.");
      }

      const grade = present<Partial<LayerGrade>>({
        temperature: argNumber(args, "temperature"),
        tint: argNumber(args, "tint"),
        fade: argNumber(args, "fade"),
        vignette: argNumber(args, "vignette"),
        grain: argNumber(args, "grain"),
      });

      const steps: Step[] = [{ kind: "applyLook", ids, lookId }];
      if (hasKeys(grade)) steps.push({ kind: "setGrade", ids, grade });

      const skipped = wanted.length - ids.length;
      return applyPlan("flow_grade_sequence", steps, {
        notes: [
          `"${look.name}" applied to ${ids.length} clip(s) — ${look.hint}`,
          ...(hasKeys(grade) ? [`then ${Object.keys(grade).join(", ")} adjusted across the same clips`] : []),
          ...(skipped ? [`${skipped} audio clip(s) left alone`] : []),
        ],
      });
    },
  },

  /* ------------------------------ pace and structure ------------------------------ */
  {
    name: "flow_beat_cut",
    title: "Cut on the beat",
    description:
      "Lay clips onto a musical pulse: each clip's start is moved to the nearest beat at or after the previous clip's end, so the cuts land on the music instead of near it. With `beatsPerClip` every clip is also trimmed to a whole number of beats, which makes the row continuous and the pace uniform — that is the version that reads as a montage. Without it the shots keep their lengths and move onto the grid, so a gap of up to one beat can stay open. Give the tempo as `bpm` or as `beat` in seconds.",
    inputSchema: object(
      {
        clipIds: strList("The shots to place. Defaults to the selection, else the whole main picture sequence."),
        bpm: num("Tempo in beats per minute — 120 is 0.5s per beat.", { minimum: 20, maximum: 300 }),
        beat: num("Or the beat length directly, in seconds.", { minimum: 0.05, maximum: 3 }),
        beatsPerClip: num("Trim every clip to this many beats, making the row continuous. Omit to only move clips onto the grid.", {
          minimum: 0.25,
          maximum: 32,
        }),
        offset: num("The timeline second beat 1 sits on. Defaults to the earliest clip's start.", { minimum: 0 }),
        trackId: str("Move the shots onto this row as well. Omit to leave them where they are."),
      },
      [],
    ),
    annotations: WRITE,
    run: (args) => {
      const ids = sequence(args);
      const bpm = argNumber(args, "bpm");
      const beatArg = argNumber(args, "beat");
      if (!bpm && !beatArg) {
        return toolError('Give the tempo — either "bpm" (e.g. 120) or "beat" (seconds per beat, e.g. 0.5).');
      }
      const beat = beatArg && beatArg > 0 ? beatArg : 60 / (bpm as number);
      if (beat < 0.05) {
        return toolError(`A beat of ${round(beat, 3)}s is too fast to cut to — that is ${Math.round(60 / beat)} BPM.`);
      }

      const trackId = argString(args, "trackId");
      if (trackId && !editor().project.tracks[trackId]) {
        return toolError(`No row with id "${trackId}" — call get_timeline for the rows.`);
      }

      const layers = ids.map(layerOf).sort((a, b) => a.startTime - b.startTime);
      const base = argNumber(args, "offset") ?? Math.min(...layers.map((layer) => layer.startTime));
      const perClip = argNumber(args, "beatsPerClip");
      const beats = perClip && perClip > 0 ? Math.round(perClip) : undefined;

      // The grid is computed from the clips' CURRENT lengths; each is then moved
      // (and possibly trimmed) independently, so the plan does not depend on the
      // order the steps run in.
      const placed: { id: string; start: number; duration?: number }[] = [];
      let cursor = base;
      for (const layer of layers) {
        const start = base + Math.max(0, Math.ceil((cursor - base) / beat - 1e-6)) * beat;
        const duration = beats ? beats * beat : undefined;
        placed.push({ id: layer.id, start: round(start, 4), duration: duration ? round(duration, 4) : undefined });
        cursor = start + (duration ?? layer.duration);
      }

      const steps: Step[] = placed.map(
        (entry) =>
          ({
            kind: "setTiming",
            id: entry.id,
            start: entry.start,
            ...(entry.duration !== undefined ? { duration: entry.duration } : {}),
          }) as Step,
      );
      if (trackId) for (const layer of layers) steps.push({ kind: "moveToTrack", id: layer.id, trackId });

      const notes: string[] = [
        `${layers.length} clip(s) on a ${round(beat, 3)}s beat (${Math.round(60 / beat)} BPM), starting at ${secs(base)}`,
        beats
          ? `each cut to ${beats} beat${beats === 1 ? "" : "s"} (${secs(beats * beat)}), so the row runs continuously`
          : "clips keep their own lengths, so a gap of up to one beat can stay open between them",
      ];
      if (trackId) {
        const occupied = layersOnTrack(editor().project, trackId).filter((layer) => !ids.includes(layer.id));
        if (occupied.length) {
          notes.push(`"${editor().project.tracks[trackId].name}" already holds ${occupied.length} clip(s) — shots that overlap them will stack`);
        }
      }

      return applyPlan("flow_beat_cut", steps, {
        notes,
        after: () => {
          const live = placed
            .map((entry) => editor().project.layers[entry.id])
            .filter((layer): layer is Layer => !!layer);
          if (!live.length) return;
          const end = Math.max(...live.map(layerEnd));
          const drift = live.map((layer) => round((layer.startTime - base) / beat, 2));
          return {
            notes: [`the run is now ${secs(base)} → ${secs(end)} (${secs(end - base)}), average shot ${secs((end - base) / live.length)}`],
            extra: {
              beat: round(beat, 3),
              bpm: Math.round(60 / beat),
              startsAt: round(base, 3),
              endsAt: round(end, 3),
              beatOffsets: drift,
            },
          };
        },
      });
    },
  },
  {
    name: "flow_crosscut",
    title: "Crosscut two strands",
    description:
      "Interleave two sets of shots, alternating between them, to build tension or show two things happening at once. Each strand is broken into pieces of `segment` seconds and the pieces are laid down alternately on one row, so the cut moves A, B, A, B. The named clips are REMOVED and re-laid as pieces, so one undo puts the originals back; nothing else on the timeline moves. The result is as long as both strands combined, not as long as the longer one — that is what interleaving means.",
    inputSchema: object(
      {
        clipA: strList("The first strand's clips, in order. Two or more is the point of a crosscut.", { minItems: 1 }),
        clipB: strList("The second strand's clips, in order.", { minItems: 1 }),
        segment: num("How much of a strand plays before cutting to the other, in seconds. 1–3s is typical.", {
          minimum: 0.25,
          maximum: 30,
        }),
        start: num("Where the crosscut begins, in timeline seconds. Defaults to the earliest clip's start.", { minimum: 0 }),
        trackId: str("Row to build on. Defaults to the row the first strand is on."),
      },
      ["clipA", "clipB", "segment"],
    ),
    annotations: { ...WRITE, destructiveHint: true },
    run: (args) => {
      const strandA = argStringList(args, "clipA") ?? [];
      const strandB = argStringList(args, "clipB") ?? [];
      if (!strandA.length || !strandB.length) {
        return toolError("flow_crosscut needs both strands — clipA and clipB, each with at least one clip id.");
      }
      const segment = needNumber(args, "segment");

      const all = [...strandA, ...strandB];
      const layers = all.map(layerOf);
      for (const layer of layers) {
        if (!layer.assetId) {
          throw new Error(
            `"${layer.name}" is a ${layer.type} clip with no source media — a crosscut rebuilds clips from their sources, so only media clips can go into it.`,
          );
        }
      }

      // Each strand is chunked from the clip's own visible portion, so the
      // crosscut shows exactly what the originals showed.
      const chunk = (ids: string[]): AssembleClip[] => {
        const pieces: AssembleClip[] = [];
        for (const id of ids) {
          const layer = layerOf(id);
          const timed = isTimed(layer);
          for (let offset = 0; offset < layer.duration - 1e-3; offset += segment) {
            pieces.push({
              assetId: layer.assetId as string,
              duration: round(Math.min(segment, layer.duration - offset), 4),
              ...(timed ? { inPoint: round(layer.inPoint + offset, 4) } : {}),
            });
          }
        }
        return pieces;
      };

      const piecesA = chunk(strandA);
      const piecesB = chunk(strandB);
      const merged: AssembleClip[] = [];
      for (let i = 0; i < Math.max(piecesA.length, piecesB.length); i++) {
        if (piecesA[i]) merged.push(piecesA[i]);
        if (piecesB[i]) merged.push(piecesB[i]);
      }

      const start = argNumber(args, "start") ?? Math.min(...layers.map((layer) => layer.startTime));
      const trackId = argString(args, "trackId") ?? layers[0].trackId;
      if (!editor().project.tracks[trackId]) {
        return toolError(`No row with id "${trackId}" — call get_timeline for the rows.`);
      }

      const ideal = merged.reduce((sum, piece) => sum + (piece.duration ?? 0), 0);
      const bystanders = layersOnTrack(editor().project, trackId).filter(
        (layer) => !all.includes(layer.id) && layer.startTime < start + ideal && layerEnd(layer) > start,
      );

      const steps: Step[] = [
        { kind: "remove", ids: all },
        { kind: "assemble", clips: merged, start, trackId },
      ];

      return applyPlan("flow_crosscut", steps, {
        notes: [
          `${piecesA.length} piece(s) of strand A and ${piecesB.length} of strand B, cut together in ${secs(segment)} segments`,
          `the interleave runs ${secs(start)} → ${secs(start + ideal)} — as long as both strands combined`,
          ...(bystanders.length
            ? [`${namesOf(bystanders.map((layer) => layer.id))} already sit inside that range on the same row and will stack over the crosscut`]
            : []),
          "the named clips were removed and rebuilt as pieces — one undo restores the originals",
        ],
        after: (report) => {
          const laid = report.created
            .map((id) => editor().project.layers[id])
            .filter((layer): layer is Layer => !!layer);
          const last = laid[laid.length - 1];
          return {
            notes: last ? [`${laid.length} pieces laid, ending at ${secs(layerEnd(last))}`] : [],
            extra: { pieces: laid.length, endsAt: last ? round(layerEnd(last), 3) : null },
          };
        },
      });
    },
  },

  /* ------------------------------ movement and format ------------------------------ */
  {
    name: "flow_push_in",
    title: "Push in on a clip",
    description:
      "A slow push in (or pull out) over a clip — a factual tool, not decoration: it gives a static shot life, leads the eye to a detail, or covers a cut that would otherwise be flat. The move starts from the scale the clip has AT THAT MOMENT, with its own keyframes evaluated, so an existing move is extended rather than thrown away. Defaults to a 8% push over the whole clip.",
    inputSchema: object(
      {
        clipId: str("The clip to move in on. Defaults to the selected clip, else the one under the playhead."),
        amount: num("How much to scale by, as a fraction — 0.08 is a subtle push, 0.3 is dramatic.", { minimum: 0.005, maximum: 2 }),
        direction: choice("\"in\" tightens over the clip; \"out\" starts tight and settles.", ["in", "out"]),
        easing: choice("How the move eases into its end.", EASINGS),
        at: num("When the move starts, in timeline seconds. Defaults to the clip's start.", { minimum: 0 }),
        seconds: num("How long the move takes. Defaults to the whole clip.", { minimum: 0.1 }),
      },
      [],
    ),
    annotations: WRITE,
    run: (args) => {
      const named = argString(args, "clipId");
      const fallback = named ? undefined : (resolveTargets(editor(), undefined)[0] ?? clipAtPlayhead()?.id);
      const clipId = named ?? fallback;
      if (!clipId) {
        return toolError(
          "No clip to push in on — pass a clipId, select a clip, or park the playhead over one. Call get_timeline for the ids.",
        );
      }
      const layer = layerOf(clipId);
      const amount = argNumber(args, "amount") ?? 0.08;
      const direction = (argString(args, "direction") ?? "in") as "in" | "out";
      const easing = (argString(args, "easing") ?? "easeOut") as Easing;
      const at = argNumber(args, "at") ?? layer.startTime;

      const wanted = argNumber(args, "seconds") ?? layerEnd(layer) - at;
      const seconds = Math.min(wanted, layerEnd(layer) - at);
      if (seconds < 0.1) {
        return toolError(
          `"${layer.name}" has only ${secs(Math.max(0, layerEnd(layer) - at))} left after ${secs(at)} — not enough room for a move. Start earlier or use a longer clip.`,
        );
      }

      // Read the scale the compositor would use at that instant, not the clip's
      // static value: a clip that is already moving must be moved on from where
      // it actually is.
      const base = evaluateLayer(layer, at).scale;
      const from = direction === "in" ? base : base * (1 + amount);
      const to = direction === "in" ? base * (1 + amount) : base;

      const existing = layer.keyframes.filter((key) => key.prop === "scale").length;
      const notes = [
        `${direction === "in" ? "pushing in" : "pulling out"} from scale ${round(base, 3)} to ${round(direction === "in" ? to : from, 3)} over ${secs(seconds)}`,
        ...(seconds < wanted - 1e-3 ? [`shortened to ${secs(seconds)} so the move ends with the clip`] : []),
        ...(existing
          ? [
              `"${layer.name}" already has ${existing} scale keyframe(s) — this adds to that motion rather than replacing it. Clear them first (manage_keyframes with action "clear", prop "scale") if the push in should be the only move.`,
            ]
          : []),
      ];

      return applyPlan(
        "flow_push_in",
        [
          { kind: "setKeyframes", id: clipId, action: "add", prop: "scale", at: round(at, 4), value: round(from, 4), easing },
          { kind: "setKeyframes", id: clipId, action: "add", prop: "scale", at: round(at + seconds, 4), value: round(to, 4) },
        ],
        { notes },
      );
    },
  },
  {
    name: "flow_social_reframe",
    title: "Reframe for a platform",
    description:
      "Change the piece's shape and refit everything on the canvas to the new frame — the proper reformat, as opposed to update_project_settings, which changes the canvas and leaves the clips where they were. Media is refitted from its real natural size, so what filled the old frame still fills the new one; text is rescaled with the frame, and stickers keep their proportion. Graphics left outside the new frame are reported so they can be brought back in.",
    inputSchema: object(
      {
        aspect: choice("The target shape. 9:16 is vertical short-form, 1:1 square, 4:5 feed portrait, 16:9 landscape.", [
          "9:16",
          "1:1",
          "4:5",
          "16:9",
          "4:3",
        ]),
        fit: choice(
          "\"cover\" fills the new frame and crops the excess, which is what a reformat wants; \"contain\" letterboxes the whole original frame inside it.",
          ["cover", "contain"],
        ),
      },
      ["aspect"],
    ),
    annotations: WRITE,
    run: (args) => {
      const aspect = need(args, "aspect");
      const fit = (argString(args, "fit") ?? "cover") as "cover" | "contain";
      const settings = editor().project.settings;

      const notes = [
        `refitting ${settings.width}×${settings.height} → ${aspect} with "${fit}"`,
        ...(aspect === "9:16"
          ? [
              "on 9:16 the platform covers roughly the top 10% and the bottom 15% of the frame with its own interface — keep titles and faces out of those bands (flow_lower_third already places its plate about 12% up from the bottom)",
            ]
          : []),
        ...(fit === "contain"
          ? ["\"contain\" letterboxes: the project background will show at the edges, so check the background colour is deliberate"]
          : []),
      ];

      return applyPlan("flow_social_reframe", [{ kind: "reframe", aspect, fit }], {
        notes,
        after: () => ({
          notes: [
            `the project is now ${editor().project.settings.width}×${editor().project.settings.height} — play it through, because a reframe changes what every shot is showing`,
          ],
          extra: { width: editor().project.settings.width, height: editor().project.settings.height, fit },
        }),
      });
    },
  },

  /* ------------------------------ sound and lock ------------------------------ */
  {
    name: "flow_trim_silence",
    title: "Trim the silence out of a take",
    description:
      "Cut the dead air out of a spoken take: the asset's decoded waveform is read for loud runs, each run is padded and laid down end to end, and long runs are chunked into normal-sized clips rather than one enormous one. By default this REPLACES the clips of that take already on the timeline, because that is what \"trim the take\" means — pass replace: false to lay the trimmed version down alongside the original. Silence detection needs a decoded waveform; a take that has none fails with that message, and nothing is changed.",
    inputSchema: object(
      {
        assetId: str("The take to trim. Must be an audio or video asset with a decoded waveform."),
        threshold: num("Peak level above which sound counts as speech, 0 to 1. Defaults to 0.12.", { minimum: 0, maximum: 1 }),
        pad: num("Seconds of silence kept on each side of a run, so cuts do not clip the words. Defaults to 0.06.", {
          minimum: 0,
          maximum: 1,
        }),
        maxClipDuration: num("Longest single clip to produce; longer runs are chunked. Defaults to 12.", {
          minimum: 0.1,
          maximum: 120,
        }),
        start: num("Where on the timeline the trimmed take begins, in seconds. Defaults to 0.", { minimum: 0 }),
        trackId: str("Row to lay the trimmed clips on. Omit to let them land where they belong."),
        replace: bool("Remove the existing clips of this take first, so the trimmed version replaces them. Defaults to true."),
      },
      ["assetId"],
    ),
    annotations: WRITE,
    run: (args) => {
      const assetId = need(args, "assetId");
      const asset = editor().assets[assetId];
      if (!asset) {
        return toolError(`No asset with id "${assetId}" — call list_assets for what is in the bin.`);
      }
      if (!asset.waveform?.length) {
        return toolError(
          `"${asset.name}" has no decoded waveform, so its silence cannot be found. Import or play the take so the waveform is decoded, or trim it by hand with split_clip.`,
        );
      }

      const steps: Step[] = [];
      const notes: string[] = [];
      const replace = argBool(args, "replace") ?? true;

      const existing = orderedLayers(editor().project)
        .filter((layer) => layer.assetId === assetId)
        .map((layer) => layer.id);
      if (replace && existing.length) {
        steps.push({ kind: "remove", ids: existing });
        notes.push(`replaced ${existing.length} clip(s) of this take — one undo brings them back`);
      } else if (replace) {
        notes.push("nothing on the timeline was using this take, so the trimmed clips are new material");
      }

      steps.push({
        kind: "autoTrimSilence",
        assetId,
        start: argNumber(args, "start") ?? 0,
        ...present({
          threshold: argNumber(args, "threshold"),
          pad: argNumber(args, "pad"),
          maxClipDuration: argNumber(args, "maxClipDuration"),
          trackId: argString(args, "trackId"),
        }),
      });

      return applyPlan("flow_trim_silence", steps, {
        notes: [
          `threshold ${argNumber(args, "threshold") ?? 0.12}, ${secs(argNumber(args, "pad") ?? 0.06)} of padding kept either side`,
          ...notes,
        ],
        after: (report) => {
          const kept = totalLength(report.created);
          const source = editor().assets[assetId]?.duration ?? 0;
          if (!report.created.length || !source) return;
          return {
            notes: [
              `kept ${secs(kept)} of ${secs(source)} of source — the take plays ${secs(kept)} where it used to play ${secs(source)}`,
            ],
            extra: {
              clips: report.created.length,
              keptSeconds: round(kept, 3),
              removedSeconds: round(Math.max(0, source - kept), 3),
              percentRemoved: Math.round((1 - kept / source) * 100),
            },
          };
        },
      });
    },
  },
  {
    name: "flow_picture_lock",
    title: "Picture lock",
    description:
      "The gate between editing and finishing. Run it when the cut is settled: it inspects the main layer for the things that are still loose — gaps between shots, clips stacked on top of each other, shots shorter than a beat, transitions longer than the shot they sit on — reports each one with the clip ids involved, and then locks the clips so a later pass cannot nudge the picture. With lock: false it only reports, which is the review pass. Locking is the promise that the timing will not change again, so do it once the cut is genuinely done.",
    inputSchema: object(
      {
        lock: bool("Lock the clips after reporting. Defaults to true; pass false to only read the cut."),
        clipIds: strList("The clips to lock. Defaults to the whole main picture sequence."),
      },
      [],
    ),
    annotations: WRITE,
    run: (args) => {
      const state = editor();
      const project = state.project;
      const row = mainPicture();
      const locking = argBool(args, "lock") ?? true;

      /* ---- read the cut before touching it ---- */
      type Issue = { kind: "empty" | "gap" | "overlap" | "short" | "transition"; clips: string[]; detail: string };
      const issues: Issue[] = [];

      if (!row.length) {
        issues.push({
          kind: "empty",
          clips: [],
          detail: "the main layer is empty — there is no picture sequence to lock",
        });
      }

      row.forEach((layer, index) => {
        if (layer.duration < 0.5) {
          issues.push({
            kind: "short",
            clips: [layer.id],
            detail: `"${layer.name}" is only ${secs(layer.duration)} — shorter than a beat, and will read as a flash rather than a shot`,
          });
        }
        for (const edge of ["in", "out"] as const) {
          const ramp = rampOf(layer, edge);
          if (ramp && ramp.duration > layer.duration * 0.4) {
            issues.push({
              kind: "transition",
              clips: [layer.id],
              detail: `the ${edge} ${ramp.type} on "${layer.name}" runs ${secs(ramp.duration)} — over 40% of a ${secs(layer.duration)} shot, which reads as a slow mix rather than a transition`,
            });
          }
        }
        const next = row[index + 1];
        if (!next) return;
        const gap = next.startTime - layerEnd(layer);
        if (gap > JUNCTION_EPSILON) {
          issues.push({
            kind: "gap",
            clips: [layer.id, next.id],
            detail: `${secs(gap)} of empty timeline between "${layer.name}" and "${next.name}" at ${secs(layerEnd(layer))} — the cut drops to background there`,
          });
        } else if (gap < -JUNCTION_EPSILON) {
          issues.push({
            kind: "overlap",
            clips: [layer.id, next.id],
            detail: `"${layer.name}" and "${next.name}" overlap by ${secs(-gap)} at ${secs(next.startTime)} — they stack rather than cut${
              junctionsOnTrack(project, layer.trackId).some((j) => j.from === layer.id && j.to === next.id && j.bonded)
                ? ""
                : " (no bond holds them, so this is probably not deliberate)"
            }`,
          });
        }
      });

      const junctions = project.trackIds.flatMap((trackId) => junctionsOnTrack(project, trackId));
      const cuts = junctions.filter((junction) => !junction.bonded).length;

      const ids = argStringList(args, "clipIds")?.length ? sequence(args) : row.map((layer) => layer.id);
      if (locking && !ids.length) {
        return toolError("There is nothing on the main layer to lock — lay a cut down with flow_assembly_cut first.");
      }

      const steps: Step[] = ids.length ? [{ kind: "setLock", ids, locked: locking }] : [];

      const notes = [
        `${row.length} shot(s) on the main layer, ${secs(row.reduce((sum, layer) => sum + layer.duration, 0))} of picture, ${junctions.length} junction(s) of which ${cuts} are plain cuts`,
        ...(issues.length
          ? [`${issues.length} thing(s) still loose before lock:`]
          : ["nothing loose: no gaps, no stacks, no flash-length clips and no overlong transitions"]),
        ...issues.slice(0, 10).map((issue) => issue.detail),
        ...(issues.length > 10 ? [`… and ${issues.length - 10} more`] : []),
        locking
          ? "the clips are locked — locked clips still play, they just resist being moved"
          : "read-only pass: nothing was changed",
      ];

      return applyPlan("flow_picture_lock", steps, {
        notes,
        extra: {
          locked: locking,
          clipCount: ids.length,
          issueCount: issues.length,
          issues,
          junctions: junctions.length,
          cuts,
          note: locking ? undefined : "lock was false, so no clips were changed",
        },
      });
    },
  },
];

/* ------------------------------------------------------------------ *
 * Exports
 * ------------------------------------------------------------------ */

/** Every flow name, in call order — the playbook lists them in this order too. */
export const FLOW_NAMES: string[] = FLOWS.map((flow) => flow.name);
