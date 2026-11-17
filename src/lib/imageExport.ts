/**
 * THE IMAGE EXPORT ENGINE.
 *
 * A still image is one frame of the compositor at `time = 0`, so exporting is
 * nothing like the video render: there is no realtime capture, no audio graph,
 * no playhead. The frame is drawn once into a project-resolution canvas, scaled
 * to the requested size, and encoded straight to a PNG or JPEG blob. That is
 * what makes it "swift" — a poster exports in the time it takes to paint one
 * frame, not to play a timeline.
 */
import { drawFrame } from "@/lib/compositor";
import { orderedLayers } from "@/lib/project";
import { formatBytes } from "@/lib/time";
import { editor } from "@/store/editorStore";

export interface ImageExportOptions {
  /** Output encoding. Defaults to "png". */
  format?: "png" | "jpeg";
  /** JPEG quality, 0..1. Ignored for PNG. */
  quality?: number;
  /** Output width in pixels. Defaults to the project's canvas width. */
  width?: number;
  /** Output height in pixels. Defaults to the project's canvas height. */
  height?: number;
  /** Output filename without extension. Defaults to the project name. */
  fileName?: string;
}

export interface ImageExportResult {
  url: string;
  name: string;
  size: number;
  width: number;
  height: number;
}

const safeName = (name: string) =>
  (name.trim() || "soloman-editor-image")
    .replace(/[^\w\-. ]+/g, "")
    .replace(/\s+/g, "-")
    // A caller may hand over a full filename ("poster.png"); the extension is
    // appended below, so strip a trailing one to avoid "poster.png.png".
    .replace(/\.(png|jpe?g|webp)$/i, "")
    .slice(0, 64);

/**
 * Renders the current project's single frame and downloads it as an image.
 * The download is triggered the same way the video exporter triggers its save
 * (`<a download>`), so the browser's own download flow handles it.
 */
export async function exportImage(options: ImageExportOptions = {}): Promise<ImageExportResult> {
  const state = editor();
  const project = state.project;
  const projectW = project.settings.width;
  const projectH = project.settings.height;

  const format = options.format ?? "png";
  const width = Math.max(16, Math.round(options.width ?? projectW));
  const height = Math.max(16, Math.round(options.height ?? projectH));

  // Compose at PROJECT resolution and scale afterwards — `renderInk` works in
  // absolute project pixels, so drawing straight into a resized context would
  // displace every layer the moment the export size differed from the project's.
  const frame = document.createElement("canvas");
  frame.width = projectW;
  frame.height = projectH;
  const fctx = frame.getContext("2d", { alpha: false });
  if (!fctx) throw new Error("The browser refused to create a render surface.");

  fctx.setTransform(1, 0, 0, 1, 0, 0);
  drawFrame({
    ctx: fctx,
    settings: project.settings,
    layers: orderedLayers(project),
    assets: state.assets,
    time: 0,
    animationComplete: true,
  });

  let out: HTMLCanvasElement = frame;
  if (width !== projectW || height !== projectH) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("The browser refused to create a render surface.");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(frame, 0, 0, projectW, projectH, 0, 0, width, height);
    out = canvas;
  }

  const mime = format === "jpeg" ? "image/jpeg" : "image/png";
  const blob = await new Promise<Blob | null>((resolve) =>
    out.toBlob(resolve, mime, format === "jpeg" ? Math.max(0, Math.min(1, options.quality ?? 0.92)) : undefined),
  );
  if (!blob) throw new Error("The browser refused to encode the image.");

  const url = URL.createObjectURL(blob);
  const fileName = `${safeName(options.fileName ?? project.settings.name)}.${format === "jpeg" ? "jpg" : "png"}`;

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  // The download has been handed to the browser; release the blob so repeated
  // exports don't pin every encoded frame for the life of the page.
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return { url, name: fileName, size: blob.size, width, height };
}

/** Human-readable size, for a tool report. */
export const describeImageExport = (result: ImageExportResult) =>
  `${result.name} · ${result.width}×${result.height} · ${formatBytes(result.size)}`;
