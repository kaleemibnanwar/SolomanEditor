/**
 * CONTENT TOOLS — composition, brand enforcement and export. No media sourcing.
 *
 * These sit above the editing primitives and build a finished, brand-styled
 * piece: templates, the fixed row layout, branded text, a brand checklist, an
 * export, a thumbnail, a three-act structure, and a one-call assembly. Every one
 * reads the ACTIVE brand pack (`lib/brands.ts`), so "Insight Train" and any
 * future brand are driven by the same tooling with no code changes.
 *
 * Deliberately ABSENT here: stock search, image/music generation and speech
 * synthesis. The agent already owns those (it has its own tools and the project
 * context — which brand, which theme, which cue, which bed), and it brings the
 * result in through `import_media`. This module only *composes* what is already
 * in the bin.
 */
import { measureText, DEFAULT_WRAP_RATIO } from "@/lib/compositor";
import {
  BRAND_PACKS,
  activeBrand,
  brandById,
  brandViolations,
  buildBrandProject,
  buildBrandScaffold,
  listBrands,
  resolveTemplate,
  type BrandPack,
  type LayoutRow,
} from "@/lib/brands";
import { dataUrlToBlob } from "@/lib/media";
import { capturePoster, flushAutosave, saveProject } from "@/lib/projects";
import { orderedLayers, projectDuration } from "@/lib/project";
import {
  READ,
  WRITE,
  applyPlan,
  argBool,
  argNumber,
  argString,
  argStringList,
  bool,
  choice,
  int,
  need,
  num,
  object,
  present,
  str,
  strList,
  type ToolDefinition,
} from "@/lib/mcp/kit";
import type { Step } from "@/lib/mcp/steps";
import { textResult, toolError } from "@/lib/mcp/protocol";
import { round, uid } from "@/lib/time";
import { mainTrackId } from "@/lib/tracks";
import { editor } from "@/store/editorStore";
import type { ExportOptions, Layer, TextStyle } from "@/types/editor";

/* ------------------------------------------------------------------ *
 * Catalogue, computed once at load
 * ------------------------------------------------------------------ */

const BRAND_IDS = BRAND_PACKS.map((pack) => pack.id);
const TEMPLATE_IDS = BRAND_PACKS.flatMap((pack) => pack.templates.map((template) => template.id));

/* ------------------------------------------------------------------ *
 * Small shared helpers
 * ------------------------------------------------------------------ */

const secs = (value: number) => `${round(value, 2)}s`;

/** The row name a role lives on, in a pack's layout. */
function rowNameFor(pack: BrandPack, role: LayoutRow["role"]): string | undefined {
  return pack.layout.find((row) => row.role === role)?.name;
}

/** The track id for a role, when the live project has that row. */
function trackIdForRole(role: LayoutRow["role"]): string | undefined {
  const pack = activeBrand(editor());
  const name = rowNameFor(pack, role);
  if (!name) return undefined;
  const project = editor().project;
  return project.trackIds.map((id) => project.tracks[id]).find((track) => track?.name === name)?.id;
}

/** Layers currently on a role's row. */
function layersForRole(role: LayoutRow["role"]): Layer[] {
  const trackId = trackIdForRole(role);
  if (!trackId) return [];
  return orderedLayers(editor().project).filter((layer) => layer.trackId === trackId);
}

/** The gain that puts the music this many dB under the voice. */
const dbToGain = (db: number) => Math.pow(10, db / 20);

/** A left-aligned anchor for a text block, in project pixels. */
function leftAnchor(style: TextStyle, width: number, y: number, marginX?: number) {
  const margin = marginX ?? width * 0.06;
  const block = measureText(style, width * DEFAULT_WRAP_RATIO);
  return { x: Math.round(margin + block.width / 2), y: Math.round(y) };
}

function baseText(content: string, unit: number): TextStyle {
  return {
    content,
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: Math.round(unit * 0.026),
    fontWeight: 400,
    color: "#ffffff",
    align: "left",
    lineHeight: 1.3,
    letterSpacing: 0,
    backgroundColor: "transparent",
    backgroundRadius: 0,
    strokeColor: "#000000",
    strokeWidth: 0,
    shadow: false,
    gradient: 0,
    gradientColor: "#000000",
    skew: 0,
  };
}

