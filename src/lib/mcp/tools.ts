/**
 * THE TOOL CATALOGUE — the agent's hands and eyes.
 *
 * A tool is a thin, honest wrapper: it validates nothing (the server has already
 * validated the arguments against `inputSchema`), it touches no state, and it
 * holds no logic about the timeline. All it does is:
 *
 *   1. read the live editor if it needs to resolve something the agent did not
 *      name — a target selection, a clip's natural size, an id lookup;
 *   2. compile the request into an ordered `Step[]`;
 *   3. hand that plan to `runPlan` and render the report.
 *
 * That last split is the whole design. Because a tool returns a *plan* rather
 * than performing mutations, one call can do real editorial work while every
 * individual change still goes through the store action a human click would
 * use — and the entire call collapses into a single undo step.
 *
 * Two consequences worth stating plainly, because they are what makes the
 * catalogue feel like an editor rather than a CRUD API:
 *
 *   · Tools that act on "the clips" default to the human's current SELECTION,
 *     and say so when there is none. An agent that asks for nothing gets what
 *     the user is pointing at, which is almost always what they meant.
 *   · Tools address clips by id, but a plan can refer to a clip it just created
 *     with `"$0"` — so `add_media_clip` can place a clip and set its transform
 *     in one call without the agent knowing the new id first.
 *
 * `run` may throw a plain `Error` for a bad *target* (an unknown clip id, a
 * missing selection). The server turns that into an in-band tool error, which
 * is the right shape: the agent asked something impossible, not the protocol.
 */
import {
  BACKGROUND_PRESETS,
  BLEND_OPTIONS,
  EFFECT_PRESETS,
  FILTER_LOOKS,
  FONT_OPTIONS,
  SHAPE_PRESETS,
  TEXT_PRESETS,
} from "@/lib/library";
import {
  buildAssets,
  buildClip,
  buildEditorState,
  buildExportStatus,
  buildLibrary,
  buildOnScreen,
  buildSelection,
  buildTimeline,
  resolveTargets,
} from "@/lib/mcp/observe";
import { snapshotActivity, takeActivityBaseline } from "@/lib/mcp/activity";
import { BROADCAST_TOOLS } from "@/lib/mcp/broadcastTools";
import { CONTENT_TOOLS } from "@/lib/mcp/contentTools";
import { FLOWS } from "@/lib/mcp/flows";
import { IMPORT_TOOLS } from "@/lib/mcp/importTools";
import { MACRO_TOOLS } from "@/lib/mcp/macroTools";
import { MANIFEST_TOOLS } from "@/lib/mcp/manifest";
import { PROJECT_TOOLS } from "@/lib/mcp/projectTools";
import {
  ANIMATABLE,
  EASINGS,
  EFFECT_KINDS,
  NO_ARGS,
  READ,
  WRITE,
} from "@/lib/mcp/kit";
import type { ToolDefinition } from "@/lib/mcp/kit";
import {
  applyPlan,
  argBool,
  argNumber,
  argString,
  argStringList,
  bool,
  choice,
  fitScale,
  hasKeys,
  int,
  layerOf,
  need,
  needNumber,
  num,
  object,
  presetOf,
  present,
  sizeToScale,
  str,
  strList,
  targets,
  transformPatch,
  transitionPatch,
  unknownValue,
} from "@/lib/mcp/kit";
import type { LayerPatch, Step } from "@/lib/mcp/steps";
import { textResult, toolError } from "@/lib/mcp/protocol";
import { formatFrames, round } from "@/lib/time";
import { TRANSITION_DEFS } from "@/lib/transitions";
import { editor } from "@/store/editorStore";
import type {
  BlendMode,
  Easing,
  EffectKind,
  EffectStyle,
  Layer,
  LayerFilters,
  LayerGrade,
  LayerId,
  ShapeId,
  StickerStyle,
  TextStyle,
  TransitionDirection,
  TransitionType,
} from "@/types/editor";

/** The keys `list_library` can return on their own. */
const LIBRARY_SECTIONS = [
  "all",
  "transitions",
  "transitionCategories",
  "filters",
  "effects",
  "effectGroups",
  "backgrounds",
  "shapes",
  "textPresets",
  "stickers",
  "fonts",
  "blendModes",
  "sounds",
  "soundCategories",
] as const;

/* ------------------------------------------------------------------ *
 * OBSERVE — the agent's eyes
 * ------------------------------------------------------------------ */

