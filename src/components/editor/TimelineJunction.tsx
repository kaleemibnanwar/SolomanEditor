/**
 * THE JUNCTION.
 *
 * Two clips that touch on one track meet at a SEAM, and the seam belongs to
 * neither of them — so it gets its own component rather than being bolted onto
 * a clip. What is drawn here is the join: the stretch of shared time (if any),
 * and a single glyph you click to bond, re-tune or cut the pair apart.
 *
 * The zone is deliberately tiny and sits *on top* of the clips, because the
 * thing it edits is invisible otherwise. Two rules keep that from being
 * annoying:
 *
 *  · A bonded junction is always visible — it is a real edit, and it should be
 *    obvious where the clip's tail has been extended over its neighbour.
 *  · A plain cut only shows its glyph when one of the two clips is selected, so
 *    a timeline full of butt-joined clips stays quiet, and the trim handles at
 *    the seam stay usable until you actually mean to work on the join.
 */
import { useState } from "react";
import { ArrowRight, Unlink } from "lucide-react";
import { ColorField, SegmentedField, SliderField, SmallButton } from "@/components/editor/fields";
import { ChipRow } from "@/components/editor/library/pieces";
import { PreviewImage } from "@/components/editor/library/PreviewImage";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MAX_BOND_OVERLAP, MIN_BOND_OVERLAP, type Junction } from "@/lib/bonds";
import { transitionPreviewDataUrl } from "@/lib/preview";
import {
  TRANSITION_CATEGORIES,
  TRANSITION_DEFS,
  transitionDef,
  type TransitionCategory,
} from "@/lib/transitions";
import { cn } from "@/lib/utils";
import { editor } from "@/store/editorStore";
import type { Transition, TransitionDirection, TransitionType } from "@/types/editor";

/** Width of the clickable zone centred on the seam. */
const ZONE_W = 18;

const DIRECTIONS: { value: TransitionDirection; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "up", label: "Up" },
  { value: "down", label: "Down" },
];

interface Props {
  junction: Junction;
  /** display row, in px from the top of the rows area */
  top: number;
  rowHeight: number;
  pps: number;
  fromName: string;
  toName: string;
  /** the longest bond these two clips can carry (see `maxBondDuration`) */
  maxDuration: number;
  /** the outgoing clip has run out of source, so its last frame is held */
  holdsLastFrame: boolean;
  /** one of the two clips is selected, so the join is worth showing */
  highlighted: boolean;
}

