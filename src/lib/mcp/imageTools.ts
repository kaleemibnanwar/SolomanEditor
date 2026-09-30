/**
 * IMAGE MODE TOOLS — the agent's hands for the still-image canvas.
 *
 * An image is a project rendered at `time = 0`, so every tool here compiles to
 * the SAME `Step[]` vocabulary the video editor uses (add media, text, shape,
 * sticker, effect, transform, filters, grade, reorder, remove, duplicate) and
 * hands the plan to the shared executor. Nothing in this file touches the store
 * directly beyond reading it, and nothing generates or searches media — an image
 * arrives through `import_media` (shared) or a `url`/`path` on `render_image`.
 *
 * The catalogue is deliberately smaller than the video one: no timeline, no
 * playback, no transitions, no keyframes, no audio. Two paths are offered, the
 * same split as the video editor:
 *
 *   · GRANULAR — `new_image`, `place_*`, `format_layer`, `reorder_layer`, …
 *     one edit per call, for iterating.
 *   · AUTO — `render_image`, a declarative one-shot that composes + verifies +
 *     exports in a single call.
 */
import { describeImageExport, exportImage, type ImageExportResult } from "@/lib/imageExport";
import {
  BLEND_OPTIONS,
  EFFECT_PRESETS,
  FONT_OPTIONS,
  SHAPE_PRESETS,
  TEXT_PRESETS,
} from "@/lib/library";
import { assetMetaPatch, createAssetsFromFiles } from "@/lib/media";
import { buildImageVerify } from "@/lib/mcp/observe";
import { readLocalFile } from "@/lib/mcp/host";
import { runPlan } from "@/lib/mcp/executor";
import {
  EFFECT_KINDS,
  READ,
  WRITE,
  applyPlan,
  argBool,
  argNumber,
  argString,
  argStringList,
  bool,
  choice,
  hasKeys,
  int,
  layerOf,
  need,
  num,
  object,
  present,
  presetOf,
  sizeToScale,
  str,
  strList,
  targets,
  transformPatch,
  type ToolDefinition,
} from "@/lib/mcp/kit";
import type { LayerPatch, Step } from "@/lib/mcp/steps";
import { textResult, toolError } from "@/lib/mcp/protocol";
import { round } from "@/lib/time";
import { createEmptyProject, editor } from "@/store/editorStore";
import type { BlendMode, EffectKind, EffectStyle, LayerFilters, LayerGrade, ShapeId, StickerStyle, TextStyle } from "@/types/editor";

/* ------------------------------------------------------------------ *
 * Image import (used by render_image)
 * ------------------------------------------------------------------ */

async function imageFileFromUrl(url: string, name: string | undefined): Promise<File> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`Could not fetch "${url}" — ${err instanceof Error ? err.message : "network error"}.`);
  }
  if (!res.ok) throw new Error(`Download failed (${res.status}) for "${url}".`);
  const blob = await res.blob();
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "png";
  const base = (name || "image").replace(/\.[^.]+$/, "");
  const fileName = /\./.test(base) ? base : `${base}.${ext}`;
  return new File([blob], fileName, { type: blob.type || "image/png" });
}

async function imageFileFromPath(filePath: string, name: string | undefined): Promise<File> {
  const loaded = await readLocalFile(filePath);
  const ext = filePath.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "png";
  const base = (name || loaded.name || "image").replace(/\.[^.]+$/, "");
  const fileName = /\./.test(base) ? base : `${base}.${ext}`;
  return new File([loaded.data], fileName, { type: "" });
}

/** Imports one image file through the ordinary path and returns its asset id. */
async function importImage(file: File, name?: string): Promise<string> {
  const [created] = createAssetsFromFiles([file]);
  if (!created) throw new Error(`"${file.name}" is not a supported image — pass a URL ending in a known image extension.`);
  if (name) created.asset.name = name;
  editor().addAsset(created.asset);
  const meta = await created.meta;
  editor().updateAsset(created.asset.id, assetMetaPatch(meta));
  return created.asset.id;
}

