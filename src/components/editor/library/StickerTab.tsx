/**
 * Shapes, stickers and text — the "add something drawn" half of the library.
 *
 * These three place a brand new layer rather than restyling the selection, so
 * their cards carry no `active` state: adding one twice is a legitimate thing to
 * want, and a card that looks "already applied" would only be confusing.
 */
import { useState } from "react";
import { PreviewImage } from "@/components/editor/library/PreviewImage";
import { ChipRow, EmptyState, LibraryCard, SectionLabel } from "@/components/editor/library/pieces";
import {
  DEFAULT_SHAPE_STYLE,
  SHAPE_PRESETS,
  STICKER_PACKS,
  TEXT_PRESETS,
} from "@/lib/library";
import { shapePreviewDataUrl, textPreviewDataUrl } from "@/lib/preview";
import { editor } from "@/store/editorStore";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ *
 * Shapes
 * ------------------------------------------------------------------ */

export function ShapeGrid({ query }: { query: string }) {
  const needle = query.trim().toLowerCase();
  const shapes = SHAPE_PRESETS.filter((shape) => !needle || shape.label.toLowerCase().includes(needle));

  if (!shapes.length) return <EmptyState>No shape matches “{query.trim()}”.</EmptyState>;

  return (
    <>
      <SectionLabel right={`${shapes.length}`}>Vector shapes</SectionLabel>
      <div className="grid grid-cols-3 gap-2">
        {shapes.map((shape) => (
          <LibraryCard
            key={shape.id}
            label={shape.label}
            aspect="square"
            preview={
              <PreviewImage cacheKey={`shape:${shape.id}`} factory={() => shapePreviewDataUrl(shape.id)} />
            }
            onClick={() => editor().addShapeLayer(shape.id)}
          />
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Stickers
 * ------------------------------------------------------------------ */

export function StickerGrid({ query }: { query: string }) {
  const [packId, setPackId] = useState(STICKER_PACKS[0].id);
  const pack = STICKER_PACKS.find((option) => option.id === packId) ?? STICKER_PACKS[0];

  const needle = query.trim().toLowerCase();
  // A search looks across every pack — narrowing to one first would hide the
  // very thing being searched for.
  const glyphs = needle
    ? STICKER_PACKS.flatMap((option) => option.glyphs)
    : pack.glyphs;

  return (
    <>
      {!needle ? (
        <ChipRow
          options={STICKER_PACKS.map((option) => ({ value: option.id, label: option.label }))}
          value={packId}
          onChange={setPackId}
        />
      ) : null}

      <SectionLabel right={`${glyphs.length}`}>{needle ? "Matching every pack" : pack.label}</SectionLabel>

      {needle ? (
        <EmptyState>
          Sticker packs are grouped by mood, not by name — clear the search to browse “{pack.label}”
          and the other {STICKER_PACKS.length - 1} packs.
        </EmptyState>
      ) : null}

      <div className="grid grid-cols-5 gap-1.5">
        {glyphs.map((glyph, index) => (
          <button
            key={`${glyph}-${index}`}
            type="button"
            title={`Add ${glyph}`}
            onClick={() =>
              editor().addStickerLayer({ ...DEFAULT_SHAPE_STYLE, glyph, shape: undefined })
            }
            className={cn(
              "grid aspect-square place-items-center rounded-lg border border-km-border bg-km-panel2 text-[19px] leading-none",
              "transition hover:border-km-accent/60 hover:bg-km-raised/60",
            )}
          >
            <span className="translate-y-px">{glyph}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

export function TextGrid({ query }: { query: string }) {
  const needle = query.trim().toLowerCase();
  const presets = TEXT_PRESETS.filter(
    (preset) =>
      !needle ||
      preset.label.toLowerCase().includes(needle) ||
      preset.hint.toLowerCase().includes(needle) ||
      preset.sample.toLowerCase().includes(needle),
  );

  if (!presets.length) return <EmptyState>No text style matches “{query.trim()}”.</EmptyState>;

  /**
   * A preset is two things — the words it shows and the style it wears — so the
   * layer is created with the sample copy, then restyled. The second write is
   * part of the same gesture, so it does not push a second undo step.
   */
  const add = (presetId: string) => {
    const preset = TEXT_PRESETS.find((option) => option.id === presetId);
    if (!preset) return;
    const id = editor().addTextLayer(preset.sample);
    const layer = editor().project.layers[id];
    if (!layer?.text) return;
    editor().updateLayer(
      id,
      { text: { ...layer.text, ...preset.text, content: preset.sample } },
      false,
    );
  };

  return (
    <>
      <SectionLabel right={`${presets.length}`}>Text styles</SectionLabel>
      <div className="space-y-2">
        {presets.map((preset) => (
          <LibraryCard
            key={preset.id}
            label={preset.label}
            hint={preset.hint}
            aspect="banner"
            preview={
              <PreviewImage cacheKey={`text:${preset.id}`} factory={() => textPreviewDataUrl(preset)} />
            }
            onClick={() => add(preset.id)}
          />
        ))}
      </div>
    </>
  );
}
