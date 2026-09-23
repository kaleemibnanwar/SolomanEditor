/**
 * The Transition tab.
 *
 * A transition belongs to a *clip edge*, not to a clip, so the tab asks which
 * edge you are editing before it shows anything — and says so plainly when
 * nothing is selected, because `applyTransition` is a no-op without a selection
 * and a grid of cards that silently does nothing is the worst possible UI.
 */
import { useState } from "react";
import { CornerDownRight, CornerRightUp } from "lucide-react";
import { PreviewImage } from "@/components/editor/library/PreviewImage";
import { ChipRow, EmptyState, Hint, LibraryCard, SectionLabel } from "@/components/editor/library/pieces";
import { TRANSITION_CATEGORIES, TRANSITION_DEFS, type TransitionCategory } from "@/lib/transitions";
import { transitionPreviewDataUrl } from "@/lib/preview";
import { editor, useEditor } from "@/store/editorStore";
import { cn } from "@/lib/utils";

const EDGES: { value: "in" | "out"; label: "In" | "Out"; hint: string }[] = [
  { value: "in", label: "In", hint: "how the clip arrives" },
  { value: "out", label: "Out", hint: "how the clip leaves" },
];

export default function TransitionTab({ query }: { query: string }) {
  const [category, setCategory] = useState<TransitionCategory>("basic");
  const edge = useEditor((s) => s.ui.transitionEdge);
  const selectionCount = useEditor((s) => s.selection.length);

  // What the first selected clip already carries on the edge being edited.
  const current = useEditor((s) => {
    const id = s.selection[0];
    if (!id) return null;
    const layer = s.project.layers[id];
    if (!layer) return null;
    return (s.ui.transitionEdge === "in" ? layer.transitionIn : layer.transitionOut).type;
  });

  const needle = query.trim().toLowerCase();
  const defs = TRANSITION_DEFS.filter(
    (def) =>
      def.category === category &&
      (!needle || def.label.toLowerCase().includes(needle) || def.hint.toLowerCase().includes(needle)),
  );

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-1 rounded-lg border border-km-border bg-km-panel2 p-1">
        {EDGES.map((option) => {
          const on = option.value === edge;
          const Icon = option.value === "in" ? CornerDownRight : CornerRightUp;
          return (
            <button
              key={option.value}
              type="button"
              title={option.hint}
              onClick={() => editor().setUi({ transitionEdge: option.value })}
              className={cn(
                "flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[10.5px] transition",
                on ? "bg-km-accent/18 text-km-text" : "text-km-dim hover:bg-km-raised/50 hover:text-km-text",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {option.label} edge
            </button>
          );
        })}
      </div>

      {selectionCount === 0 ? (
        <EmptyState>
          Select a clip on the timeline first — a transition is applied to the {edge} edge of every
          selected clip.
        </EmptyState>
      ) : (
        <p className="px-0.5 text-[10.5px] text-km-faint">
          Applies to the {edge} edge of {selectionCount === 1 ? "the selected clip" : `${selectionCount} selected clips`}.
        </p>
      )}

      <ChipRow<TransitionCategory>
        options={TRANSITION_CATEGORIES.map((option) => ({ value: option.id, label: option.label }))}
        value={category}
        onChange={setCategory}
      />

      {defs.length === 0 ? (
        <EmptyState>No transition in this family matches “{query.trim()}”.</EmptyState>
      ) : (
        <>
          <SectionLabel right={`${defs.length}`}>Pick one</SectionLabel>
          <div className="grid grid-cols-2 gap-2">
            {defs.map((def) => (
              <LibraryCard
                key={def.id}
                label={def.label}
                hint={def.hint}
                aspect="video"
                disabled={selectionCount === 0}
                active={current === def.id}
                preview={
                  <PreviewImage
                    cacheKey={`tx:${def.id}`}
                    factory={() => transitionPreviewDataUrl(def.id)}
                  />
                }
                onClick={() => editor().applyTransition(def.id)}
              />
            ))}
          </div>
        </>
      )}

      <Hint>
        The card preview is rendered by the same code the timeline runs, at the midpoint of the
        move. Duration, direction and strength live in the Inspector, on the Transition tab.
      </Hint>
    </div>
  );
}
