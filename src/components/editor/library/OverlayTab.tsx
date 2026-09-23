/**
 * The Overlay / Effect / Background trio.
 *
 * All three are the same kind of thing — a procedural full-frame layer — so they
 * share one grid implementation and differ only in which slice of the catalogue
 * they show. The previews come from the compositor's own render path, so a card
 * cannot promise something the canvas will not draw.
 */
import { PreviewImage } from "@/components/editor/library/PreviewImage";
import { CardTag, EmptyState, LibraryCard, SectionLabel } from "@/components/editor/library/pieces";
import {
  BACKGROUND_PRESETS,
  EFFECT_GROUPS,
  EFFECT_PRESETS,
  type EffectGroup,
} from "@/lib/library";
import { backgroundPreviewDataUrl, effectPreviewDataUrl } from "@/lib/preview";
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

  // The catalogue is ordered by group, so a heading per group reads better than
  // one long run of cards.
  const sections = groups
    .map((group) => ({ group, items: presets.filter((preset) => preset.group === group) }))
    .filter((section) => section.items.length > 0);

  if (!presets.length) {
    return (
      <EmptyState>
        Nothing here matches “{query.trim()}”. Try “glow”, “grain”, “confetti” or “vignette”.
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

/** Backgrounds — full-frame plates, and the same cards the timeline draws. */
export function BackgroundGrid({ query }: { query: string }) {
  const needle = query.trim().toLowerCase();
  const presets = BACKGROUND_PRESETS.filter(
    (preset) =>
      !needle || preset.label.toLowerCase().includes(needle) || preset.hint.toLowerCase().includes(needle),
  );

  // Background layers are ordinary effect layers, so the preset that is on the
  // timeline is the one whose card is lit.
  const placed = useEditor((s) =>
    s.project.layerIds.map((id) => s.project.layers[id]?.name).filter(Boolean),
  );

  if (!presets.length) {
    return <EmptyState>No backdrop matches “{query.trim()}”.</EmptyState>;
  }

  return (
    <>
      <SectionLabel right={`${presets.length}`}>Backdrops</SectionLabel>
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
  );
}