/* ------------------------------------------------------------------ *
 * report formatting
 * ------------------------------------------------------------------ */

function verifyText(payload: Record<string, unknown>): string[] {
  const canvas = payload.canvas as { width: number; height: number };
  const layers = (payload.layers as Array<Record<string, unknown>>) ?? [];
  const lines = [`${layers.length} layer(s) on a ${canvas.width}×${canvas.height} canvas, front-most first:`];
  for (const l of layers) {
    const b = l.bounds as { left: number; top: number; right: number; bottom: number } | null;
    const transform = l.transform as { x: number; y: number } | null;
    const bounds = b ? ` bounds ${b.left},${b.top} → ${b.right},${b.bottom}` : "";
    const flags = l.offCanvas ? "  ✗ OFF-CANVAS" : l.clippedByCanvas ? "  ⚠ clipped by the edge" : "";
    lines.push(`  ${l.name} (${l.type}) · ${Math.round((l.opacity as number) * 100)}% · centre ${transform?.x},${transform?.y}${bounds}${flags}`);
  }
  if (!layers.length) lines.push("  (nothing — an export would be the background alone)");
  return lines;
}

/* ------------------------------------------------------------------ *
 * Granular tools
 * ------------------------------------------------------------------ */

const IMAGE_TOOLS: ToolDefinition[] = [
  /* ------------------------------ canvas ------------------------------ */
  {
    name: "new_image",
    title: "Start a new image canvas",
    description:
      "Set up a fresh still-image document: a canvas of the given size and a background, with no layers on it. The media bin is kept, so an image imported earlier can still be placed. Do this first, or use update_project_settings to resize in place.",
    inputSchema: object({
      width: int("Canvas width in pixels.", { minimum: 16, maximum: 7680 }),
      height: int("Canvas height in pixels.", { minimum: 16, maximum: 7680 }),
      name: str("Document name. Also the default export filename."),
      backgroundColor: str("Flat background colour."),
      backgroundKind: choice("Flat colour or gradient.", ["color", "gradient"]),
      backgroundGradient: str("The gradient, as a CSS gradient string."),
      backgroundAngle: num("Gradient angle in degrees."),
    }),
    annotations: WRITE,
    run: (args) => {
      // Keep the current canvas by default — only what the caller names changes.
      // Starting over should not silently reset a 1080×1080 poster to 16:9.
      const current = editor().project.settings;
      const settings = {
        ...current,
        ...present({
          name: argString(args, "name"),
          width: argNumber(args, "width"),
          height: argNumber(args, "height"),
          backgroundColor: argString(args, "backgroundColor"),
          backgroundKind: argString(args, "backgroundKind") as "color" | "gradient" | undefined,
          backgroundGradient: argString(args, "backgroundGradient"),
          backgroundAngle: argNumber(args, "backgroundAngle"),
        }),
      };
      editor().loadProject(createEmptyProject(settings), editor().assets);
      editor().setCurrentTime(0);
      const s = editor().project.settings;
      return textResult(
        `New image "${s.name}" — ${s.width}×${s.height}, background ${s.backgroundKind}. The canvas is empty; place an image and layers next.`,
        { ok: true, name: s.name, canvas: { width: s.width, height: s.height }, background: s.backgroundKind },
      );
    },
  },

  /* ------------------------------ placing ------------------------------ */
  {
    name: "place_image",
    title: "Place an image",
    description:
      "Put an image asset on the canvas as a layer. `fit` is the shortcut that scales it to cover or contain the canvas from the image's real size; otherwise give x/y/scale/rotation explicitly. x/y are the layer CENTRE in project pixels (canvas centre is width/2, height/2).",
    inputSchema: object({
      assetId: str("Asset id from list_assets."),
      fit: choice("\"cover\" fills the canvas cropping the overflow; \"contain\" fits all of it inside.", ["cover", "contain"]),
      x: num("Centre x in project pixels."),
      y: num("Centre y in project pixels."),
      scale: num("Scale multiplier, where 1 is the image's natural size.", { minimum: 0.0001 }),
      rotation: num("Rotation in degrees."),
      opacity: num("Layer opacity, 0 to 1.", { minimum: 0, maximum: 1 }),
      name: str("Layer name."),
    }, ["assetId"]),
    annotations: WRITE,
    run: (args) => {
      const assetId = need(args, "assetId");
      const steps: Step[] = [{ kind: "addMedia", assetId, start: 0 }];

      const patch = transformPatch(args) ?? {};
      const fit = argString(args, "fit") as "cover" | "contain" | undefined;
      if (fit) {
        const settings = editor().project.settings;
        const asset = editor().assets[assetId];
        const natW = asset?.width || settings.width;
        const natH = asset?.height || settings.height;
        patch.scale = fit === "cover" ? Math.max(settings.width / natW, settings.height / natH) : Math.min(settings.width / natW, settings.height / natH);
      }
      if (hasKeys(patch)) steps.push({ kind: "setTransform", id: "$0", ...patch });

      const patchLayer: LayerPatch = present({ opacity: argNumber(args, "opacity"), name: argString(args, "name") });
      if (hasKeys(patchLayer)) steps.push({ kind: "patchLayer", id: "$0", patch: patchLayer });

      return applyPlan("place_image", steps);
    },
  },
  {
    name: "place_text",
    title: "Place formatted text",
    description:
      "Add a text layer and format it fully: font family, size, weight, colour, alignment, line height, letter spacing, outline, drop shadow, a background box behind it, a vertical gradient fill and skew. Start from a text preset id (list_library, section \"textPresets\") or set fields directly; explicit fields win.",
    inputSchema: object(
      {
        content: str("The text. Use \\n for a line break.", { minLength: 1 }),
        presetId: choice("A text preset to start from.", TEXT_PRESETS.map((preset) => preset.id)),
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
        skew: num("Vertical tilt in degrees."),
        x: num("Centre x in project pixels."),
        y: num("Centre y in project pixels."),
        scale: num("Scale multiplier.", { minimum: 0.0001 }),
        rotation: num("Rotation in degrees."),
        name: str("Layer name."),
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
          start: 0,
          ...present({
            x: argNumber(args, "x"),
            y: argNumber(args, "y"),
            scale: argNumber(args, "scale"),
            name: argString(args, "name"),
          }),
        },
      ];
      const rotation = argNumber(args, "rotation");
      if (rotation !== undefined) steps.push({ kind: "setTransform", id: "$0", rotation });

      return applyPlan("place_text", steps, {
        notes: preset ? [`started from the "${preset.label}" preset`] : undefined,
      });
    },
  },
  {
    name: "place_shape",
    title: "Place a vector shape",
    description:
      "Add a vector shape (card, star, badge, arrow, ring, bubble…) as a layer. Give `size` in project pixels and it is converted to the layer's scale. Fill, outline and inner-shadow depth style it.",
    inputSchema: object(
      {
        shape: choice("Which shape.", SHAPE_PRESETS.map((preset) => preset.id)),
        fill: str("Fill colour."),
        stroke: str("Outline colour."),
        strokeWidth: num("Outline width in pixels.", { minimum: 0 }),
        depth: num("Inner shadow, 0 flat to 1 deep.", { minimum: 0, maximum: 1 }),
        x: num("Centre x in project pixels."),
        y: num("Centre y in project pixels."),
        size: num("Width of the shape box in project pixels.", { minimum: 1 }),
        rotation: num("Rotation in degrees."),
        opacity: num("Layer opacity, 0 to 1.", { minimum: 0, maximum: 1 }),
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
        { kind: "addShape", shape: shapeId as ShapeId, start: 0, ...(hasKeys(style) ? { style } : {}) },
      ];

      const size = argNumber(args, "size");
      const transform = transformPatch(args);
      const patch = { ...(transform ?? {}), ...(size !== undefined ? { scale: sizeToScale(size) } : {}) };
      if (hasKeys(patch)) steps.push({ kind: "setTransform", id: "$0", ...patch });
      const opacity = argNumber(args, "opacity");
      if (opacity !== undefined) steps.push({ kind: "patchLayer", id: "$0", patch: { opacity } });

      return applyPlan("place_shape", steps, {
        notes: size !== undefined ? [`size ${size}px → scale ${round(sizeToScale(size), 3)}`] : undefined,
      });
    },
  },
  {
    name: "place_sticker",
    title: "Place an emoji or character",
    description:
      "Add an emoji or character glyph as an overlay layer (the \"overlays\" that aren't procedural). Any glyph works — list_library's \"stickers\" section lists the bundled packs. `size` is the box width in project pixels.",
    inputSchema: object(
      {
        glyph: str("The character or emoji to draw.", { minLength: 1 }),
        x: num("Centre x in project pixels."),
        y: num("Centre y in project pixels."),
        size: num("Width of the sticker box in project pixels.", { minimum: 1 }),
        rotation: num("Rotation in degrees."),
        opacity: num("Layer opacity, 0 to 1.", { minimum: 0, maximum: 1 }),
        name: str("Layer name."),
      },
      ["glyph"],
    ),
    annotations: WRITE,
    run: (args) => {
      const glyph = need(args, "glyph");
      const steps: Step[] = [{ kind: "addSticker", glyph, ...present({ name: argString(args, "name") }) }];

      const size = argNumber(args, "size");
      const transform = transformPatch(args);
      const patch = { ...(transform ?? {}), ...(size !== undefined ? { scale: sizeToScale(size) } : {}) };
      if (hasKeys(patch)) steps.push({ kind: "setTransform", id: "$0", ...patch });
      const opacity = argNumber(args, "opacity");
      if (opacity !== undefined) steps.push({ kind: "patchLayer", id: "$0", patch: { opacity } });

      return applyPlan("place_sticker", steps);
    },
  },
  {
    name: "place_overlay",
    title: "Place a procedural overlay / effect",
    description:
      "Add a procedural overlay or effect — light leak, glow, grain, vignette, scanlines, snow, confetti, a colour wash — as its own layer over everything beneath it. Prefer a preset id; pass `effectKind` only for a bare kind with your own style. `blend` sets how it composites (screen, multiply, overlay, …).",
    inputSchema: object({
      presetId: choice("An effect preset to use as the base.", EFFECT_PRESETS.map((preset) => preset.id)),
      effectKind: choice("A bare effect kind, if no preset fits.", EFFECT_KINDS),
      color: str("Primary colour."),
      color2: str("Secondary colour, for the two-colour kinds."),
      angle: num("Direction in degrees, for the directional kinds."),
      blend: choice("How the layer composites with what is beneath it.", BLEND_OPTIONS.map((option) => option.value)),
      amount: num("Density, count or spread, 0 to 1.", { minimum: 0, maximum: 1 }),
      scale: num("Element size for the particle kinds, 0 to 1.", { minimum: 0, maximum: 1 }),
      seed: num("Phase offset, so two overlays never look identical, 0 to 1.", { minimum: 0, maximum: 1 }),
      opacity: num("Layer opacity, 0 to 1.", { minimum: 0, maximum: 1 }),
      name: str("Layer name."),
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
            name: argString(args, "name"),
          }),
        },
      ];
      const opacity = argNumber(args, "opacity");
      if (opacity !== undefined) steps.push({ kind: "patchLayer", id: "$0", patch: { opacity } });

      return applyPlan("place_overlay", steps);
    },
  },

  /* ------------------------------ formatting ------------------------------ */
  {
    name: "format_layer",
    title: "Format a layer",
    description:
      "Change a layer's opacity, its canvas filters (brightness, contrast, saturation, blur, grayscale, sepia, hue, invert) and its colour grade (temperature, tint, fade, vignette, grain). Acts on the named layers, or the selection when none are named. Only the fields you pass change.",
    inputSchema: object({
      clipIds: strList("Layers to change. Defaults to the current selection."),
      opacity: num("Layer opacity, 0 to 1.", { minimum: 0, maximum: 1 }),
      brightness: num("1 is unchanged.", { minimum: 0, maximum: 4 }),
      contrast: num("1 is unchanged.", { minimum: 0, maximum: 4 }),
      saturate: num("1 is unchanged, 0 is greyscale.", { minimum: 0, maximum: 4 }),
      blur: num("Blur radius in pixels.", { minimum: 0, maximum: 40 }),
      grayscale: num("0 to 1.", { minimum: 0, maximum: 1 }),
      sepia: num("0 to 1.", { minimum: 0, maximum: 1 }),
      hueRotate: num("Hue shift in degrees.", { minimum: -180, maximum: 180 }),
      invert: num("0 to 1.", { minimum: 0, maximum: 1 }),
      temperature: num("Cool to warm, -1 to 1.", { minimum: -1, maximum: 1 }),
      tint: num("Green to magenta, -1 to 1.", { minimum: -1, maximum: 1 }),
      fade: num("Lifted blacks, 0 to 1.", { minimum: 0, maximum: 1 }),
      vignette: num("Corner darkening, 0 to 1.", { minimum: 0, maximum: 1 }),
      grain: num("Film grain, 0 to 1.", { minimum: 0, maximum: 1 }),
    }),
    annotations: WRITE,
    run: (args) => {
      const ids = targets(args);
      const steps: Step[] = [];
      const patch: LayerPatch = present({ opacity: argNumber(args, "opacity") });
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
      const grade: Partial<LayerGrade> = present({
        temperature: argNumber(args, "temperature"),
        tint: argNumber(args, "tint"),
        fade: argNumber(args, "fade"),
        vignette: argNumber(args, "vignette"),
        grain: argNumber(args, "grain"),
      });

      if (!hasKeys(patch) && !hasKeys(filters) && !hasKeys(grade)) {
        return toolError("Nothing to change — pass at least one of opacity, a filter value or a grade value.");
      }
      if (hasKeys(patch)) steps.push(...ids.map((id) => ({ kind: "patchLayer", id, patch }) as Step));
      if (hasKeys(filters)) steps.push({ kind: "setFilters", ids, filters });
      if (hasKeys(grade)) steps.push({ kind: "setGrade", ids, grade });

      return applyPlan("format_layer", steps);
    },
  },

  /* ------------------------------ arrangement ------------------------------ */
  {
    name: "reorder_layer",
    title: "Reorder a layer in the stack",
    description:
      "Bring a layer forward or send it backward in the drawing stack (top = drawn last = in front). Z-order is the still image's only depth, so this is how you put text above an image or an overlay behind it.",
    inputSchema: object(
      {
        clipId: str("The layer to move."),
        direction: choice("Which way through the stack.", ["up", "down", "top", "bottom"]),
      },
      ["clipId", "direction"],
    ),
    annotations: WRITE,
    run: (args) => {
      const clipId = need(args, "clipId");
      layerOf(clipId);
      return applyPlan("reorder_layer", [{ kind: "reorder", id: clipId, direction: need(args, "direction") as "up" | "down" | "top" | "bottom" }]);
    },
  },
  {
    name: "delete_layer",
    title: "Delete layers",
    description: "Remove layers from the canvas. The assets themselves are never deleted, so an image can always be placed again.",
    inputSchema: object({ clipIds: strList("The layers to delete.", { minItems: 1 }) }, ["clipIds"]),
    annotations: { ...WRITE, destructiveHint: true },
    run: (args) => applyPlan("delete_layer", [{ kind: "remove", ids: argStringList(args, "clipIds") as string[] }]),
  },
  {
    name: "duplicate_layer",
    title: "Duplicate layers",
    description: "Copy layers, including their transform, filters and grade. The copies are placed above the originals and left selected.",
    inputSchema: object({ clipIds: strList("The layers to copy.", { minItems: 1 }) }, ["clipIds"]),
    annotations: WRITE,
    run: (args) => applyPlan("duplicate_layer", [{ kind: "duplicate", ids: argStringList(args, "clipIds") as string[] }]),
  },

  /* ------------------------------ verify + export ------------------------------ */
  {
    name: "verify_image",
    title: "Verify what is on the image",
    description:
      "Exactly what will come out, computed from the same geometry the canvas draws: every visible layer front-most first, with its z-order, opacity, evaluated transform and the axis-aligned on-canvas bounding box in project pixels, plus which layers are clipped by the edge or sit fully off it. Use this to confirm a title is where you put it before exporting.",
    inputSchema: object({}),
    annotations: READ,
    run: () => {
      const payload = buildImageVerify(editor());
      return textResult(verifyText(payload).join("\n"), payload);
    },
  },
  {
    name: "export_image",
    title: "Export the image",
    description:
      "Render the canvas to a PNG or JPEG and download it. This is a single-frame render — it finishes in an instant, no realtime capture. Size defaults to the canvas; give a different width/height to resize the output.",
    inputSchema: object({
      format: choice("Encoding. PNG is lossless; JPEG is smaller.", ["png", "jpeg"]),
      quality: num("JPEG quality, 0 to 1.", { minimum: 0, maximum: 1 }),
      width: int("Output width in pixels.", { minimum: 16, maximum: 7680 }),
      height: int("Output height in pixels.", { minimum: 16, maximum: 7680 }),
      fileName: str("Output filename, e.g. \"poster.png\"."),
    }),
    annotations: WRITE,
    run: async (args) => {
      try {
        const result = await exportImage({
          format: (argString(args, "format") as "png" | "jpeg" | undefined) ?? "png",
          quality: argNumber(args, "quality"),
          width: argNumber(args, "width"),
          height: argNumber(args, "height"),
          fileName: argString(args, "fileName"),
        });
        return textResult(`Exported ${describeImageExport(result)}.`, { ok: true, ...result });
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "The image could not be exported.");
      }
    },
  },

  /* ------------------------------ declarative one-shot ------------------------------ */
  {
    name: "render_image",
    title: "Render an image from a manifest",
    description:
      "Compose a still image in one call from a declarative JSON manifest: canvas + background, one base image (by `assetId`, `url` or `path`), any number of texts/shapes/stickers/overlays, an optional filter look, and an optional export. It compiles to a plan, applies it atomically, verifies the geometry, and exports if asked. This is the fast path — iterate with the granular place_*/format_layer tools afterwards if needed.",
    inputSchema: {
      type: "object",
      properties: { manifest: { type: "object", description: "The image manifest (see description).", additionalProperties: true } },
      additionalProperties: false,
    },
    annotations: WRITE,
    run: async (args) => {
      const manifest = (args.manifest ?? {}) as ImageManifest;
      try {
        return await renderImageManifest(manifest);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : String(error));
      }
    },
  },
];