export default function TimelineJunction({
  junction,
  top,
  rowHeight,
  pps,
  fromName,
  toName,
  maxDuration,
  holdsLastFrame,
  highlighted,
}: Props) {
  const [open, setOpen] = useState(false);
  const [family, setFamily] = useState<TransitionCategory>(
    () => transitionDef(junction.transition.type)?.category ?? "basic",
  );

  const { bonded, overlap } = junction;
  const seamX = junction.seam * pps;
  const overlapPx = Math.max(0, overlap * pps);
  const zoneLeft = seamX + overlapPx / 2 - ZONE_W / 2;

  // What the popover is editing — or, at a plain cut, what a bond would start as.
  const working: Transition = junction.transition;
  const def = transitionDef(working.type);
  const ramps = working.type !== "none" && working.type !== "cut";

  /** Every edit to the bond goes through here, so none of them forgets the pair. */
  const bond = (patch: Partial<Transition>, record = true) =>
    editor().bondTransition(junction.from, junction.to, patch, record);

  const pick = (type: TransitionType) => {
    // The family only drives which cards are on screen; the pick itself is global.
    const next = transitionDef(type);
    if (next) setFamily(next.category);
    bond({ type });
  };

  const defs = TRANSITION_DEFS.filter((d) => d.category === family && d.id !== "none");
  const maxed = overlap >= maxDuration - 1e-3;

  return (
    <div
      className="pointer-events-none absolute z-[25]"
      style={{ top, height: rowHeight, left: zoneLeft, width: ZONE_W }}
    >
      {/* the stretch of time the two clips share, washed so it reads as one join */}
      {bonded && (
        <div
          className="pointer-events-none absolute rounded-[3px] bg-km-accent/20 ring-1 ring-inset ring-km-accent/45"
          style={{ left: seamX - zoneLeft, width: Math.max(2, overlapPx), top: 3, bottom: 3 }}
        />
      )}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            title={
              bonded
                ? `${fromName} → ${toName} · ${overlap.toFixed(2)}s bond. Click to edit.`
                : `${fromName} → ${toName} · hard cut. Click to add a transition.`
            }
            className={cn(
              "pointer-events-auto absolute left-1/2 top-1/2 grid h-[18px] w-[18px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-[5px] border backdrop-blur-sm transition",
              bonded
                ? "border-km-accent/70 bg-km-accent/25 text-white"
                : "border-white/25 bg-black/60 text-white/80 hover:border-km-accent/70 hover:bg-km-accent hover:text-white",
              bonded || highlighted || open
                ? "opacity-100"
                : "opacity-0 focus-visible:opacity-100 hover:opacity-100",
            )}
          >
            <JointGlyph bonded={bonded} />
          </button>
        </PopoverTrigger>

        <PopoverContent side="top" align="center" className="w-[272px] border-km-border bg-km-panel p-2.5">
          {/* who is joining whom */}
          <div className="flex items-center gap-1.5 text-[11.5px] text-km-text">
            <span className="min-w-0 flex-1 truncate">{fromName}</span>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-km-faint" />
            <span className="min-w-0 flex-1 truncate text-right">{toName}</span>
          </div>
          <p className="mt-1 text-[10.5px] leading-relaxed text-km-faint">
            {bonded
              ? `${fromName} runs ${overlap.toFixed(2)}s past the seam, under ${toName}'s ${
                  def?.label.toLowerCase() ?? "transition"
                }.`
              : "These clips butt up, so the incoming clip has nothing to transition from."}
          </p>

          {bonded ? (
            <div className="mt-2 flex gap-2">
              <span className="h-[46px] w-20 shrink-0 overflow-hidden rounded bg-km-panel2">
                {ramps && (
                  <PreviewImage
                    cacheKey={`bond:${working.type}:${working.direction ?? ""}:${working.softness ?? ""}:${
                      working.color ?? ""
                    }:${working.intensity ?? ""}`}
                    factory={() =>
                      transitionPreviewDataUrl(working.type, {
                        direction: working.direction,
                        softness: working.softness,
                        color: working.color,
                        intensity: working.intensity,
                      })
                    }
                  />
                )}
              </span>
              <div className="min-w-0 flex-1">
                {holdsLastFrame && (
                  <p className="text-[10px] leading-snug text-amber-300/90">
                    No frames left after {fromName}'s out point — its last frame is held for the overlap.
                  </p>
                )}
                {!holdsLastFrame && (
                  <p className="text-[10px] leading-snug text-km-faint">
                    Both clips hold real material through the overlap.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="mt-2 flex h-[46px] items-center gap-2 rounded border border-dashed border-km-border px-2">
              <Unlink className="h-4 w-4 shrink-0 text-km-faint" />
              <span className="text-[10px] leading-snug text-km-faint">
                Pick a transition below to overlap them.
              </span>
            </div>
          )}

          {bonded && (
            <>
              <div className="mt-2.5">
                <SliderField
                  label="Overlap"
                  value={Math.min(overlap, maxDuration)}
                  min={MIN_BOND_OVERLAP}
                  max={Math.max(MIN_BOND_OVERLAP + 0.05, Math.round(maxDuration * 100) / 100)}
                  step={0.05}
                  format={(v) => `${v.toFixed(2)}s`}
                  // The slider writes the tail length live; the gesture inside
                  // `SliderField` is what turns a drag into a single undo step.
                  onChange={(v) => bond({ duration: v }, false)}
                  onCommit={(v) => bond({ duration: v }, false)}
                />
                <p className="mt-0.5 text-[10px] text-km-faint">
                  {maxed
                    ? `At the limit for these clips (${MAX_BOND_OVERLAP}s max).`
                    : `Anything up to ${maxDuration.toFixed(2)}s fits.`}
                </p>
              </div>

              {def?.directional && (
                <SegmentedField
                  label="Direction"
                  value={working.direction ?? "left"}
                  options={DIRECTIONS}
                  onChange={(direction) => bond({ direction })}
                />
              )}

              {def?.params?.includes("softness") && (
                <SliderField
                  label="Softness"
                  value={working.softness ?? 0.35}
                  min={0}
                  max={1}
                  step={0.01}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => bond({ softness: v }, false)}
                  onCommit={(v) => bond({ softness: v }, false)}
                />
              )}

              {def?.params?.includes("intensity") && (
                <SliderField
                  label="Strength"
                  value={working.intensity ?? 1}
                  min={0}
                  max={2}
                  step={0.01}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(v) => bond({ intensity: v }, false)}
                  onCommit={(v) => bond({ intensity: v }, false)}
                />
              )}

              {def?.params?.includes("color") && (
                <ColorField
                  label="Colour"
                  value={working.color ?? "#ffffff"}
                  onChange={(v) => bond({ color: v }, false)}
                  onCommit={(v) => bond({ color: v }, false)}
                />
              )}
            </>
          )}

          {/* the picker: one family at a time, which is all that fits */}
          <div className="mt-2.5 border-t border-km-border/70 pt-2">
            <ChipRow<TransitionCategory>
              options={TRANSITION_CATEGORIES.map((option) => ({ value: option.id, label: option.label }))}
              value={family}
              onChange={setFamily}
            />
            <div className="km-scroll mt-1.5 grid max-h-[132px] grid-cols-3 gap-1 overflow-y-auto pr-1">
              {defs.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  title={option.hint}
                  onClick={() => pick(option.id)}
                  className={cn(
                    "truncate rounded border px-1 py-1 text-[10px] leading-tight transition",
                    option.id === working.type && bonded
                      ? "border-km-accent bg-km-accent/20 text-km-text"
                      : "border-km-border text-km-dim hover:border-km-accent/55 hover:text-km-text",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-2 flex items-center gap-1.5">
            <SmallButton
              tone="danger"
              disabled={!bonded}
              title={bonded ? "Restore a hard cut" : "These clips are already a hard cut"}
              onClick={() => {
                bond({ type: "cut" });
                setOpen(false);
              }}
            >
              <Unlink className="h-3.5 w-3.5" />
              Remove bond
            </SmallButton>
            <span className="ml-auto text-[10px] text-km-faint">
              {bonded ? `${overlap.toFixed(2)}s shared` : "no overlap"}
            </span>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * Two clip-cards, drawn inline so the glyph can *show* the state rather than
 * rely on colour: bonded cards overlap and the shared sliver is filled, a plain
 * cut leaves a visible gap.
 */
function JointGlyph({ bonded }: { bonded: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className="h-3 w-3" aria-hidden>
      <rect
        x={2}
        y={5}
        width={bonded ? 9.5 : 7}
        height={10}
        rx={1.5}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
      />
      <rect
        x={bonded ? 8.5 : 11}
        y={5}
        width={bonded ? 9.5 : 7}
        height={10}
        rx={1.5}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
      />
      {bonded && <rect x={8.5} y={6.2} width={3} height={7.6} fill="currentColor" opacity={0.75} />}
    </svg>
  );
}
