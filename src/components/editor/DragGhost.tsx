/**
 * The card that follows the cursor while media is being dragged in from the
 * library (see `lib/mediaDrag`).
 *
 * Two things about it are load-bearing rather than cosmetic:
 *
 *  - `pointer-events-none`. The drop surface is found with
 *    `document.elementFromPoint`, so a ghost the cursor could hit would answer
 *    for the surface underneath it and every drop would resolve to nothing.
 *  - It reads the whole drag object in ONE subscription. A pointermove is
 *    already one render of this component; subscribing per field would make it
 *    several, and this is the only thing in the app that wants raw x/y anyway.
 */
import { createPortal } from "react-dom";
import { FileImage, Film, Music2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useDrag } from "@/lib/mediaDrag";
import type { Asset } from "@/types/editor";

/** Keyed by the payload's media kind, so a new kind is a compile error here. */
const KIND_ICON: Record<Asset["kind"], LucideIcon> = {
  video: Film,
  image: FileImage,
  audio: Music2,
};

const KIND_TINT: Record<Asset["kind"], string> = {
  video: "border-km-video/70 text-km-video",
  image: "border-km-image/70 text-km-image",
  audio: "border-km-audio/70 text-km-audio",
};

export function DragGhost() {
  const drag = useDrag((state) => state);

  if (!drag) return null;

  const { payload, target } = drag;
  const Icon = KIND_ICON[payload.media];
  const live = !!target;

  return createPortal(
    <div
      className="pointer-events-none fixed z-[80] w-40 select-none"
      style={{ left: drag.x + 14, top: drag.y + 14 }}
    >
      <div
        className={[
          "overflow-hidden rounded-lg border bg-km-panel2/95 shadow-2xl shadow-black/50 backdrop-blur",
          live ? "border-km-accent/80" : "border-white/25",
        ].join(" ")}
      >
        <div className="relative h-16 w-full overflow-hidden bg-km-track">
          {payload.thumb ? (
            <img src={payload.thumb} alt="" draggable={false} className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center text-km-faint">
              <Icon className="h-4 w-4" />
            </div>
          )}
          <span
            className={[
              "absolute left-1 top-1 grid h-5 w-5 place-items-center rounded border bg-black/70 backdrop-blur",
              KIND_TINT[payload.media],
            ].join(" ")}
          >
            <Icon className="h-3 w-3" />
          </span>
        </div>
        <div className="truncate px-1.5 py-1 text-[10.5px] leading-tight text-km-text">{payload.label}</div>
      </div>

      <p className="mt-1 text-center text-[9.5px] text-white/70 drop-shadow">
        {live ? "Drop to place" : "Drag onto the timeline or canvas"}
      </p>
    </div>,
    document.body,
  );
}
