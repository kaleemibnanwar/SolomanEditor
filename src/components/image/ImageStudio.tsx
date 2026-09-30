/**
 * THE IMAGE STUDIO — the still-image canvas mode.
 *
 * A still image is the same project rendered at `time = 0`, so this mode reuses
 * the video editor's pieces with the temporal ones taken away: the Stage (canvas
 * + direct drag / marquee / selection), the Inspector (formatting) and the asset
 * library (filtered to images, overlays, effects, shapes, stickers, text and
 * backgrounds). There is no timeline, no transport and no playback — the canvas
 * is always the single frame at the origin.
 */
import { useState } from "react";
import { FileImage, ImagePlus, Upload } from "lucide-react";
import { toast } from "sonner";
import AssetLibrary from "@/components/editor/library/AssetLibrary";
import Inspector from "@/components/editor/Inspector";
import Stage from "@/components/editor/Stage";
import { Button } from "@/components/ui/button";
import { exportImage } from "@/lib/imageExport";
import { createEmptyProject, DEFAULT_SETTINGS, editor } from "@/store/editorStore";
import type { LibraryTab } from "@/types/editor";

/** Categories the image editor exposes — no video, audio, stock or transitions. */
const IMAGE_TABS: LibraryTab[] = ["media", "overlay", "effect", "filter", "shape", "sticker", "text", "background"];

/** A fresh square canvas, keeping the media bin so an imported image stays. */
function newImageCanvas() {
  editor().loadProject(
    createEmptyProject({ ...DEFAULT_SETTINGS, name: "Untitled image", width: 1080, height: 1080 }),
    editor().assets,
  );
  editor().setUi({ libraryTab: "media", inspectorTab: "transform" });
}

export default function ImageStudio() {
  const [busy, setBusy] = useState<"png" | "jpeg" | null>(null);

  const runExport = async (format: "png" | "jpeg") => {
    setBusy(format);
    try {
      const result = await exportImage({ format });
      toast.success("Image exported", { description: `${result.name} · ${result.width}×${result.height}` });
    } catch (error) {
      toast.error("Export failed", { description: error instanceof Error ? error.message : "Could not encode the image." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-km-border bg-km-panel px-3">
        <div className="flex items-center gap-2 text-[11px] text-km-faint">
          <FileImage className="h-3.5 w-3.5" />
          <span>Still image — the canvas renders a single frame</span>
        </div>

        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={newImageCanvas} className="h-7 text-[11.5px]">
            <ImagePlus className="h-3.5 w-3.5" />
            New
          </Button>
          <Button size="sm" variant="outline" onClick={() => void runExport("jpeg")} disabled={busy !== null} className="h-7 text-[11.5px]">
            JPG
          </Button>
          <Button size="sm" onClick={() => void runExport("png")} disabled={busy !== null} className="h-7 gap-1.5 text-[11.5px]">
            <Upload className="h-3.5 w-3.5" />
            {busy === "png" ? "Exporting…" : "Export PNG"}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <AssetLibrary tabs={IMAGE_TABS} />

        <main className="flex min-w-0 flex-1 flex-col">
          <Stage />
        </main>

        <Inspector />
      </div>
    </div>
  );
}
