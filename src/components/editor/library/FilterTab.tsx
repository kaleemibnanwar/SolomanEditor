/**
 * The Filter tab: colour looks.
 *
 * A look is not just a picture — it carries the actual filter chain and grade it
 * applies, and the card thumbnail is rendered through those values. "Active"
 * means the selected clip already matches those values exactly.
 */
import { PreviewImage } from "@/components/editor/library/PreviewImage";
import { EmptyState, Hint, LibraryCard, SectionLabel } from "@/components/editor/library/pieces";
import { FILTER_LOOKS, lookMatches } from "@/lib/library";
import { filterPreviewDataUrl } from "@/lib/preview";
import { editor, useEditor } from "@/store/editorStore";

export default function FilterTab({ query }: { query: string }) {
  const selectionCount = useEditor((s) => s.selection.length);

  // Exactly which look, if any, the first selected clip is wearing right now.
  const activeId = useEditor((s) => {
    const id = s.selection[0];
    if (!id) return null;
    const layer = s.project.layers[id];
    if (!layer) return null;
    return FILTER_LOOKS.find((look) => lookMatches(look, layer.filters, layer.grade))?.id ?? null;
  });

  const needle = query.trim().toLowerCase();
  const looks = FILTER_LOOKS.filter(
    (look) =>
      !needle || look.name.toLowerCase().includes(needle) || look.hint.toLowerCase().includes(needle),
  );

  return (
    <div className="space-y-2">
      {selectionCount === 0 ? (
        <EmptyState>Select a clip on the timeline and a look lands on it straight away.</EmptyState>
      ) : null}

      {looks.length === 0 ? (
        <EmptyState>No look matches “{query.trim()}”.</EmptyState>
      ) : (
        <>
          <SectionLabel right={`${looks.length}`}>Looks</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            {looks.map((look) => (
              <LibraryCard
                key={look.id}
                label={look.name}
                hint={look.hint}
                aspect="video"
                disabled={selectionCount === 0}
                active={activeId === look.id}
                preview={
                  <PreviewImage cacheKey={`look:${look.id}`} factory={() => filterPreviewDataUrl(look)} />
                }
                onClick={() => editor().applyFilterLook(look.id)}
              />
            ))}
          </div>
        </>
      )}

      <Hint>
        A look sets both the canvas filter chain and the colour grade, so what the card shows is what
        the clip gets. Fine-tune either one in the Inspector.
      </Hint>
    </div>
  );
}