const OBSERVE_TOOLS: ToolDefinition[] = [
  {
    name: "get_editor_state",
    title: "Get editor state",
    description:
      "The whole live session in one call: canvas and project settings, playhead position, what is selected, how much is on the timeline, the asset bin's shape, undo depth and the last action, export queue state and current UI view. Start here — it is the cheapest way to find out what you are working with.",
    inputSchema: NO_ARGS,
    annotations: READ,
    run: () => {
      const state = editor();
      const { fps, width, height, name } = state.project.settings;
      const playhead = fps ? formatFrames(state.currentTime, fps) : `${round(state.currentTime, 2)}s`;
      const payload = buildEditorState(state);
      return textResult(
        [
          `Project "${name}" — ${width}×${height} @ ${fps}fps`,
          `Timeline: ${state.project.layerIds.length} clip(s) on ${state.project.trackIds.length} row(s), ${playhead} playhead`,
          `Selection: ${state.selection.length} clip(s)`,
          `History: undo depth ${state.history.past.length}, last action "${state.lastAction}"`,
        ].join("\n"),
        payload,
      );
    },
  },
  {
    name: "get_timeline",
    title: "Get timeline",
    description:
      "Every row top to bottom with every clip on it — id, name, type, start, end, duration, source in-point, transitions and keyframe count — plus the junctions between touching clips, stated explicitly (their seam, their overlap, whether they are bonded and what transition sits on them). Junctions are derived from geometry, so this is the only place to read them.",
    inputSchema: NO_ARGS,
    annotations: READ,
    run: () => {
      const payload = buildTimeline(editor());
      const rows = payload.tracks as { name: string; clipCount: number }[];
      return textResult(
        [
          `${payload.clipCount} clip(s) across ${payload.trackCount} row(s), ${payload.durationTimecode} long`,
          ...rows.map((row, i) => `  ${i}. ${row.name}${row.clipCount ? ` — ${row.clipCount} clip(s)` : " — empty"}`),
        ].join("\n"),
        payload,
      );
    },
  },
  {
    name: "get_clip",
    title: "Get clip details",
    description:
      "Everything about one or more clips: transform, filters and grade, both transitions in full, every keyframe with its layer-local time, audio settings, and the source asset with the headroom left on each side of the clip. Pass clipIds, or omit to read whatever is selected.",
    inputSchema: object({
      clipId: str("A single clip id."),
      clipIds: strList("Several clip ids at once."),
    }),
    annotations: READ,
    run: (args) => {
      const single = argString(args, "clipId");
      const requested = argStringList(args, "clipIds") ?? (single ? [single] : undefined);
      const state = editor();
      const ids = requested?.length ? requested : resolveTargets(state, undefined);
      if (!ids.length) {
        return toolError("No clip id given and nothing is selected — pass clipIds, or select clips first with select_clips.");
      }

      const clips: Record<string, unknown>[] = [];
      const missing: string[] = [];
      for (const id of [...new Set(ids)]) {
        const detail = buildClip(state, id);
        if (detail) clips.push(detail);
        else missing.push(id);
      }
      if (!clips.length) return toolError(`No clip with id "${missing[0]}" — call get_timeline for the ids that exist.`, { missing });

      return textResult(
        [
          `${clips.length} clip(s)`,
          ...clips.map((clip) => {
            const lines = [`  "${clip.name}" (${clip.type}) ${clip.timecode} — ${clip.duration}s`];
            if (clip.source) lines.push(`    source: ${(clip.source as { name: string }).name}`);
            if (clip.filters || clip.grade) lines.push(`    look: ${clip.filters ?? "grade only"}`);
            const keys = clip.keyframes as unknown[];
            if (keys.length) lines.push(`    ${keys.length} keyframe(s)`);
            return lines.join("\n");
          }),
          ...(missing.length ? [`  ! unknown id(s) ignored: ${missing.join(", ")}`] : []),
        ].join("\n"),
        { count: clips.length, clips, missing },
      );
    },
  },
  {
    name: "whats_on_screen",
    title: "What is on screen",
    description:
      "Exactly what the compositor would draw at a given moment, front-most first, with each layer's opacity, transform and volume ALREADY EVALUATED — keyframes and audio fades applied. This is how you check a title actually appears where you put it instead of guessing from numbers. Defaults to the current playhead.",
    inputSchema: object({
      time: num("Project-timeline seconds. Defaults to the current playhead."),
    }),
    annotations: READ,
    run: (args) => {
      const state = editor();
      const time = argNumber(args, "time") ?? state.currentTime;
      const payload = buildOnScreen(state, time);
      const layers = payload.layers as { name: string; type: string; visibleOpacity: number }[];
      return textResult(
        [
          `At ${payload.timecode} (${payload.time}s): ${payload.layerCount} layer(s) visible${payload.playing ? ", playing" : ""}`,
          ...layers.map((layer, i) => `  ${i}. "${layer.name}" (${layer.type}) at ${Math.round(layer.visibleOpacity * 100)}% opacity`),
          ...(layers.length ? [] : ["  nothing on screen at this time"]),
        ].join("\n"),
        payload,
      );
    },
  },
  {
    name: "get_selection",
    title: "Get selection",
    description:
      "What the human is currently pointing at. Writes that name no clips act on this selection, so read it before an unscoped edit rather than assuming. Ids that no longer resolve are reported separately.",
    inputSchema: NO_ARGS,
    annotations: READ,
    run: () => {
      const payload = buildSelection(editor());
      const clips = payload.clips as { name: string }[];
      return textResult(
        payload.count
          ? `${payload.count} clip(s) selected: ${clips.map((clip) => `"${clip.name}"`).join(", ")}`
          : "Nothing is selected. Unscoped writes will fail — pass explicit clipIds instead.",
        payload,
      );
    },
  },
  {
    name: "list_assets",
    title: "List assets",
    description:
      "The media bin: id, name, kind, natural duration and size, where each asset came from (import, generated, or a named open source), whether its waveform has been decoded, and how many clips already use it. Every assetId a placing tool accepts comes from here.",
    inputSchema: NO_ARGS,
    annotations: READ,
    run: () => {
      const payload = buildAssets(editor());
      const assets = payload.assets as { name: string; kind: string; duration: number | null; timesUsed: number }[];
      return textResult(
        [
          `${payload.count} asset(s)`,
          ...assets.map(
            (asset) =>
              `  "${asset.name}" (${asset.kind})${asset.duration ? ` ${asset.duration}s` : ""} — used by ${asset.timesUsed} clip(s)`,
          ),
        ].join("\n"),
        payload,
      );
    },
  },
  {
    name: "list_library",
    title: "List library",
    description:
      "Every preset id this editor accepts: transitions (with their category and whether they run a real shader pass), filter looks, effect presets, backgrounds, shapes, text presets, sticker glyphs by pack, fonts and blend modes. Read it before inventing an id — an unknown id is a hard error. Narrow with `section` to keep the payload small.",
    inputSchema: object({
      section: choice("Which part of the library to return. Omit for everything.", LIBRARY_SECTIONS),
    }),
    annotations: READ,
    run: (args) => {
      const library = buildLibrary();
      const section = argString(args, "section");
      if (!section || section === "all") {
        return textResult(
          `The full library: ${TRANSITION_DEFS.length} transition(s), ${FILTER_LOOKS.length} look(s), ${EFFECT_PRESETS.length} effect(s), ${BACKGROUND_PRESETS.length} background(s), ${SHAPE_PRESETS.length} shape(s), ${TEXT_PRESETS.length} text preset(s).`,
          library,
        );
      }
      const value = library[section];
      if (value === undefined) return toolError(`No library section "${section}". Valid sections: ${LIBRARY_SECTIONS.join(", ")}.`);
      const count = Array.isArray(value) ? value.length : Object.keys(value as object).length;
      return textResult(`Library section "${section}" — ${count} entr${count === 1 ? "y" : "ies"}.`, { [section]: value });
    },
  },
  {
    name: "get_activity",
    title: "Get activity since last check",
    description:
      "A diff of the editor since the previous call to this tool: clips added and removed by name, how many edits and undos the human has made, what the last undo step was called, whether the selection, playhead or playback state moved, and how long ago the last check was. This is how you notice a person editing alongside you — call it between passes rather than polling get_timeline.",
    inputSchema: NO_ARGS,
    annotations: READ,
    run: () => {
      const now = snapshotActivity();
      const before = takeActivityBaseline(now);

      if (!before) {
        const payload = {
          firstLook: true,
          at: new Date(now.at).toISOString(),
          clipCount: now.layerIds.length,
          undoDepth: now.undoDepth,
          lastAction: now.lastAction,
          playhead: round(now.playhead, 3),
          playing: now.playing,
          selection: now.selection,
          note: "First call — this is the baseline. Call again later to be told exactly what changed since now.",
        };
        return textResult(
          `Baseline recorded: ${now.layerIds.length} clip(s), undo depth ${now.undoDepth}, last action "${now.lastAction}".`,
          payload,
        );
      }

      const beforeIds = new Set(before.layerIds);
      const nowIds = new Set(now.layerIds);
      const added = now.layerIds.filter((id) => !beforeIds.has(id)).map((id) => ({ id, name: now.names[id] }));
      const removed = before.layerIds.filter((id) => !nowIds.has(id)).map((id) => ({ id, name: before.names[id] }));
      const edits = now.undoDepth - before.undoDepth;
      const selectionAdded = now.selection.filter((id) => !before.selection.includes(id));
      const selectionRemoved = before.selection.filter((id) => !now.selection.includes(id));
      const playheadDelta = round(now.playhead - before.playhead, 3);
      const changed =
        added.length > 0 ||
        removed.length > 0 ||
        edits !== 0 ||
        now.lastAction !== before.lastAction ||
        selectionAdded.length > 0 ||
        selectionRemoved.length > 0 ||
        Math.abs(playheadDelta) > 1e-3 ||
        now.playing !== before.playing;

      const parts: string[] = [];
      if (edits > 0) parts.push(`${edits} edit(s)`);
      if (edits < 0) parts.push(`${-edits} undo(s)`);
      if (added.length) parts.push(`${added.length} clip(s) added`);
      if (removed.length) parts.push(`${removed.length} clip(s) removed`);
      if (selectionAdded.length || selectionRemoved.length) parts.push("selection changed");
      if (Math.abs(playheadDelta) > 1e-3) parts.push(`playhead ${playheadDelta > 0 ? "+" : ""}${playheadDelta}s`);
      if (now.playing !== before.playing) parts.push(now.playing ? "playback started" : "playback paused");
      if (!parts.length && now.lastAction !== before.lastAction) parts.push("history relabelled");

      const payload = {
        firstLook: false,
        elapsedMs: now.at - before.at,
        at: new Date(now.at).toISOString(),
        changed,
        lastAction: now.lastAction,
        undoDepth: now.undoDepth,
        editsSinceLastCall: Math.max(0, edits),
        undosSinceLastCall: Math.max(0, -edits),
        clipsAdded: added,
        clipsRemoved: removed,
        selection: { clipIds: now.selection, added: selectionAdded, removed: selectionRemoved },
        playhead: {
          time: round(now.playhead, 3),
          timecode: formatFrames(now.playhead, editor().project.settings.fps),
          movedBy: playheadDelta,
          playing: now.playing,
          wasPlaying: before.playing,
        },
        summary: changed
          ? `Changed since last check: ${parts.join(", ")}. Last action "${now.lastAction}".`
          : `No change since the last check (${Math.round((now.at - before.at) / 1000)}s ago). Last action "${now.lastAction}".`,
      };

      return textResult(payload.summary, payload);
    },
  },
  {
    name: "get_export_status",
    title: "Get export status",
    description:
      "The render queue: each job's state, progress, options, output name and size, and any error. Export in this editor is a REALTIME capture — it takes about as long as the clip does and only runs while the tab is in the foreground — so check here before promising a finished file.",
    inputSchema: NO_ARGS,
    annotations: READ,
    run: () => {
      const state = editor();
      const payload = buildExportStatus(state);
      const jobs = payload.jobs as { id: string; status: string; progress: number }[];
      const active = jobs.filter((job) => !["done", "error", "canceled"].includes(job.status));
      return textResult(
        jobs.length
          ? [
              `${jobs.length} export job(s), ${active.length} unfinished`,
              ...jobs.map((job) => `  ${job.id}: ${job.status} ${Math.round(job.progress * 100)}%`),
            ].join("\n")
          : "No export has been queued in this session.",
        payload,
      );
    },
  },
];

