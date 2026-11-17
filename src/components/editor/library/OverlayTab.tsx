/**
 * The Overlay / Effect / Background trio.
 *
 * Effects and overlays share one grid implementation. Backgrounds show both
 * procedural (canvas-rendered) presets and real image backgrounds from
 * copyright-free sources (Unsplash).
 */
import { useState } from "react";
import { Download, Loader2, Plus } from "lucide-react";
import { PreviewImage } from "@/components/editor/library/PreviewImage";
import { CardTag, EmptyState, LibraryCard, SectionLabel } from "@/components/editor/library/pieces";
import {
  BACKGROUND_PRESETS,
  EFFECT_GROUPS,
  EFFECT_PRESETS,
  IMAGE_BACKGROUNDS,
  type EffectGroup,
  type ImageBackground,
} from "@/lib/library";
import { backgroundPreviewDataUrl, effectPreviewDataUrl } from "@/lib/preview";
import { importFiles } from "@/lib/importFiles";
import { editor, useEditor } from "@/store/editorStore";

const EFFECT_GROUP_LABEL: Record<EffectGroup, string> = Object.fromEntries(
  EFFECT_GROUPS.map((group) => [group.id, group.label]),
) as Record<EffectGroup, string>;

/** Effects + overlays: one grid, filtered to the groups a tab owns. */
export function EffectGrid({ groups, query }: { groups: EffectGroup[]; query: string }) {
  const needle = query.trim().toLowerCase();
  const presets = EFFECT_PRESETS.filter(
    (preset) =>
      groups.includes(preset.group) &&
      (!needle ||
        preset.label.toLowerCase().includes(needle) ||
        preset.hint.toLowerCase().includes(needle)),
  );

  const sections = groups
    .map((group) => ({ group, items: presets.filter((preset) => preset.group === group) }))
    .filter((section) => section.items.length > 0);

  if (!presets.length) {
    return (
      <EmptyState>
        Nothing here matches "{query.trim()}". Try "glow", "grain", "confetti" or "vignette".
      </EmptyState>
    );
  }

  return (
    <div>
      {sections.map(({ group, items }) => (
        <div key={group}>
          <SectionLabel right={`${items.length}`}>{EFFECT_GROUP_LABEL[group]}</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            {items.map((preset) => (
              <LibraryCard
                key={preset.id}
                label={preset.label}
                hint={preset.hint}
                aspect="video"
                preview={
                  <PreviewImage cacheKey={`fx:${preset.id}`} factory={() => effectPreviewDataUrl(preset)} />
                }
                badge={<CardTag>{preset.group}</CardTag>}
                onClick={() => editor().addEffectLayer(preset.style, preset.label)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Fetch a bundled background image and import it as a media layer.
 */
async function importImageBackground(bg: ImageBackground) {
  const url = `/backgrounds/${bg.filename}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}`);
  const blob = await res.blob();
  const file = new File([blob], bg.filename, { type: blob.type });
  await importFiles([file], { addToTimeline: true, silent: false });
}

/** Backgrounds — procedural presets + real image backgrounds from free sources. */
export function BackgroundGrid({ query }: { query: string }) {
  const needle = query.trim().toLowerCase();

  const presets = BACKGROUND_PRESETS.filter(
    (preset) =>
      !needle || preset.label.toLowerCase().includes(needle) || preset.hint.toLowerCase().includes(needle),
  );

  const imageBgs = IMAGE_BACKGROUNDS.filter(
    (bg) =>
      !needle ||
      bg.label.toLowerCase().includes(needle) ||
      bg.hint.toLowerCase().includes(needle) ||
      bg.category.toLowerCase().includes(needle),
  );

  const placed = useEditor((s) =>
    s.project.layerIds.map((id) => s.project.layers[id]?.name).filter(Boolean),
  );

  if (!presets.length && !imageBgs.length) {
    return <EmptyState>No backdrop matches "{query.trim()}".</EmptyState>;
  }

  return (
    <>
      {/* Image backgrounds from free sources */}
      {imageBgs.length > 0 && (
        <>
          <SectionLabel right={`${imageBgs.length}`}>Photo backgrounds</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            {imageBgs.map((bg) => (
              <ImageBackgroundCard key={bg.id} bg={bg} />
            ))}
          </div>
        </>
      )}

      {/* Procedural backgrounds */}
      {presets.length > 0 && (
        <>
          <SectionLabel right={`${presets.length}`}>Procedural backdrops</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            {presets.map((preset) => (
              <LibraryCard
                key={preset.id}
                label={preset.label}
                hint={preset.hint}
                aspect="video"
                active={placed.includes(preset.label)}
                preview={
                  <PreviewImage
                    cacheKey={`bg:${preset.id}`}
                    factory={() => backgroundPreviewDataUrl(preset)}
                  />
                }
                onClick={() => editor().addBackgroundLayer(preset)}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function ImageBackgroundCard({ bg }: { bg: ImageBackground }) {
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await importImageBackground(bg);
    } catch {
      // Silently fail — toast already shown by importFiles
    } finally {
      setLoading(false);
    }
  };

  return (
    <LibraryCard
      label={bg.label}
      hint={bg.hint}
      aspect="video"
      disabled={loading}
      actionIcon={loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
      actionTitle="Add to timeline"
      onAction={handleClick}
      onClick={handleClick}
      badge={<CardTag>{bg.category}</CardTag>}
      preview={
        <div className="km-checker h-full w-full">
          <img
            src={`/backgrounds/${bg.filename}`}
            alt={bg.label}
            loading="lazy"
            draggable={false}
            className="h-full w-full object-cover"
          />
          <div className="absolute bottom-1 right-1 flex items-center gap-1">
            <span className="rounded bg-black/70 px-1 py-0.5 text-[9px] text-white/80 backdrop-blur">
              <Download className="inline h-2.5 w-2.5 mr-0.5" />
              Free
            </span>
          </div>
        </div>
      }
    />
  );
}