/** The brand's type system for a role: word / lower third / sub-label. */
function styleFor(pack: BrandPack, role: "word" | "lowerThird" | "subLabel", content: string, unit: number): TextStyle {
  const base = baseText(content, unit);
  if (role === "word") {
    return {
      ...base,
      fontFamily: pack.palette.displayFont,
      fontSize: Math.round(unit * 0.16),
      fontWeight: 700,
      color: pack.palette.ink,
      lineHeight: 1.05,
      letterSpacing: Math.round(unit * 0.02),
    };
  }
  if (role === "lowerThird") {
    return {
      ...base,
      fontFamily: pack.palette.bodyFont,
      color: pack.palette.ink,
      backgroundColor: "rgba(10,10,10,0.8)",
      backgroundRadius: Math.round(unit * 0.004),
    };
  }
  return {
    ...base,
    fontFamily: pack.palette.bodyFont,
    fontSize: Math.round(unit * 0.02),
    color: pack.palette.muted,
    letterSpacing: Math.round(unit * 0.002),
  };
}

const RESOLUTION_SIZE: Record<string, [number, number]> = { "4K": [3840, 2160], "1080p": [1920, 1080], "720p": [1280, 720] };

/** Export options from a pack's defaults, overlaid with any overrides. */
function exportOptionsFor(pack: BrandPack, fileName?: string): ExportOptions {
  const [width, height] = RESOLUTION_SIZE[pack.exportDefaults.resolution] ?? [1920, 1080];
  return {
    width,
    height,
    fps: pack.exportDefaults.fps,
    bitrateMbps: 12,
    rangeStart: 0,
    rangeEnd: round(projectDuration(editor().project), 3),
    includeAudio: true,
    format: "auto",
    fileName: fileName ?? `${editor().project.settings.name.replace(/\s+/g, "-").toLowerCase()}.mp4`,
  };
}

/* ------------------------------------------------------------------ *
 * The tools
 * ------------------------------------------------------------------ */

