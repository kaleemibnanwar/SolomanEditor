/**
 * File import bridge: files → assets (+ freshly created DOM elements) → the
 * store, and optionally straight onto the timeline at the playhead.
 */
import { toast } from "sonner";
import { assetMetaPatch, createAssetsFromFiles } from "@/lib/media";
import { editor } from "@/store/editorStore";
import { layerEnd } from "@/lib/project";
import type { TrackId } from "@/types/editor";

export interface ImportOptions {
  /** create a layer for each file as soon as its metadata is known */
  addToTimeline?: boolean;
  startTime?: number;
  /** force the row the new layers land on, instead of letting `placeLayer` choose */
  trackId?: TrackId;
  silent?: boolean;
}

export async function importFiles(files: File[], options: ImportOptions = {}): Promise<number> {
  const items = createAssetsFromFiles(files);
  if (!items.length) {
    toast.error("Those files aren't supported", { description: "Try MP4, WebM, MOV, PNG, JPG, WEBP, MP3, WAV or OGG." });
    return 0;
  }

  // Files dropped together stack one after another.
  let cursor = options.startTime ?? editor().currentTime;
  let added = 0;

  for (const { asset, meta } of items) {
    editor().addAsset(asset);
    if (options.addToTimeline) {
      const loaded = await meta;
      editor().updateAsset(asset.id, assetMetaPatch(loaded));
      const id = editor().addMediaLayer(asset.id, cursor, options.trackId);
      const layer = id ? editor().project.layers[id] : undefined;
      if (layer) cursor = layerEnd(layer) + 0.05;
    } else {
      void meta.then((loaded) => editor().updateAsset(asset.id, assetMetaPatch(loaded)));
    }
    added += 1;
  }

  if (!options.silent) {
    toast.success(
      added === 1 ? `Imported ${items[0].asset.name}` : `Imported ${added} files`,
      options.addToTimeline ? { description: "Added to the timeline at the playhead." } : undefined,
    );
  }
  return added;
}

export async function importFromInput(options: ImportOptions = {}) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = "video/*,image/*,audio/*";
  const files = await new Promise<File[]>((resolve) => {
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
  if (files.length) await importFiles(files, options);
}