/* ------------------------------------------------------------------ *
 * CONTROL — writing to the timeline
 * ------------------------------------------------------------------ */

const CONTROL_TOOLS: ToolDefinition[] = [
  /* ------------------------------ placing material ------------------------------ */
  {
    name: "add_media_clip",
    title: "Add a media clip",
    description:
      "Place a video, image or audio asset on the timeline. The clip is non-destructive: `inPoint` chooses where in the source it starts and `duration` how much of it plays, so this never alters the asset. Defaults to the whole asset at the playhead on the main layer. Follows with a transform when x/y/scale/rotation are given.",
    inputSchema: object(
      {
        assetId: str("Asset id from list_assets."),
        start: num("Where on the timeline the clip begins, in seconds. Defaults to the playhead.", { minimum: 0 }),
        duration: num("How long the clip plays for, in seconds. Defaults to the rest of the source.", { minimum: 0.06 }),
        inPoint: num("Seconds into the source media the clip starts from.", { minimum: 0 }),
        trackId: str("Row to place it on. Omit for the main layer."),
        x: num("Clip centre x in project pixels."),
        y: num("Clip centre y in project pixels."),
        scale: num("Scale multiplier, where 1 fits the media to the canvas.", { minimum: 0.0001 }),
        rotation: num("Rotation in degrees."),
      },
      ["assetId"],
    ),
    annotations: WRITE,
    run: (args) => {
      const assetId = need(args, "assetId");
      const steps: Step[] = [
        {
          kind: "addMedia",
          assetId,
          start: argNumber(args, "start") ?? editor().currentTime,
          ...present({
            duration: argNumber(args, "duration"),
            inPoint: argNumber(args, "inPoint"),
            trackId: argString(args, "trackId"),
          }),
        },
      ];
      const transform = transformPatch(args);
      if (transform) steps.push({ kind: "setTransform", id: "$0", ...transform });
      return applyPlan("add_media_clip", steps);
    },
  },
  {
    name: "add_text_clip",
    title: "Add a text clip",
    description:
      "Add a title or caption on its own row in front of the picture. Start from a text preset id (list_library, section \"textPresets\") or set the style fields directly; explicit fields always win over the preset. Defaults to 4 seconds at the playhead, centred on the canvas.",
    inputSchema: object(
      {
        content: str("The text itself. Use \\n for a line break.", { minLength: 1 }),
        presetId: choice("A text preset to start from.", TEXT_PRESETS.map((preset) => preset.id)),
        start: num("Timeline seconds. Defaults to the playhead.", { minimum: 0 }),
        duration: num("Length in seconds.", { minimum: 0.06 }),
        fontFamily: choice("Font family.", FONT_OPTIONS.map((font) => font.value)),
        fontSize: num("Font size in project pixels.", { minimum: 1 }),
        fontWeight: int("Font weight, e.g. 400 or 800.", { minimum: 100, maximum: 900 }),
        color: str("Fill colour, any CSS colour."),
        align: choice("Horizontal alignment.", ["left", "center", "right"]),
        lineHeight: num("Line height as a multiple of the font size.", { minimum: 0.5 }),
        letterSpacing: num("Extra space between letters, in pixels."),
        backgroundColor: str("Fill behind the text block. \"transparent\" for none."),
        backgroundRadius: num("Corner radius of that background, in pixels.", { minimum: 0 }),
        strokeColor: str("Outline colour."),
        strokeWidth: num("Outline width in pixels.", { minimum: 0 }),
        shadow: bool("Draw a drop shadow."),
        gradient: num("Vertical gradient over the fill: 0 flat, 1 heavy.", { minimum: 0, maximum: 1 }),
        gradientColor: str("Second colour of that gradient."),
        skew: num("Vertical tilt in degrees, for kinetic titles."),
        x: num("Centre x in project pixels."),
        y: num("Centre y in project pixels."),
        scale: num("Scale multiplier.", { minimum: 0.0001 }),
        rotation: num("Rotation in degrees."),
        name: str("Name for the clip in the timeline."),
        trackId: str("Row to place it on. Omit for a new row of its own."),
      },
      ["content"],
    ),
    annotations: WRITE,
    run: (args) => {
      const content = need(args, "content");
      const presetId = argString(args, "presetId");
      const preset = presetId ? presetOf("text preset", TEXT_PRESETS, presetId) : undefined;

      const text: Partial<TextStyle> = {
        ...(preset?.text ?? {}),
        content,
        ...present({
          fontFamily: argString(args, "fontFamily"),
          fontSize: argNumber(args, "fontSize"),
          fontWeight: argNumber(args, "fontWeight"),
          color: argString(args, "color"),
          align: argString(args, "align") as TextStyle["align"] | undefined,
          lineHeight: argNumber(args, "lineHeight"),
          letterSpacing: argNumber(args, "letterSpacing"),
          backgroundColor: argString(args, "backgroundColor"),
          backgroundRadius: argNumber(args, "backgroundRadius"),
          strokeColor: argString(args, "strokeColor"),
          strokeWidth: argNumber(args, "strokeWidth"),
          shadow: argBool(args, "shadow"),
          gradient: argNumber(args, "gradient"),
          gradientColor: argString(args, "gradientColor"),
          skew: argNumber(args, "skew"),
        }),
      };

      const steps: Step[] = [
        {
          kind: "addText",
          content,
          text,
          ...present({
            start: argNumber(args, "start"),
            duration: argNumber(args, "duration"),
            x: argNumber(args, "x"),
            y: argNumber(args, "y"),
            scale: argNumber(args, "scale"),
            name: argString(args, "name"),
            trackId: argString(args, "trackId"),
          }),
        },
      ];
      const rotation = argNumber(args, "rotation");
      if (rotation !== undefined) steps.push({ kind: "setTransform", id: "$0", rotation });

      return applyPlan("add_text_clip", steps, {
        notes: preset ? [`started from the "${preset.label}" preset`] : undefined,
      });
    },
  },
  {
    name: "add_shape",
    title: "Add a shape",
    description:
      "Add a vector shape (card, star, badge, arrow, ring, bubble and so on) as a sticker layer in front of the picture. Give `size` in project pixels and it is converted to the layer's scale for you. Defaults to 3 seconds at the playhead.",
    inputSchema: object(
      {
        shape: choice("Which shape.", SHAPE_PRESETS.map((preset) => preset.id)),
        start: num("Timeline seconds. Defaults to the playhead.", { minimum: 0 }),
        duration: num("Length in seconds.", { minimum: 0.06 }),
        fill: str("Fill colour."),
        stroke: str("Outline colour."),
        strokeWidth: num("Outline width in pixels.", { minimum: 0 }),
        depth: num("Inner shadow, 0 flat to 1 deep.", { minimum: 0, maximum: 1 }),
        x: num("Centre x in project pixels."),
        y: num("Centre y in project pixels."),
        size: num("Width of the shape box in project pixels.", { minimum: 1 }),
        rotation: num("Rotation in degrees."),
      },
      ["shape"],
    ),
    annotations: WRITE,
    run: (args) => {
      const shapeId = need(args, "shape");
      presetOf("shape", SHAPE_PRESETS, shapeId);
      const style = present<Partial<StickerStyle>>({
        fill: argString(args, "fill"),
        stroke: argString(args, "stroke"),
        strokeWidth: argNumber(args, "strokeWidth"),
        depth: argNumber(args, "depth"),
      });

      const steps: Step[] = [
        {
          kind: "addShape",
          shape: shapeId as ShapeId,
          ...present({
            start: argNumber(args, "start"),
            duration: argNumber(args, "duration"),
            style: hasKeys(style) ? style : undefined,
          }),
        },
      ];

      const size = argNumber(args, "size");
      const transform = transformPatch(args);
      const patch = { ...(transform ?? {}), ...(size !== undefined ? { scale: sizeToScale(size) } : {}) };
      if (hasKeys(patch)) steps.push({ kind: "setTransform", id: "$0", ...patch });

      return applyPlan("add_shape", steps, {
        notes: size !== undefined ? [`size ${size}px → scale ${round(sizeToScale(size), 3)}`] : undefined,
      });
    },
  },
  {
    name: "add_sticker",
    title: "Add a sticker",
    description:
      "Add an emoji or character sticker in front of the picture. Any glyph works — list_library's \"stickers\" section lists the bundled packs. Give `size` in project pixels and it is converted to the layer's scale. Defaults to 3 seconds at the playhead.",
    inputSchema: object(
      {
        glyph: str("The character or emoji to draw.", { minLength: 1 }),
        start: num("Timeline seconds. Defaults to the playhead.", { minimum: 0 }),
        duration: num("Length in seconds.", { minimum: 0.06 }),
        x: num("Centre x in project pixels."),
        y: num("Centre y in project pixels."),
        size: num("Width of the sticker box in project pixels.", { minimum: 1 }),
        rotation: num("Rotation in degrees."),
        name: str("Name for the clip in the timeline."),
      },
      ["glyph"],
    ),
    annotations: WRITE,
    run: (args) => {
      const glyph = need(args, "glyph");
      const steps: Step[] = [
        {
          kind: "addSticker",
          glyph,
          ...present({
            start: argNumber(args, "start"),
            duration: argNumber(args, "duration"),
            name: argString(args, "name"),
          }),
        },
      ];

      const size = argNumber(args, "size");
      const transform = transformPatch(args);
      const patch = { ...(transform ?? {}), ...(size !== undefined ? { scale: sizeToScale(size) } : {}) };
      if (hasKeys(patch)) steps.push({ kind: "setTransform", id: "$0", ...patch });

      return applyPlan("add_sticker", steps, {
        notes: size !== undefined ? [`size ${size}px → scale ${round(sizeToScale(size), 3)}`] : undefined,
      });
    },
  },
  {
    name: "add_effect",
    title: "Add an effect layer",
    description:
      "Add a procedural overlay — light leak, glow, grain, scanlines, snow, confetti, a colour wash — as its own layer over everything beneath it. Prefer a preset id; pass `effectKind` only when you want a bare kind with your own style values. Blending is a style field, so `blend` is set here, not on the clip.",
    inputSchema: object({
      presetId: choice("An effect preset to use as the base.", EFFECT_PRESETS.map((preset) => preset.id)),
      effectKind: choice("A bare effect kind, if no preset fits.", EFFECT_KINDS),
      color: str("Primary colour."),
      color2: str("Secondary colour, used by the two-colour kinds."),
      angle: num("Direction in degrees, for the directional kinds."),
      blend: choice("How the layer composites with what is beneath it.", BLEND_OPTIONS.map((option) => option.value)),
      amount: num("Density, count or spread, 0 to 1.", { minimum: 0, maximum: 1 }),
      scale: num("Element size for the particle kinds, 0 to 1.", { minimum: 0, maximum: 1 }),
      seed: num("Phase offset, so two overlays never look identical, 0 to 1.", { minimum: 0, maximum: 1 }),
      opacity: num("Layer opacity, 0 to 1.", { minimum: 0, maximum: 1 }),
      start: num("Timeline seconds. Defaults to the playhead.", { minimum: 0 }),
      duration: num("Length in seconds. Effects default to a few seconds.", { minimum: 0.06 }),
      name: str("Name for the clip in the timeline."),
    }),
    annotations: WRITE,
    run: (args) => {
      const presetId = argString(args, "presetId");
      const effectKind = argString(args, "effectKind");
      if (!presetId && !effectKind) {
        return toolError('Give either a presetId or an effectKind — list_library with section "effects" lists the presets.');
      }
      const preset = presetId ? presetOf("effect preset", EFFECT_PRESETS, presetId) : undefined;

      const style = present<Partial<EffectStyle>>({
        color: argString(args, "color"),
        color2: argString(args, "color2"),
        angle: argNumber(args, "angle"),
        blend: argString(args, "blend") as BlendMode | undefined,
        amount: argNumber(args, "amount"),
        scale: argNumber(args, "scale"),
        seed: argNumber(args, "seed"),
      });

      const steps: Step[] = [
        {
          kind: "addEffect",
          ...present({
            presetId,
            effectKind: effectKind as EffectKind | undefined,
            style: hasKeys(style) ? style : undefined,
            start: argNumber(args, "start"),
            duration: argNumber(args, "duration"),
            name: argString(args, "name"),
          }),
        },
      ];
      const opacity = argNumber(args, "opacity");
      if (opacity !== undefined) steps.push({ kind: "patchLayer", id: "$0", patch: { opacity } });

      return applyPlan("add_effect", steps);
    },
  },
  {
    name: "add_background",
    title: "Add a background",
    description:
      "Add a full-frame background plate — a solid, a gradient or a texture — as the backmost layer. Unlike the other placing tools this ALSO repaints the project background behind the timeline, so the flat backdrop matches the card you picked.",
    inputSchema: object(
      {
        presetId: choice("Which background, from list_library.", BACKGROUND_PRESETS.map((preset) => preset.id)),
        start: num("Timeline seconds. Defaults to the playhead.", { minimum: 0 }),
        duration: num("Length in seconds.", { minimum: 0.06 }),
      },
      ["presetId"],
    ),
    annotations: WRITE,
    run: (args) => {
      const presetId = need(args, "presetId");
      presetOf("background preset", BACKGROUND_PRESETS, presetId);
      return applyPlan("add_background", [
        {
          kind: "addBackground",
          presetId,
          ...present({ start: argNumber(args, "start"), duration: argNumber(args, "duration") }),
        },
      ]);
    },
  },

  /* ------------------------------ what a clip is ------------------------------ */
  {
    name: "set_clip_properties",
    title: "Set clip properties",
    description:
      "Change how a clip behaves rather than when it plays: name, opacity, volume, hidden, locked, playback rate, looping, and audio fade in/out. Acts on the named clips, or on the selection when none are named. Opacity is clamped to 0–1 and volume to 0–4, with a warning when clamping happens.",
    inputSchema: object({
      clipIds: strList("Clips to change. Defaults to the current selection."),
      name: str("Rename the clip."),
      opacity: num("Layer opacity, 0 to 1.", { minimum: 0, maximum: 1 }),
      volume: num("Audio gain, 0 to 4.", { minimum: 0, maximum: 4 }),
      hidden: bool("Hide it without deleting it."),
      locked: bool("Lock it against further edits."),
      rate: num("Playback speed multiplier.", { minimum: 0.1, maximum: 8 }),
      mediaLoop: bool("Loop the source if the clip outlasts it."),
      audioFadeIn: num("Audio fade up, in seconds.", { minimum: 0 }),
      audioFadeOut: num("Audio fade down, in seconds.", { minimum: 0 }),
    }),
    annotations: WRITE,
    run: (args) => {
      const ids = targets(args);
      const patch: LayerPatch = present({
        name: argString(args, "name"),
        opacity: argNumber(args, "opacity"),
        volume: argNumber(args, "volume"),
        hidden: argBool(args, "hidden"),
        locked: argBool(args, "locked"),
        rate: argNumber(args, "rate"),
        mediaLoop: argBool(args, "mediaLoop"),
        audioFadeIn: argNumber(args, "audioFadeIn"),
        audioFadeOut: argNumber(args, "audioFadeOut"),
      });
      if (!hasKeys(patch)) {
        return toolError("Nothing to change — pass at least one of name, opacity, volume, hidden, locked, rate, mediaLoop, audioFadeIn, audioFadeOut.");
      }
      return applyPlan(
        "set_clip_properties",
        ids.map((id) => ({ kind: "patchLayer", id, patch }) as Step),
      );
    },
  },
  {
    name: "set_clip_transform",
    title: "Set clip transform",
    description:
      "Move, scale or rotate clips on the canvas. x and y are the clip's CENTRE in project pixels, so the canvas centre is at half its width and height. `fit` is the useful shortcut: it computes the scale that covers or contains the frame from the media's real size, which is what you want after changing the canvas.",
    inputSchema: object({
      clipIds: strList("Clips to change. Defaults to the current selection."),
      x: num("Centre x in project pixels."),
      y: num("Centre y in project pixels."),
      scale: num("Scale multiplier. 1 is the media's natural size.", { minimum: 0.0001 }),
      rotation: num("Rotation in degrees."),
      fit: choice(
        "\"cover\" scales a video or image to fill the canvas, cropping the overflow; \"contain\" fits all of it inside. Applies to picture only and is ignored for text, stickers and effects.",
        ["cover", "contain"],
      ),
    }),
    annotations: WRITE,
    run: (args) => {
      const ids = targets(args);
      const transform = transformPatch(args);
      const fit = argString(args, "fit") as "cover" | "contain" | undefined;
      if (!transform && !fit) {
        return toolError("Nothing to change — pass at least one of x, y, scale, rotation or fit.");
      }

      const steps: Step[] = [];
      const skipped: string[] = [];
      for (const id of ids) {
        const layer = layerOf(id);
        const patch = { ...(transform ?? {}) } as Partial<Record<"x" | "y" | "scale" | "rotation", number>>;
        if (fit) {
          if (layer.type === "video" || layer.type === "image") patch.scale = fitScale(layer, fit);
          else skipped.push(layer.name);
        }
        if (hasKeys(patch)) steps.push({ kind: "setTransform", id, ...patch });
      }

      if (!steps.length) {
        return toolError(`Only "fit" was given, and none of the targeted clips are picture to fit. Pass x, y, scale or rotation instead.`);
      }

      return applyPlan("set_clip_transform", steps, {
        notes: skipped.length ? [`"fit" was ignored for ${skipped.map((name) => `"${name}"`).join(", ")} — only video and images can be fitted`] : undefined,
      });
    },
  },
  {
    name: "set_clip_filters",
    title: "Set clip filters",
    description:
      "Adjust the canvas-filter value of clips: brightness, contrast, saturation, blur, grayscale, sepia, hue rotation and invert. These are the per-channel controls, for correcting one clip; use apply_look to give several clips the same named look. Neutral values are brightness/contrast/saturate 1 and everything else 0.",
    inputSchema: object({
      clipIds: strList("Clips to change. Defaults to the current selection."),
      reset: bool("Return every filter to neutral instead. Cannot be combined with filter values."),
      brightness: num("1 is unchanged.", { minimum: 0, maximum: 4 }),
      contrast: num("1 is unchanged.", { minimum: 0, maximum: 4 }),
      saturate: num("1 is unchanged, 0 is greyscale.", { minimum: 0, maximum: 4 }),
      blur: num("Blur radius in pixels.", { minimum: 0, maximum: 40 }),
      grayscale: num("0 to 1.", { minimum: 0, maximum: 1 }),
      sepia: num("0 to 1.", { minimum: 0, maximum: 1 }),
      hueRotate: num("Hue shift in degrees.", { minimum: -180, maximum: 180 }),
      invert: num("0 to 1.", { minimum: 0, maximum: 1 }),
    }),
    annotations: WRITE,
    run: (args) => {
      const ids = targets(args);
      const reset = argBool(args, "reset") ?? false;
      const filters: Partial<LayerFilters> = present({
        brightness: argNumber(args, "brightness"),
        contrast: argNumber(args, "contrast"),
        saturate: argNumber(args, "saturate"),
        blur: argNumber(args, "blur"),
        grayscale: argNumber(args, "grayscale"),
        sepia: argNumber(args, "sepia"),
        hueRotate: argNumber(args, "hueRotate"),
        invert: argNumber(args, "invert"),
      });

      if (reset && hasKeys(filters)) {
        return toolError("reset restores every filter to neutral, so it cannot be combined with individual filter values. Do one or the other.");
      }
      if (!reset && !hasKeys(filters)) {
        return toolError("Nothing to change — pass reset, or at least one filter value.");
      }

      return applyPlan("set_clip_filters", [{ kind: "setFilters", ids, filters, reset }]);
    },
  },
  {
    name: "set_clip_grade",
    title: "Set clip grade",
    description:
      "Adjust the colour grade — the part canvas filters cannot express: temperature, tint, fade, vignette and grain. Applied to the named clips or the selection, and merged over whatever grade they already carry, so a clip keeps the settings you do not mention.",
    inputSchema: object({
      clipIds: strList("Clips to change. Defaults to the current selection."),
      temperature: num("Cool to warm, -1 to 1.", { minimum: -1, maximum: 1 }),
      tint: num("Green to magenta, -1 to 1.", { minimum: -1, maximum: 1 }),
      fade: num("Lifted, milky blacks, 0 to 1.", { minimum: 0, maximum: 1 }),
      vignette: num("Corner darkening, 0 to 1.", { minimum: 0, maximum: 1 }),
      grain: num("Film grain, 0 to 1.", { minimum: 0, maximum: 1 }),
    }),
    annotations: WRITE,
    run: (args) => {
      const ids = targets(args);
      const grade: Partial<LayerGrade> = present({
        temperature: argNumber(args, "temperature"),
        tint: argNumber(args, "tint"),
        fade: argNumber(args, "fade"),
        vignette: argNumber(args, "vignette"),
        grain: argNumber(args, "grain"),
      });
      if (!hasKeys(grade)) {
        return toolError("Nothing to change — pass at least one of temperature, tint, fade, vignette or grain.");
      }
      return applyPlan("set_clip_grade", [{ kind: "setGrade", ids, grade }]);
    },
  },
  {
    name: "apply_look",
    title: "Apply a filter look",
    description:
      "Apply a named look from the library — Cinematic, Teal & orange, Noir, Faded and the rest — to clips. A look is a complete filter+grade combination designed to sit on a neutral baseline, so this REPLACES the clips' filters and grade together rather than blending with them. The right first move for making a sequence consistent.",
    inputSchema: object(
      {
        lookId: choice("Which look. list_library with section \"filters\" shows them all.", FILTER_LOOKS.map((look) => look.id)),
        clipIds: strList("Clips to apply it to. Defaults to the current selection."),
      },
      ["lookId"],
    ),
    annotations: WRITE,
    run: (args) => {
      const lookId = need(args, "lookId");
      const look = presetOf("filter look", FILTER_LOOKS, lookId);
      const ids = targets(args);
      return applyPlan("apply_look", [{ kind: "applyLook", ids, lookId }], {
        notes: [`"${look.name}" — ${look.hint}`],
      });
    },
  },

  /* ------------------------------ timing ------------------------------ */
  {
    name: "move_clip",
    title: "Move a clip",
    description:
      "Slide a clip along the timeline without changing any of its content, or move it to another row. Moving is not trimming: the clip keeps its source in-point and its length, and only its start changes. Overlapping another clip on the same row stacks them rather than cutting.",
    inputSchema: object(
      {
        clipId: str("The clip to move."),
        start: num("New start on the timeline, in seconds.", { minimum: 0 }),
        trackId: str("Move it to this row as well. Omit to keep it where it is."),
      },
      ["clipId", "start"],
    ),
    annotations: WRITE,
    run: (args) => {
      const clipId = need(args, "clipId");
      layerOf(clipId);
      const steps: Step[] = [{ kind: "setTiming", id: clipId, start: needNumber(args, "start") }];
      const trackId = argString(args, "trackId");
      if (trackId) steps.push({ kind: "moveToTrack", id: clipId, trackId });
      return applyPlan("move_clip", steps);
    },
  },
  {
    name: "trim_clip",
    title: "Trim a clip",
    description:
      "Change how much of a clip plays and from where. `inPoint` moves the clip's head further into (or back out of) the source and automatically drags its start with it; `start` and `duration` set the timeline position and length. Purely non-destructive — the source media is never touched, and the clip reports back if the source ran out before the length you asked for.",
    inputSchema: object(
      {
        clipId: str("The clip to trim."),
        inPoint: num("New source in-point, in seconds into the media.", { minimum: 0 }),
        start: num("New start on the timeline, in seconds.", { minimum: 0 }),
        duration: num("New length in seconds.", { minimum: 0.06 }),
      },
      ["clipId"],
    ),
    annotations: WRITE,
    run: (args) => {
      const clipId = need(args, "clipId");
      layerOf(clipId);
      const timing = present({
        inPoint: argNumber(args, "inPoint"),
        start: argNumber(args, "start"),
        duration: argNumber(args, "duration"),
      });
      if (!hasKeys(timing)) return toolError("Nothing to change — pass at least one of inPoint, start or duration.");
      return applyPlan("trim_clip", [{ kind: "setTiming", id: clipId, ...timing }]);
    },
  },
  {
    name: "split_clip",
    title: "Split a clip",
    description:
      "Cut clips in two at a moment, leaving two independent clips that can be moved and trimmed apart. Pass clipIds to cut only those; omit them to cut every clip crossing that time on the whole timeline. A clip needs more than 0.06s on each side of the cut, so a split too close to an edge does nothing and says so.",
    inputSchema: object(
      {
        at: num("Where to cut, in timeline seconds.", { minimum: 0 }),
        clipIds: strList("Only cut these clips. Omit to cut everything crossing that time."),
      },
      ["at"],
    ),
    annotations: WRITE,
    run: (args) => {
      const at = needNumber(args, "at");
      const clipIds = argStringList(args, "clipIds");
      if (clipIds) for (const id of clipIds) layerOf(id);
      return applyPlan("split_clip", [{ kind: "split", at, ...present({ ids: clipIds }) }]);
    },
  },
  {
    name: "delete_clips",
    title: "Delete clips",
    description:
      "Remove clips from the timeline. This leaves a gap — the clips after it do not move up. Use flow_ripple_delete when the gap should close instead. The assets themselves are never deleted, so a clip can always be placed again from list_assets.",
    inputSchema: object(
      { clipIds: strList("The clips to delete.", { minItems: 1 }) },
      ["clipIds"],
    ),
    annotations: { ...WRITE, destructiveHint: true },
    run: (args) => {
      const ids = argStringList(args, "clipIds") as string[];
      return applyPlan("delete_clips", [{ kind: "remove", ids }], {
        notes: ["a gap is left behind — use flow_ripple_delete if the following clips should move up"],
      });
    },
  },
  {
    name: "duplicate_clips",
    title: "Duplicate clips",
    description:
      "Copy clips, including their transform, filters, grade, transitions and keyframes. The copies are placed directly after the originals and left selected. The new ids are reported, so you can address them in the same call.",
    inputSchema: object(
      { clipIds: strList("The clips to copy.", { minItems: 1 }) },
      ["clipIds"],
    ),
    annotations: WRITE,
    run: (args) => applyPlan("duplicate_clips", [{ kind: "duplicate", ids: argStringList(args, "clipIds") as string[] }]),
  },
  {
    name: "reorder_clip",
    title: "Reorder a clip in its stack",
    description:
      "Move a clip up or down the stacking order within its own row — the equivalent of bring-forward / send-backward. Rows own the vertical layout, so this never moves a clip to a different row; use move_clip with trackId for that. Audio has no visual stack, so nothing happens there.",
    inputSchema: object(
      {
        clipId: str("The clip to move."),
        direction: choice("Which way through the stack.", ["up", "down", "top", "bottom"]),
      },
      ["clipId", "direction"],
    ),
    annotations: WRITE,
    run: (args) => {
      const clipId = need(args, "clipId");
      layerOf(clipId);
      return applyPlan("reorder_clip", [
        { kind: "reorder", id: clipId, direction: need(args, "direction") as "up" | "down" | "top" | "bottom" },
      ]);
    },
  },
  {
    name: "reorder_track",
    title: "Reorder a row in the stack",
    description:
      "Move a whole row (track) forward or backward in the drawing stack — the \"bring a layer forward / send it back\" action. Rows are the layers: the main layer is always the back of the stack, and each row below it draws one step closer to the viewer, so sending the logo row down puts it behind the picture, and sending the text row up puts it in front. To shuffle clips *within* a row use reorder_clip; to move one clip to a different row use move_clip.",
    inputSchema: object(
      {
        trackId: str("The row to move — its id from get_timeline."),
        direction: choice("Which way through the stack.", ["up", "down", "top", "bottom"]),
      },
      ["trackId", "direction"],
    ),
    annotations: WRITE,
    run: (args) => {
      const trackId = need(args, "trackId");
      if (!editor().project.tracks[trackId]) throw new Error(`no track with id "${trackId}" — call get_timeline for rows`);
      return applyPlan("reorder_track", [
        { kind: "reorderTrack", id: trackId, direction: need(args, "direction") as "up" | "down" | "top" | "bottom" },
      ]);
    },
  },

  /* ------------------------------ joins ------------------------------ */
  {
    name: "set_clip_transition",
    title: "Set a clip's own transition",
    description:
      "Put a transition on a clip's leading or trailing edge — the clip ramps up or down on its own. This is for a title fading in or a clip dissolving out over whatever is beneath it. To make two touching clips truly cross-draw into each other, use set_junction_transition instead: this tool cannot create the overlap that a real cross-transition needs.",
    inputSchema: object({
      clipIds: strList("Clips to change. Defaults to the current selection."),
      edge: choice("Which edge of the clip.", ["in", "out"]),
      type: choice("Which transition.", TRANSITION_DEFS.map((def) => def.id)),
      duration: num("Ramp length in seconds. Keep it short — 0.3 to 0.8 is normal.", { minimum: 0.01 }),
      direction: choice("Direction, for the directional transitions.", ["left", "right", "up", "down"]),
      softness: num("Edge feather, 0 to 1.", { minimum: 0, maximum: 1 }),
      intensity: num("Strength multiplier, 0 to 1, for the effect transitions.", { minimum: 0, maximum: 1 }),
      color: str("Colour used by dip-to-colour, flashes and burns."),
    }, ["type"]),
    annotations: WRITE,
    run: (args) => {
      const ids = targets(args);
      const transition = transitionPatch(args);
      const edge = (argString(args, "edge") ?? "in") as "in" | "out";
      return applyPlan(
        "set_clip_transition",
        ids.map((id) => ({ kind: "setTransition", id, edge, transition }) as Step),
        {
          notes: [
            `applied to the ${edge === "in" ? "leading" : "trailing"} edge only — the opposite edge keeps its own setting`,
          ],
        },
      );
    },
  },
  {
    name: "set_junction_transition",
    title: "Set a transition between two clips",
    description:
      "Bond two clips that touch on the same row and put a transition between them. Bonding overlaps them so the incoming clip really cross-draws over the outgoing one, which is what a dissolve is supposed to look like. The order matters: `from` must be the clip that plays first, and its end must meet the other's start. Use action \"unbond\" to give the overlap back and leave a plain cut.",
    inputSchema: object(
      {
        from: str("The outgoing clip — the one that plays first."),
        to: str("The incoming clip — the one that starts where the first ends."),
        action: choice("Bond them with a transition, or remove an existing bond.", ["bond", "unbond"]),
        type: choice("Which transition.", TRANSITION_DEFS.map((def) => def.id)),
        duration: num("Overlap length in seconds. Capped by the incoming clip's lead on that row.", { minimum: 0.01 }),
        direction: choice("Direction, for the directional transitions.", ["left", "right", "up", "down"]),
        softness: num("Edge feather, 0 to 1.", { minimum: 0, maximum: 1 }),
        intensity: num("Strength multiplier, 0 to 1.", { minimum: 0, maximum: 1 }),
        color: str("Colour used by dip-to-colour, flashes and burns."),
      },
      ["from", "to"],
    ),
    annotations: WRITE,
    run: (args) => {
      const from = need(args, "from");
      const to = need(args, "to");
      layerOf(from);
      layerOf(to);
      const action = argString(args, "action") ?? "bond";
      if (action === "unbond") return applyPlan("set_junction_transition", [{ kind: "unbond", from, to }]);

      const transition = transitionPatch(args);
      if (!argString(args, "type") && !hasKeys(transition)) {
        return toolError('Pass a transition type — list_library with section "transitions" lists the ids — or use action "unbond".');
      }
      return applyPlan("set_junction_transition", [{ kind: "bond", from, to, transition }]);
    },
  },

  /* ------------------------------ animation ------------------------------ */
  {
    name: "manage_keyframes",
    title: "Manage keyframes",
    description:
      "Animate a clip's opacity, x, y, scale, rotation or volume over its own length. `at` is always given in TIMELINE seconds and converted to the clip-local time the store keeps, so trimming the clip afterwards never breaks the animation. Use action \"list\" to read the keyframe ids you need for updating or removing.",
    inputSchema: object(
      {
        action: choice("What to do. \"list\" only reads.", ["list", "add", "clear", "update", "remove"]),
        clipId: str("The clip to animate."),
        prop: choice("Which property, for list, add, clear and the animation itself.", ANIMATABLE),
        at: num("Timeline seconds for the keyframe.", { minimum: 0 }),
        value: num("The value at that moment."),
        easing: choice("How the value reaches the next keyframe.", EASINGS),
        keyframeId: str("The keyframe to update or remove, from action \"list\"."),
      },
      ["action", "clipId"],
    ),
    annotations: WRITE,
    run: (args) => {
      const action = need(args, "action");
      const clipId = need(args, "clipId");
      const layer = layerOf(clipId);
      const prop = argString(args, "prop") as (typeof ANIMATABLE)[number] | undefined;

      if (action === "list") {
        const keys = layer.keyframes
          .filter((key) => !prop || key.prop === prop)
          .map((key) => ({
            id: key.id,
            prop: key.prop,
            at: round(layer.startTime + key.time, 3),
            localTime: round(key.time, 3),
            value: round(key.value, 4),
            easing: key.easing,
          }));
        return textResult(
          keys.length
            ? [
                `"${layer.name}" has ${keys.length} keyframe(s)${prop ? ` on ${prop}` : ""} — "at" is in timeline seconds:`,
                ...keys.map((key) => `  ${key.prop} = ${key.value} at ${key.at}s (easing ${key.easing}) — id ${key.id}`),
              ].join("\n")
            : `"${layer.name}" has no ${prop ?? ""} keyframes.`.replace("  ", " "),
          { clipId, prop: prop ?? null, count: keys.length, keyframes: keys },
        );
      }

      if (action === "clear") {
        return applyPlan("manage_keyframes", [{ kind: "setKeyframes", id: clipId, action: "clear", prop }]);
      }

      if (action === "remove") {
        const keyframeId = argString(args, "keyframeId");
        if (!keyframeId) return toolError('action "remove" needs the keyframeId of the keyframe to delete — get it from action "list".');
        return applyPlan("manage_keyframes", [{ kind: "removeKeyframe", id: clipId, keyframeId }]);
      }

      if (action === "update") {
        const keyframeId = argString(args, "keyframeId");
        if (!keyframeId) return toolError('action "update" needs the keyframeId of the keyframe to change — get it from action "list".');
        const next = present({
          at: argNumber(args, "at"),
          value: argNumber(args, "value"),
          easing: argString(args, "easing") as Easing | undefined,
        });
        if (!hasKeys(next)) return toolError("Nothing to change — pass at least one of at, value or easing.");
        return applyPlan("manage_keyframes", [{ kind: "updateKeyframe", id: clipId, keyframeId, ...next }]);
      }

      if (!prop) return toolError('action "add" needs a prop — one of ' + ANIMATABLE.join(", ") + ".");
      const at = argNumber(args, "at");
      const value = argNumber(args, "value");
      if (at === undefined || value === undefined) {
        return toolError('action "add" needs both an "at" time (timeline seconds) and a "value".');
      }
      return applyPlan("manage_keyframes", [
        { kind: "setKeyframes", id: clipId, action: "add", prop, at, value, easing: argString(args, "easing") as Easing | undefined },
      ]);
    },
  },

  /* ------------------------------ rows ------------------------------ */
  {
    name: "manage_track",
    title: "Manage rows",
    description:
      "Add, rename, delete or promote a row. One row is the MAIN LAYER — the primary visual sequence, drawn at the back of the stack with every other row in front of it. Titles, stickers, overlays and audio all belong on their own rows in front of it, so put them there rather than trying to stack them on the main layer.",
    inputSchema: object(
      {
        action: choice("What to do. \"list\" only reads.", ["list", "add", "rename", "remove", "set_main"]),
        trackId: str("The row to rename, delete or promote."),
        name: str("Name for the new or renamed row."),
      },
      ["action"],
    ),
    annotations: WRITE,
    run: (args) => {
      const action = need(args, "action");
      const state = editor();

      if (action === "list") {
        const tracks = buildTimeline(state).tracks as { id: string; name: string; main: boolean; clipCount: number }[];
        return textResult(
          [
            `${tracks.length} row(s), top to bottom, front to back:`,
            ...tracks.map(
              (track, i) => `  ${i}. "${track.name}"${track.main ? " (main layer)" : ""} — ${track.clipCount} clip(s) — id ${track.id}`,
            ),
          ].join("\n"),
          { count: tracks.length, mainTrackId: state.project.trackIds.find((id) => state.project.tracks[id]?.main) ?? null, tracks },
        );
      }

      const trackId = argString(args, "trackId");
      const name = argString(args, "name");

      if (action === "add") return applyPlan("manage_track", [{ kind: "addTrack", name }]);
      if (action === "set_main") {
        if (!trackId) return toolError('action "set_main" needs a trackId — get one from action "list".');
        return applyPlan("manage_track", [{ kind: "setMainTrack", id: trackId }]);
      }
      if (action === "remove") {
        if (!trackId) return toolError('action "remove" needs a trackId — get one from action "list".');
        return applyPlan("manage_track", [{ kind: "removeTrack", id: trackId }]);
      }
      if (!trackId || !name) return toolError('action "rename" needs both a trackId and a name.');
      return applyPlan("manage_track", [{ kind: "renameTrack", id: trackId, name }]);
    },
  },

  /* ------------------------------ the editor itself ------------------------------ */
  {
    name: "select_clips",
    title: "Select clips",
    description:
      "Change the human's selection — which is also what unscoped writes act on. Use mode \"add\" to extend what is already selected rather than replacing it. Selecting is visible to the user, so do it when you are about to work on clips they should be watching.",
    inputSchema: object({
      clipIds: strList("The clips to select."),
      mode: choice("Replace the selection, extend it, or clear it.", ["replace", "add", "clear"]),
    }),
    annotations: WRITE,
    run: (args) => {
      const ids = argStringList(args, "clipIds");
      const mode = (argString(args, "mode") ?? "replace") as "replace" | "add" | "clear";
      if (mode !== "clear") {
        if (!ids?.length) return toolError('select_clips needs clipIds, or mode "clear" to deselect everything.');
        for (const id of ids) layerOf(id);
      }
      return applyPlan("select_clips", [{ kind: "select", ids: ids ?? [], mode }]);
    },
  },
  {
    name: "control_playback",
    title: "Control playback",
    description:
      "Move the playhead, start or stop playback, or toggle looping. This changes what the user is looking at, so use it deliberately: prefer get_clip to read a clip you are not already watching, and use seek when they should see the result of what you just did.",
    inputSchema: object(
      {
        action: choice("What to do.", ["play", "pause", "toggle", "loop", "seek"]),
        time: num("Where to put the playhead, in seconds. Required by \"seek\".", { minimum: 0 }),
        loop: bool("Whether to loop, for action \"loop\". Defaults to on."),
      },
      ["action"],
    ),
    annotations: WRITE,
    run: (args) => {
      const action = need(args, "action");
      if (action === "seek") {
        const time = argNumber(args, "time");
        if (time === undefined) return toolError('action "seek" needs a time in seconds.');
        return applyPlan("control_playback", [{ kind: "seek", time }]);
      }
      if (action === "loop") {
        return applyPlan("control_playback", [{ kind: "playback", action: "loop", loop: argBool(args, "loop") ?? true }]);
      }
      return applyPlan("control_playback", [{ kind: "playback", action: action as "play" | "pause" | "toggle" }]);
    },
  },
  {
    name: "update_project_settings",
    title: "Update project settings",
    description:
      "Change the project name, canvas size, frame rate or background. Note that changing the canvas does NOT refit what is already on it — existing clips keep their project-space positions and simply gain or lose room. Use flow_social_reframe to change the shape of the piece properly.",
    inputSchema: object({
      name: str("Project name. Also becomes the default export filename."),
      width: int("Canvas width in pixels.", { minimum: 16, maximum: 7680 }),
      height: int("Canvas height in pixels.", { minimum: 16, maximum: 7680 }),
      fps: int("Frame rate.", { minimum: 1, maximum: 120 }),
      backgroundColor: str("Background colour, for a flat background."),
      backgroundKind: choice("Flat colour or gradient.", ["color", "gradient"]),
      backgroundGradient: str("The gradient, as a CSS gradient string."),
      backgroundAngle: num("Gradient angle in degrees."),
    }),
    annotations: WRITE,
    run: (args) => {
      const patch = present<Record<string, unknown>>({
        name: argString(args, "name"),
        width: argNumber(args, "width"),
        height: argNumber(args, "height"),
        fps: argNumber(args, "fps"),
        backgroundColor: argString(args, "backgroundColor"),
        backgroundKind: argString(args, "backgroundKind"),
        backgroundGradient: argString(args, "backgroundGradient"),
        backgroundAngle: argNumber(args, "backgroundAngle"),
      });
      if (!hasKeys(patch)) return toolError("Nothing to change — pass at least one setting.");
      return applyPlan("update_project_settings", [{ kind: "settings", patch }]);
    },
  },
  {
    name: "export_project",
    title: "Export the project",
    description:
      "Queue a render of the timeline. This is a REALTIME capture: it runs at playback speed, takes roughly as long as the range does, only progresses while the tab is in the foreground, and moves the playhead while it works. Options default to the project's own canvas, frame rate and full duration. Poll get_export_status for progress.",
    inputSchema: object({
      width: int("Output width in pixels.", { minimum: 16, maximum: 7680 }),
      height: int("Output height in pixels.", { minimum: 16, maximum: 7680 }),
      fps: int("Output frame rate.", { minimum: 1, maximum: 120 }),
      bitrateMbps: num("Video bitrate in Mbps. Higher is bigger and cleaner.", { minimum: 0.5, maximum: 100 }),
      rangeStart: num("First second to render. Defaults to 0.", { minimum: 0 }),
      rangeEnd: num("Last second to render. Defaults to the end of the timeline.", { minimum: 0 }),
      includeAudio: bool("Mix in the audio. Defaults to on."),
      format: choice("Container. \"auto\" picks the best the browser supports.", ["auto", "mp4", "webm"]),
      fileName: str("Output filename, e.g. \"my-cut.mp4\"."),
    }),
    annotations: WRITE,
    run: (args) => {
      const options = present<Record<string, unknown>>({
        width: argNumber(args, "width"),
        height: argNumber(args, "height"),
        fps: argNumber(args, "fps"),
        bitrateMbps: argNumber(args, "bitrateMbps"),
        rangeStart: argNumber(args, "rangeStart"),
        rangeEnd: argNumber(args, "rangeEnd"),
        includeAudio: argBool(args, "includeAudio"),
        format: argString(args, "format"),
        fileName: argString(args, "fileName"),
      });
      return applyPlan("export_project", [{ kind: "export", options }]);
    },
  },
  {
    name: "edit_history",
    title: "Undo, redo, or read the history",
    description:
      "Step back through the edit, or read where the undo stack stands. Every other tool call is exactly one history entry, no matter how many steps it compiled to, so a single undo reverses a whole flow. action \"status\" just reads — use it to check what the last change was before undoing it.",
    inputSchema: object(
      {
        action: choice("What to do.", ["undo", "redo", "status"]),
        steps: int("How many times to step, 1 to 20.", { minimum: 1, maximum: 20 }),
      },
      ["action"],
    ),
    annotations: WRITE,
    run: (args) => {
      const action = need(args, "action");
      const state = editor();

      if (action === "status") {
        const payload = {
          canUndo: state.history.past.length > 0,
          canRedo: state.history.future.length > 0,
          undoDepth: state.history.past.length,
          redoDepth: state.history.future.length,
          lastAction: state.lastAction,
        };
        return textResult(
          `Last action "${state.lastAction}". ${state.history.past.length} step(s) to undo, ${state.history.future.length} to redo.`,
          payload,
        );
      }

      const count = argNumber(args, "steps") ?? 1;
      const steps: Step[] = Array.from({ length: count }, () => ({ kind: action } as Step));
      return applyPlan(`edit_history(${action})`, steps, {
        record: false,
        notes: ["undo/redo deliberately writes no history entry of its own — the stack itself is the record"],
      });
    },
  },
];

/* ------------------------------------------------------------------ *
 * Exports
 * ------------------------------------------------------------------ */

export { OBSERVE_TOOLS, CONTROL_TOOLS, IMPORT_TOOLS, PROJECT_TOOLS, CONTENT_TOOLS, FLOWS, MACRO_TOOLS, MANIFEST_TOOLS, BROADCAST_TOOLS };

/**
 * Observe first, then control, then import (how the agent's own media enters),
 * projects, the content tools, and finally the flows: an agent reads the
 * catalogue in that order too — a template or a brand only means something once
 * the editing tools are understood, and a flow is only ever the right answer
 * once the rest have been read.
 *
 * There is deliberately no stock search, media generation or speech synthesis in
 * this catalogue — the agent owns those and loads the result through import_media.
 */
export const TOOLS: ToolDefinition[] = [
  ...OBSERVE_TOOLS,
  ...CONTROL_TOOLS,
  ...IMPORT_TOOLS,
  ...PROJECT_TOOLS,
  ...CONTENT_TOOLS,
  ...FLOWS,
  ...MACRO_TOOLS,
  ...MANIFEST_TOOLS,
  ...BROADCAST_TOOLS,
];