export const CONTENT_TOOLS: ToolDefinition[] = [
  /* ------------------------------ discovery ------------------------------ */
  {
    name: "list_brands",
    title: "List brand packs",
    description:
      "Every brand pack, its palette, voice profile, cue queries, music moods, brand rules, export defaults and the templates it offers. The content tools (apply_template, add_text, enforce_brand_rules, export_video, generate_thumbnail) all read the active brand — the one stamped on the project — so read this to know the look a piece should match before composing it. Pass `id` to read one pack in full.",
    inputSchema: object({ id: str("A single brand id to read in full.") }),
    annotations: READ,
    run: (args) => {
      const wanted = argString(args, "id");
      const brands = listBrands();
      if (wanted) {
        const brand = brands.find((b) => b.id === wanted);
        if (!brand) return toolError(`No brand called "${wanted}" — ids: ${brands.map((b) => b.id).join(", ")}.`);
        return textResult(
          `"${brand.id}" — ${brand.name}: ${brand.templates.length} template(s), ${brand.rules.length} rule(s), ${brand.cueQueries.length} cue query(ies), ${brand.musicMoods.length} music mood(s).`,
          { brand },
        );
      }
      return textResult(
        [
          `${brands.length} brand pack(s):`,
          ...brands.map((brand) => `  "${brand.id}" — ${brand.name} (${brand.templates.length} template(s))`),
          "  apply_template takes a template id from any pack; the project then carries that brand.",
        ].join("\n"),
        { brands },
      );
    },
  },
  {
    name: "set_brand",
    title: "Set the active brand",
    description:
      "Stamp a brand pack onto the open project (settings.brandId), so every brand-aware tool — add_text, enforce_brand_rules, export_video, generate_thumbnail — follows it from here on. It does NOT restyle clips already on the timeline; run enforce_brand_rules to see what a restyle would need, and set the brand BEFORE composing for a clean pass.",
    inputSchema: object({
      brand: choice("The brand id from list_brands.", BRAND_IDS),
    }),
    annotations: WRITE,
    run: (args) => {
      const brandId = need(args, "brand");
      const pack = brandById(brandId);
      if (!pack) return toolError(`No brand called "${brandId}" — list_brands shows the ids.`);
      editor().updateSettings({ brandId });
      return textResult(
        [
          `Set the active brand to "${pack.name}" (${pack.id}).`,
          "  · brand-aware tools (add_text, enforce_brand_rules, export_video, generate_thumbnail) now follow it",
          "  · existing clips are untouched — run enforce_brand_rules to see what a restyle would change",
        ].join("\n"),
        { brandId: pack.id, name: pack.name },
      );
    },
  },

  /* ------------------------------ composition ------------------------------ */
  {
    name: "create_timeline",
    title: "Create the brand timeline",
    description:
      "Load the active brand's fixed row layout — backdrop plus the empty rows (topic cue, brand bug, massive word, lower third, red rail, voiceover, music bed) — ready to be filled. This REPLACES the open project with a blank, brand-styled scaffold. Use apply_template to build a finished piece, or add_text / add_media_clip to fill this one.",
    inputSchema: object({
      brand: choice("Which brand's layout to scaffold. Defaults to the first pack.", BRAND_IDS),
    }),
    annotations: WRITE,
    run: (args) => {
      const requested = argString(args, "brand");
      const pack = requested ? brandById(requested) : undefined;
      if (requested && !pack) return toolError(`No brand called "${requested}" — list_brands shows the ids.`);
      const chosen = pack ?? BRAND_PACKS[0];
      const built = buildBrandScaffold(chosen);
      editor().loadProject(built.project, built.assets);
      editor().setCurrentTime(0);
      return textResult(
        [
          `Scaffolded "${chosen.name}" — ${built.rows.length} rows, back → front:`,
          ...built.rows.map((name, i) => `  ${i}. ${name}`),
          "  · the backdrop is the brand's void; every row is empty and ready to fill",
          "  · apply_template builds the full piece; add_text / add_media_clip fill a row at a time",
        ].join("\n"),
        { brand: chosen.id, rows: built.rows },
      );
    },
  },
  {
    name: "apply_template",
    title: "Apply a template",
    description:
      "Build a finished, brand-styled piece from a template id (list_brands lists them all) and load it, replacing the open project (undo history goes with the old one). The template supplies the massive word, lower third, brand bug and red rail; the cue, voice and music rows are left empty for the agent to fill with import_media + add_media_clip. Override the word and lower-third copy per call.",
    inputSchema: object(
      {
        template_name: str("A template id, e.g. \"insight-train-finance\".", { minLength: 1 }),
        bigWord: str("Override the massive word (one word, uppercased for you)."),
        lowerThird: str("Override the lower-third copy. \\n is an explicit line break."),
        dataNumber: str("Override the data figure (finance templates show one)."),
        name: str("Name for the new project. Defaults to the template's name."),
      },
      ["template_name"],
    ),
    annotations: WRITE,
    run: async (args) => {
      const templateName = need(args, "template_name");
      const resolved = resolveTemplate(templateName);
      if (!resolved) return toolError(`No template called "${templateName}" — list_brands shows the ids.`);
      const { template, pack } = resolved;
      const before = editor().project.settings.name;

      const built = buildBrandProject(template, {
        bigWord: argString(args, "bigWord"),
        lowerThird: argString(args, "lowerThird"),
        dataNumber: argString(args, "dataNumber"),
      });
      if (argString(args, "name")) built.project.settings.name = argString(args, "name")!;

      await flushAutosave();
      editor().loadProject(built.project, built.assets);
      editor().setCurrentTime(0);
      const record = await saveProject({ capturePoster: true, templateId: template.id });

      return textResult(
        [
          `Applied "${template.name}" (${pack.name}) — ${secs(built.duration)}, ${built.project.layerIds.length} clip(s) on ${built.rows.length} rows.`,
          `  · replaced "${before}" — it was autosaved, and undo history went with the old project`,
          `  · rows: ${built.rows.join(" / ")}`,
          ...built.notes.map((note) => `  · ${note}`),
          record ? `  · saved as "${record.name}" (${record.id})` : "  · not saved to the library",
          "  · import_media + add_media_clip fill the cue, voice and music rows; generate_video does it all in one call",
        ].join("\n"),
        {
          ok: true,
          templateId: template.id,
          brand: pack.id,
          projectId: editor().project.id,
          duration: round(built.duration, 3),
          rows: built.rows,
          notes: built.notes,
        },
      );
    },
  },
  {
    name: "add_text",
    title: "Add branded text",
    description:
      "Add a text layer in the active brand's type system, with the rules enforced: `massiveWord` is one word, display face, 700, ALL CAPS, heavy tracking; `lowerThird` is the body face on the brand plate; `subLabel` is muted grey. Colours are the brand's own — no drop shadows, no 3D, no gradients. A multi-word `massiveWord` is rejected.",
    inputSchema: object(
      {
        text: str("The text. \\n is an explicit line break.", { minLength: 1 }),
        style: choice("Which role to set it in.", ["massiveWord", "lowerThird", "subLabel"]),
        x: num("Centre x in project pixels. Defaults to a left-anchored position."),
        y: num("Centre y in project pixels. Defaults to the role's home."),
        start: num("Timeline seconds. Defaults to 0.", { minimum: 0 }),
        duration: num("Length in seconds. Defaults to the whole timeline.", { minimum: 0.06 }),
      },
      ["text", "style"],
    ),
    annotations: WRITE,
    run: (args) => {
      const pack = activeBrand(editor());
      const text = need(args, "text");
      const style = (argString(args, "style") ?? "massiveWord") as "massiveWord" | "lowerThird" | "subLabel";
      const state = editor();
      const unit = Math.min(state.project.settings.width, state.project.settings.height);

      const role = style === "massiveWord" ? "word" : style === "lowerThird" ? "lowerThird" : "subLabel";
      const content = style === "massiveWord" ? text.toUpperCase() : text;

      if (style === "massiveWord") {
        const words = content.trim().split(/\s+/).filter(Boolean);
        if (words.length > 1) {
          return toolError(`massiveWord is a single word — "${content}" is ${words.length}. The brand shows one word on screen.`);
        }
      }

      const textStyle = styleFor(pack, role, content, unit);
      const width = state.project.settings.width;
      const anchor = leftAnchor(
        textStyle,
        width,
        state.project.settings.height * (style === "massiveWord" ? 0.42 : style === "lowerThird" ? 0.56 : 0.62),
      );
      const trackId = trackIdForRole(role === "word" ? "word" : "lowerThird");

      const steps: Step[] = [
        {
          kind: "addText",
          content,
          text: textStyle,
          start: argNumber(args, "start") ?? 0,
          duration: argNumber(args, "duration") ?? Math.max(projectDuration(state.project), 4),
          x: argNumber(args, "x") ?? anchor.x,
          y: argNumber(args, "y") ?? anchor.y,
          ...(trackId ? { trackId } : {}),
        },
      ];

      return applyPlan("add_text", steps, {
        notes: [
          `${style} in the brand's type system`,
          style === "massiveWord" ? "display face, 700, ALL CAPS, heavy tracking — no shadow, no gradient" : "",
          style === "lowerThird" ? `body face on the ${pack.palette.background} plate` : "",
          style === "subLabel" ? `muted ${pack.palette.muted} sub-label` : "",
        ].filter(Boolean),
      });
    },
  },
  {
    name: "generate_video",
    title: "Assemble a video (auto mode)",
    description:
      "Compose a finished brand piece in one call from media the agent has ALREADY loaded via import_media. Builds the template (massive word, lower third, bug, rail), places the given cue/voice/music asset ids onto their rows with the brand treatment — cue forced monochrome at brand opacity, music hard-cut and looped at the brand mix — then optionally queues the render. No search or synthesis happens here: the assets must already be in the bin (list_assets).",
    inputSchema: object(
      {
        template: str("Template id from list_brands.", { minLength: 1 }),
        bigWord: str("Override the massive word."),
        lowerThird: str("Override the lower-third copy."),
        dataNumber: str("Override the data figure."),
        cueAssetId: str("An image asset already in the bin, to use as the faint topic cue."),
        voiceAssetId: str("An audio asset already in the bin, to lay on the voice row."),
        musicAssetId: str("An audio asset already in the bin, to lay on the music row (mixed under the voice)."),
        export: bool("Queue a render at the end. Defaults to true."),
        name: str("Name for the new project."),
      },
      ["template"],
    ),
    annotations: WRITE,
    run: async (args) => {
      const templateName = need(args, "template");
      const resolved = resolveTemplate(templateName);
      if (!resolved) return toolError(`No template called "${templateName}" — list_brands shows the ids.`);
      const { template, pack } = resolved;

      const built = buildBrandProject(template, {
        bigWord: argString(args, "bigWord"),
        lowerThird: argString(args, "lowerThird"),
        dataNumber: argString(args, "dataNumber"),
      });
      if (argString(args, "name")) built.project.settings.name = argString(args, "name")!;

      await flushAutosave();
      editor().loadProject(built.project, built.assets);
      editor().setCurrentTime(0);

      const state = editor();
      const duration = built.duration;
      const steps: Step[] = [];
      const notes: string[] = [];

      const asset = (id: string | undefined, label: string): string => {
        if (!id) return "";
        if (!state.assets[id]) throw new Error(`No asset with id "${id}" for the ${label} — load it with import_media, then list_assets.`);
        return id;
      };

      const cueAssetId = asset(argString(args, "cueAssetId"), "cue");
      if (cueAssetId) {
        const meta = state.assets[cueAssetId];
        const cueTrackId = mainTrackId(state.project) ?? trackIdForRole("cue");
        const cover =
          meta.width && meta.height
            ? Math.max(state.project.settings.width / meta.width, state.project.settings.height / meta.height)
            : undefined;
        const cueIdx = steps.length;
        steps.push({ kind: "addMedia", assetId: cueAssetId, start: 0, duration, ...(cueTrackId ? { trackId: cueTrackId } : {}) });
        steps.push({ kind: "applyLook", ids: [`$${cueIdx}`], lookId: "lineArt" });
        steps.push({ kind: "patchLayer", id: `$${cueIdx}`, patch: { opacity: template.cueOpacity ?? pack.cueOpacity } });
        if (cover !== undefined) steps.push({ kind: "setTransform", id: `$${cueIdx}`, scale: round(cover, 4) });
        notes.push(`cue → monochrome at ${Math.round((template.cueOpacity ?? pack.cueOpacity) * 100)}% opacity`);
      }

      const voiceAssetId = asset(argString(args, "voiceAssetId"), "voiceover");
      if (voiceAssetId) {
        const voiceTrackId = trackIdForRole("voice");
        steps.push({ kind: "addMedia", assetId: voiceAssetId, start: 0, ...(voiceTrackId ? { trackId: voiceTrackId } : {}) });
        notes.push("voice laid on the voice row");
      }

      const musicAssetId = asset(argString(args, "musicAssetId"), "music bed");
      if (musicAssetId) {
        const musicTrackId = trackIdForRole("music");
        const musicIdx = steps.length;
        steps.push({ kind: "addMedia", assetId: musicAssetId, start: 0, duration, ...(musicTrackId ? { trackId: musicTrackId } : {}) });
        steps.push({
          kind: "patchLayer",
          id: `$${musicIdx}`,
          patch: { volume: round(dbToGain(pack.musicUnderVoiceDb), 4), mediaLoop: true, audioFadeIn: 0, audioFadeOut: 0 },
        });
        notes.push(`music hard-cut, looped, at ${round(dbToGain(pack.musicUnderVoiceDb), 4)} (${pack.musicUnderVoiceDb} dB under the voice)`);
      }

      if (argBool(args, "export") ?? true) {
        steps.push({ kind: "export", options: present(exportOptionsFor(pack)) });
      }

      const result = applyPlan("generate_video", steps, { notes });
      await saveProject({ capturePoster: true, templateId: template.id });
      return result;
    },
  },

  /* ------------------------------ branding ------------------------------ */
  {
    name: "enforce_brand_rules",
    title: "Check or enforce brand rules",
    description:
      "Run the active brand's checklist against the live project: black void backdrop, no gradient, one word on screen, red rail present, circle top-left, music hard cut, cue at brand opacity. Reads by default; with `fix: true` it applies the corrections it can (backdrop, rail, bug, hard cut, cue opacity) as one undo step. The one-word rule is reported, not auto-fixed.",
    inputSchema: object({
      checklist: strList("Only check these rule ids. Omit for all."),
      fix: bool("Apply corrections. Defaults to false (read-only)."),
    }),
    annotations: WRITE,
    run: (args) => {
      const pack = activeBrand(editor());
      const state = editor();
      const only = argStringList(args, "checklist");
      const violations = brandViolations(state, pack).filter((v) => !only || only.includes(v.rule));
      const fix = argBool(args, "fix") ?? false;

      const bad = violations.filter((v) => !v.ok);
      const lines = [
        `${violations.length} rule(s) for "${pack.name}" — ${bad.length} failing:`,
        ...violations.map((v) => `  ${v.ok ? "✓" : "✗"} ${v.label}: ${v.detail}`),
      ];

      if (!fix || !bad.length) {
        return textResult(
          [...lines, fix && !bad.length ? "  nothing to fix — the project is on-brand" : '  pass fix: true to correct what it can'].join("\n"),
          { ok: bad.length === 0, brand: pack.id, violations, failing: bad.length },
        );
      }

      const steps: Step[] = [];
      const notes: string[] = [];
      const failing = new Set(bad.map((v) => v.rule));
      const duration = Math.max(projectDuration(state.project), 6);

      if (failing.has("void") || failing.has("noGradient")) {
        steps.push({ kind: "settings", patch: { backgroundColor: pack.palette.background, backgroundKind: "color" } });
        notes.push(`backdrop → ${pack.palette.background} (flat)`);
      }

      if (failing.has("rail")) {
        const railTrackId = trackIdForRole("rail");
        steps.push({
          kind: "addEffect",
          effectKind: "rail",
          style: { color: pack.rail.color, blend: "source-over", amount: 1, scale: pack.rail.thicknessPx / 8 },
          start: 0,
          duration,
          name: "Red rail",
          ...(railTrackId ? { trackId: railTrackId } : {}),
        });
        notes.push(`added the ${pack.rail.color} rail`);
      }

      if (failing.has("bug")) {
        const bugTrackId = trackIdForRole("bug");
        const bugIndex = steps.length;
        steps.push({
          kind: "addShape",
          shape: pack.bug.shape,
          style: { fill: pack.palette.accent, stroke: "transparent", strokeWidth: 0, depth: 0 },
          start: 0,
          duration,
          ...(bugTrackId ? { trackId: bugTrackId } : {}),
        });
        steps.push({
          kind: "setTransform",
          id: `$${bugIndex}`,
          x: pack.bug.insetPx,
          y: pack.bug.insetPx,
          scale: round(pack.bug.sizePx / 180, 4),
        });
        notes.push(`added the ${pack.palette.accent} brand bug, top-left`);
      }

      if (failing.has("hardCut")) {
        const music = layersForRole("music").filter((l) => l.type === "audio");
        for (const layer of music) steps.push({ kind: "patchLayer", id: layer.id, patch: { audioFadeIn: 0, audioFadeOut: 0 } });
        if (music.length) notes.push(`removed fades from ${music.length} music clip(s) — hard cut in/out`);
      }

      if (failing.has("cueOpacity")) {
        const cues = layersForRole("cue").filter((l) => l.type === "image" || l.type === "video");
        for (const layer of cues) steps.push({ kind: "patchLayer", id: layer.id, patch: { opacity: pack.cueOpacity } });
        if (cues.length) notes.push(`cue opacity → ${pack.cueOpacity}`);
      }

      if (failing.has("oneWord")) {
        notes.push("the one-word rule is reported, not auto-fixed — edit the word row with add_text");
      }

      return applyPlan("enforce_brand_rules", steps, {
        notes: ["fixes applied:", ...notes],
        extra: { violations, fixed: bad.length },
      });
    },
  },

  /* ------------------------------ export & automation ------------------------------ */
  {
    name: "export_video",
    title: "Export the video",
    description:
      "Queue a render with the brand's defaults: `resolution` \"4K\" (3840×2160), `fps` 24, `aspect` 16:9, `codec` H264 (→ mp4), `audio` AAC (→ included). These map onto the browser's real capabilities — H264/AAC need Chromium, and the format is probed at runtime — so what is actually written can fall back. Realtime capture: it runs at playback speed, keep the tab in the foreground.",
    inputSchema: object({
      resolution: choice("Output size.", ["4K", "1080p", "720p"]),
      fps: int("Frame rate. Defaults to the brand's 24.", { minimum: 1, maximum: 120 }),
      aspect: choice("Frame shape.", ["16:9", "9:16", "1:1"]),
      codec: choice("Video codec.", ["H264", "VP9", "auto"]),
      audio: choice("Audio.", ["AAC 320kbps", "Opus", "auto"]),
      fileName: str("Output filename, e.g. \"insight.mp4\"."),
    }),
    annotations: WRITE,
    run: (args) => {
      const pack = activeBrand(editor());
      const defaults = pack.exportDefaults;
      const resolution = (argString(args, "resolution") ?? defaults.resolution) as "4K" | "1080p" | "720p";
      const [width, height] = RESOLUTION_SIZE[resolution];
      const codec = argString(args, "codec") ?? defaults.codec;
      const audio = argString(args, "audio") ?? defaults.audio;

      const options = present<Record<string, unknown>>({
        width,
        height,
        fps: argNumber(args, "fps") ?? defaults.fps,
        format: codec === "H264" ? "mp4" : codec === "VP9" ? "webm" : "auto",
        includeAudio: audio !== undefined,
        fileName: argString(args, "fileName"),
      });

      return applyPlan("export_video", [{ kind: "export", options }], {
        notes: [
          `${resolution} ${width}×${height} @ ${options.fps ?? defaults.fps}fps, ${codec}/${audio}`,
          "H264/AAC are browser-dependent — the format is probed and may fall back (Firefox/Safari usually write WebM)",
        ],
      });
    },
  },
  {
    name: "generate_thumbnail",
    title: "Generate a thumbnail",
    description:
      "Render the brand poster — backdrop + red rail + top-left circle + one word — and register it as an image asset. Sized from the template (or the open project) so the word stays legible when the thumbnails shrink to 50px. Returns the asset id and the data URL.",
    inputSchema: object({
      template: str("Template id to render from. Defaults to the open project."),
      bigWord: str("Override the word."),
    }),
    annotations: WRITE,
    run: (args) => {
      const templateName = argString(args, "template");
      let project = editor().project;
      let assets = editor().assets;

      if (templateName) {
        const resolved = resolveTemplate(templateName);
        if (!resolved) return toolError(`No template called "${templateName}" — list_brands shows the ids.`);
        const built = buildBrandProject(resolved.template, { bigWord: argString(args, "bigWord") });
        project = built.project;
        assets = built.assets;
      }

      const poster = capturePoster(project, assets);
      if (!poster) return toolError("The thumbnail could not be rendered — the frame has nothing to show.");

      const blob = dataUrlToBlob(poster);
      const url = URL.createObjectURL(blob);
      const assetId = uid("asset");
      editor().addAsset({
        id: assetId,
        kind: "image",
        name: `${project.settings.name} — thumbnail`,
        mime: "image/jpeg",
        url,
        size: blob.size,
        generated: true,
        thumbnail: poster,
      });

      return textResult(
        `Thumbnail rendered for "${project.settings.name}" — asset ${assetId}, JPEG (${blob.size} bytes).`,
        { assetId, url, mime: "image/jpeg", bytes: blob.size },
      );
    },
  },
  {
    name: "generate_chapters",
    title: "Build the three-act structure",
    description:
      "Build a branded piece in three acts: an intro (brand bug and red rail draw in), a main act (massive word + lower third), and an outro (a centred sign-off + the brand's topic line, red rail held). The lengths are `intro_duration` / `main_duration` / `outro_duration`; `template_name` picks the brand template to build from (defaults to the first). Any audio for the intro comes from the agent via import_media — this tool only composes.",
    inputSchema: object({
      template_name: str("Template id from list_brands. Defaults to the first brand template."),
      bigWord: str("Override the massive word."),
      intro_duration: num("Intro length in seconds. Defaults to 3.", { minimum: 0.5 }),
      main_duration: num("Main length in seconds. Defaults to 4.", { minimum: 1 }),
      outro_duration: num("Outro length in seconds. Defaults to 3.", { minimum: 1 }),
    }),
    annotations: WRITE,
    run: async (args) => {
      const templateName = argString(args, "template_name");
      const resolved = templateName ? resolveTemplate(templateName) : undefined;
      if (templateName && !resolved) return toolError(`No template called "${templateName}" — list_brands shows the ids.`);
      const fallback = resolveTemplate(TEMPLATE_IDS[0])!;
      const template = resolved?.template ?? fallback.template;
      const pack = resolved?.pack ?? fallback.pack;

      const intro = Math.max(0.5, argNumber(args, "intro_duration") ?? 3);
      const main = Math.max(1, argNumber(args, "main_duration") ?? 4);
      const outro = Math.max(1, argNumber(args, "outro_duration") ?? 3);
      const total = intro + main + outro;

      const built = buildBrandProject(template, { bigWord: argString(args, "bigWord") });
      built.project.settings.name = `${template.name} — chapters`;
      for (const id of built.project.layerIds) {
        const layer = built.project.layers[id];
        if (layer.duration >= template.seconds - 1e-3) layer.duration = total;
      }
      await flushAutosave();
      editor().loadProject(built.project, built.assets);
      editor().setCurrentTime(0);

      const bug = layersForRole("bug")[0];
      const rail = layersForRole("rail")[0];
      const steps: Step[] = [];

      if (bug) {
        steps.push({ kind: "setKeyframes", id: bug.id, action: "add", prop: "opacity", at: 0, value: 0 });
        steps.push({ kind: "setKeyframes", id: bug.id, action: "add", prop: "opacity", at: intro * 0.6, value: 1, easing: "easeOut" });
      }
      if (rail) {
        steps.push({ kind: "setKeyframes", id: rail.id, action: "add", prop: "opacity", at: 0, value: 0 });
        steps.push({ kind: "setKeyframes", id: rail.id, action: "add", prop: "opacity", at: intro, value: 1, easing: "easeOut" });
      }

      const unit = Math.min(built.project.settings.width, built.project.settings.height);
      const signoffText = (pack.signoff ?? pack.name).toUpperCase();
      const signoff: TextStyle = {
        ...styleFor(pack, "word", signoffText, unit),
        content: signoffText,
        fontSize: Math.round(unit * 0.06),
        align: "center",
        letterSpacing: Math.round(unit * 0.008),
      };
      steps.push({
        kind: "addText",
        content: signoffText,
        text: signoff,
        start: intro + main,
        duration: outro,
        x: Math.round(built.project.settings.width / 2),
        y: Math.round(built.project.settings.height * 0.46),
      });
      const topicLine = pack.topicLine ?? "";
      if (topicLine) {
        const topics: TextStyle = {
          ...styleFor(pack, "subLabel", topicLine, unit),
          content: topicLine,
          align: "center",
          fontSize: Math.round(unit * 0.02),
        };
        steps.push({
          kind: "addText",
          content: topicLine,
          text: topics,
          start: intro + main,
          duration: outro,
          x: Math.round(built.project.settings.width / 2),
          y: Math.round(built.project.settings.height * 0.54),
        });
      }

      const notes = [
        `three acts: intro ${secs(intro)} → main ${secs(main)} → outro ${secs(outro)} (${secs(total)} total)`,
        "intro: brand bug + rail draw in",
        "main: massive word + lower third",
        "outro: centred sign-off + the topic line, red rail held",
        "add any intro audio (a sub-bass hit, a tick) yourself with import_media + add_media_clip",
      ];

      const result = applyPlan("generate_chapters", steps, {
        notes,
        extra: { intro, main, outro, total: round(total, 3) },
      });
      await saveProject({ capturePoster: true, templateId: template.id });
      return result;
    },
  },
];