/* ------------------------------------------------------------------ *
 * The manifest compiler (render_image)
 * ------------------------------------------------------------------ */

interface ImageManifest {
  name?: string;
  canvas?: { width?: number; height?: number };
  background?: { kind?: "color" | "gradient"; color?: string; gradient?: string; angle?: number };
  image?: { url?: string; path?: string; assetId?: string; fit?: "cover" | "contain"; x?: number; y?: number; scale?: number; rotation?: number; opacity?: number; name?: string };
  texts?: Array<Record<string, unknown>>;
  shapes?: Array<Record<string, unknown>>;
  stickers?: Array<Record<string, unknown>>;
  overlays?: Array<Record<string, unknown>>;
  look?: { apply: string };
  export?: { format?: "png" | "jpeg"; width?: number; height?: number; quality?: number; fileName?: string };
}

class ImageManifestError extends Error {}

async function renderImageManifest(manifest: ImageManifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new ImageManifestError("The manifest must be a JSON object.");
  }

  const hasImage = !!manifest.image;
  const hasLayers =
    (manifest.texts?.length ?? 0) +
      (manifest.shapes?.length ?? 0) +
      (manifest.stickers?.length ?? 0) +
      (manifest.overlays?.length ?? 0) >
    0;
  if (!hasImage && !hasLayers) {
    throw new ImageManifestError('The manifest has nothing to place — give an "image" and/or entries in "texts", "shapes", "stickers" or "overlays".');
  }

  const state = editor();
  const W = manifest.canvas?.width ?? state.project.settings.width;
  const H = manifest.canvas?.height ?? state.project.settings.height;

  const steps: Step[] = [];

  // 1. canvas + background + name (only when any of them are actually given).
  const settingsPatch = present<Record<string, unknown>>({
    name: manifest.name,
    width: manifest.canvas?.width,
    height: manifest.canvas?.height,
    backgroundColor: manifest.background?.color,
    backgroundKind: manifest.background?.kind,
    backgroundGradient: manifest.background?.gradient,
    backgroundAngle: manifest.background?.angle,
  });
  if (hasKeys(settingsPatch)) steps.push({ kind: "settings", patch: settingsPatch });

  // 2. the base image.
  let pictureStep = -1;
  if (manifest.image) {
    const img = manifest.image;
    let assetId = img.assetId;
    if (!assetId) {
      if (!img.url && !img.path) throw new ImageManifestError('The "image" needs an assetId, url or path.');
      const file = img.url ? await imageFileFromUrl(img.url, img.name) : await imageFileFromPath(img.path!, img.name);
      assetId = await importImage(file, img.name);
    }
    pictureStep = steps.length;
    steps.push({ kind: "addMedia", assetId, start: 0 });

    const patch = present<Record<"x" | "y" | "scale" | "rotation", number>>({
      x: img.x,
      y: img.y,
      scale: img.scale,
      rotation: img.rotation,
    });
    if (img.fit) {
      const asset = editor().assets[assetId];
      const natW = asset?.width || W;
      const natH = asset?.height || H;
      patch.scale = img.fit === "cover" ? Math.max(W / natW, H / natH) : Math.min(W / natW, H / natH);
    }
    if (hasKeys(patch)) steps.push({ kind: "setTransform", id: `$${pictureStep}`, ...patch });
    if (img.opacity !== undefined) steps.push({ kind: "patchLayer", id: `$${pictureStep}`, patch: { opacity: img.opacity } });
    if (img.name) steps.push({ kind: "patchLayer", id: `$${pictureStep}`, patch: { name: img.name } });
  }

  // 3. texts / shapes / stickers / overlays — reuse the same field names as the granular tools.
  for (const t of manifest.texts ?? []) {
    if (typeof t.content !== "string" || !t.content) throw new ImageManifestError('Each entry in "texts" needs a string "content".');
    const idx = steps.length;
    steps.push({
      kind: "addText",
      content: t.content,
      text: present<Partial<TextStyle>>({
        fontFamily: t.fontFamily as string,
        fontSize: t.fontSize as number,
        fontWeight: t.fontWeight as number,
        color: t.color as string,
        align: t.align as TextStyle["align"],
        lineHeight: t.lineHeight as number,
        letterSpacing: t.letterSpacing as number,
        backgroundColor: t.backgroundColor as string,
        backgroundRadius: t.backgroundRadius as number,
        strokeColor: t.strokeColor as string,
        strokeWidth: t.strokeWidth as number,
        shadow: t.shadow as boolean,
        gradient: t.gradient as number,
        gradientColor: t.gradientColor as string,
        skew: t.skew as number,
      }),
      ...present({ x: t.x as number, y: t.y as number, scale: t.scale as number, name: t.name as string }),
    });
    if (t.rotation !== undefined) steps.push({ kind: "setTransform", id: `$${idx}`, rotation: t.rotation as number });
  }

  for (const s of manifest.shapes ?? []) {
    if (typeof s.shape !== "string") throw new ImageManifestError('Each entry in "shapes" needs a "shape" id.');
    const shape = s.shape as ShapeId;
    const style = present<Partial<StickerStyle>>({
      fill: s.fill as string,
      stroke: s.stroke as string,
      strokeWidth: s.strokeWidth as number,
      depth: s.depth as number,
    });
    const idx = steps.length;
    steps.push({ kind: "addShape", shape, ...(hasKeys(style) ? { style } : {}) });
    const patch = present<Record<"x" | "y" | "scale" | "rotation", number>>({ x: s.x as number, y: s.y as number, rotation: s.rotation as number });
    if (s.size !== undefined) patch.scale = sizeToScale(s.size as number);
    if (hasKeys(patch)) steps.push({ kind: "setTransform", id: `$${idx}`, ...patch });
    if (s.opacity !== undefined) steps.push({ kind: "patchLayer", id: `$${idx}`, patch: { opacity: s.opacity as number } });
  }

  for (const s of manifest.stickers ?? []) {
    if (typeof s.glyph !== "string" || !s.glyph) throw new ImageManifestError('Each entry in "stickers" needs a "glyph".');
    const idx = steps.length;
    steps.push({ kind: "addSticker", glyph: s.glyph, ...present({ name: s.name as string }) });
    const patch = present<Record<"x" | "y" | "scale" | "rotation", number>>({ x: s.x as number, y: s.y as number, rotation: s.rotation as number });
    if (s.size !== undefined) patch.scale = sizeToScale(s.size as number);
    if (hasKeys(patch)) steps.push({ kind: "setTransform", id: `$${idx}`, ...patch });
    if (s.opacity !== undefined) steps.push({ kind: "patchLayer", id: `$${idx}`, patch: { opacity: s.opacity as number } });
  }

  for (const o of manifest.overlays ?? []) {
    if (!o.presetId && !o.effectKind) throw new ImageManifestError('Each entry in "overlays" needs a "presetId" or "effectKind".');
    const idx = steps.length;
    steps.push({
      kind: "addEffect",
      ...present({
        presetId: o.presetId as string,
        effectKind: o.effectKind as EffectKind,
        style: present<Partial<EffectStyle>>({
          color: o.color as string,
          color2: o.color2 as string,
          angle: o.angle as number,
          blend: o.blend as BlendMode,
          amount: o.amount as number,
          scale: o.scale as number,
          seed: o.seed as number,
        }) as Partial<EffectStyle> | undefined,
        name: o.name as string,
      }),
    });
    if (o.opacity !== undefined) steps.push({ kind: "patchLayer", id: `$${idx}`, patch: { opacity: o.opacity as number } });
  }

  // 4. look — applied to the base image only (a look is a picture correction).
  if (manifest.look?.apply) {
    if (pictureStep >= 0) steps.push({ kind: "applyLook", ids: [`$${pictureStep}`], lookId: manifest.look.apply });
  }

  // 5. run the plan.
  const report = runPlan(steps, { label: "render_image" });

  // 6. verify.
  const verify = buildImageVerify(editor());

  // 7. export.
  let exported: ImageExportResult | null = null;
  let exportError: string | null = null;
  if (report.ok && manifest.export) {
    try {
      exported = await exportImage(manifest.export);
    } catch (error) {
      exportError = error instanceof Error ? error.message : String(error);
    }
  }

  const lines = [
    `render_image — ${report.ok ? "done" : "STOPPED part-way"} (${report.steps.length} step(s))`,
    ...verifyText(verify),
    ...(exported ? [`Exported ${describeImageExport(exported)}`] : []),
  ];
  if (exportError) lines.push(`  ! export failed: ${exportError}`);
  if (report.error) lines.push(`  error: ${report.error}`);
  for (const warning of report.warnings) lines.push(`  ! ${warning}`);

  const result = textResult(lines.join("\n"), {
    ok: report.ok,
    label: "render_image",
    stepCount: report.steps.length,
    created: report.created,
    canvas: verify.canvas,
    layerCount: verify.layerCount,
    verify,
    exported,
    exportError,
    error: report.error,
  });
  return report.ok ? result : { ...result, isError: true };
}

/* ------------------------------------------------------------------ *
 * Exports
 * ------------------------------------------------------------------ */

export { IMAGE_TOOLS };
