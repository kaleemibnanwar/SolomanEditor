/**
 * The Media / Video tabs: everything already in the project's library.
 *
 * Importing is deliberately a library action, not a timeline action — files land
 * here first and clicking a card drops it at the playhead, so bringing media in
 * never disturbs an edit in progress.
 */
import { useMemo } from "react";
import { AudioLines, FileImage, Film, ImagePlus, Music2, Trash2, Video } from "lucide-react";
import { CardTag, EmptyState, LibraryCard, SectionLabel } from "@/components/editor/library/pieces";
import { importFromInput } from "@/lib/importFiles";
import { assetPayload, startMediaDrag } from "@/lib/mediaDrag";
import { formatDurationLong } from "@/lib/time";
import { editor, useAssetIds, useAssets, useEditor } from "@/store/editorStore";
import type { Asset } from "@/types/editor";

const KIND_ICON = {
  video: Video,
  audio: Music2,
  image: FileImage,
  effect: FileImage,
} as const;

export function useLibraryAssets(kinds?: Asset["kind"][]): Asset[] {
  const assetIds = useAssetIds();
  const assets = useAssets();
  const all = assetIds.map((id) => assets[id]).filter(Boolean) as Asset[];
  return kinds ? all.filter((asset) => kinds.includes(asset.kind)) : all;
}

export default function MediaTab({ query, kinds }: { query: string; kinds?: Asset["kind"][] }) {
  const assets = useLibraryAssets(kinds);
  const needle = query.trim().toLowerCase();
  const shown = needle ? assets.filter((asset) => asset.name.toLowerCase().includes(needle)) : assets;

  const importLabel = kinds?.length === 1 ? `Import ${kinds[0]}` : "Import video, image or audio";

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void importFromInput()}
        className="flex h-[37px] w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[#505156] text-[11px] text-km-text transition hover:bg-km-raised"
      >
        <ImagePlus className="h-3.5 w-3.5" />
        {importLabel}
      </button>

      {shown.length === 0 ? (
        <EmptyState>
          {assets.length === 0
            ? "Nothing here yet. Import a file, or drop one straight onto the canvas."
            : `No ${kinds?.[0] ?? "media"} matches “${query.trim()}”.`}
        </EmptyState>
      ) : (
        <>
          <SectionLabel right={`${shown.length}`}>In this project</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            {shown.map((asset) => (
              <AssetCard key={asset.id} asset={asset} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Card
 * ------------------------------------------------------------------ */

function AssetCard({ asset }: { asset: Asset }) {
  const used = useEditor((s) =>
    s.project.layerIds.some((id) => s.project.layers[id]?.assetId === asset.id),
  );
  const Icon = KIND_ICON[asset.kind] ?? Film;

  const detail =
    asset.kind === "image"
      ? asset.width
        ? `${asset.width}×${asset.height}`
        : "still image"
      : formatDurationLong(asset.duration ?? 0);

  return (
    <LibraryCard
      label={asset.name}
      hint={asset.width && asset.kind !== "image" ? `${detail} · ${asset.width}×${asset.height}` : detail}
      active={used}
      onClick={() => editor().addMediaLayer(asset.id)}
      dragStart={(e) => startMediaDrag(assetPayload(asset), e)}
      actionIcon={<Trash2 className="h-3 w-3" />}
      actionTitle="Remove from the library"
      onAction={() => editor().removeAsset(asset.id)}
      preview={
        <div className="km-checker h-full w-full">
          {asset.thumbnail ? (
            <img src={asset.thumbnail} alt="" draggable={false} className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-km-faint">
              <Icon className="h-4 w-4" />
            </div>
          )}
          <div className="absolute bottom-1 left-1 flex items-center gap-1">
            <CardTag>{asset.kind}</CardTag>
          </div>
        </div>
      }
    />
  );
}

/** The Audio tab's own list of everything audible in the project — imported or generated. */
export function ProjectAudio({ query }: { query: string }) {
  const assets = useLibraryAssets(["audio"]);
  const needle = query.trim().toLowerCase();
  const shown = needle ? assets.filter((asset) => asset.name.toLowerCase().includes(needle)) : assets;

  if (!shown.length) {
    return (
      <EmptyState>
        {assets.length === 0
          ? "No audio yet — import a file, generate a sound effect, or narrate a line."
          : `No audio in the project matches “${query.trim()}”.`}
      </EmptyState>
    );
  }

  return (
    <>
      <SectionLabel right={`${shown.length}`}>In this project</SectionLabel>
      <div className="grid grid-cols-2 gap-2">
        {shown.map((asset) => (
          <LibraryCard
            key={asset.id}
            label={asset.name}
            hint={formatDurationLong(asset.duration ?? 0)}
            onClick={() => editor().addMediaLayer(asset.id)}
            dragStart={(e) => startMediaDrag(assetPayload(asset), e)}
            actionIcon={<Trash2 className="h-3 w-3" />}
            actionTitle="Remove from the library"
            onAction={() => editor().removeAsset(asset.id)}
            preview={
              <div className="grid h-full w-full place-items-center bg-km-panel text-km-audio">
                <AudioLines className="h-4 w-4" />
              </div>
            }
          />
        ))}
      </div>
    </>
  );
}
