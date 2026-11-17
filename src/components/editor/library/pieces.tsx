/**
 * Shared parts of the asset library.
 *
 * Twelve tabs have to read as one surface, so the search field, the chip rows,
 * the card frame and the empty state all live here rather than being re-invented
 * per tab.
 */
import type { ReactNode } from "react";
import { Info, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

export function SearchField({
  value,
  onChange,
  placeholder = "Search",
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-km-faint" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="h-[37px] rounded-lg border-[#303135] bg-[#1c1d20] pl-8 pr-7 text-[12px] text-km-text placeholder:text-[#73757a] focus-visible:ring-1 focus-visible:ring-km-accent"
      />
      {value.length > 0 && (
        <button
          type="button"
          onClick={() => onChange("")}
          title="Clear"
          className="absolute right-1.5 top-1/2 grid h-4 w-4 -translate-y-1/2 place-items-center rounded text-km-faint transition hover:text-km-text"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Chips
 * ------------------------------------------------------------------ */

export interface ChipOption<T extends string> {
  value: T;
  label: string;
}

/** A horizontally scrolling row of filter chips. */
export function ChipRow<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: ChipOption<T>[];
  value: T;
  onChange: (next: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-full border px-2 py-[3px] text-[10.5px] leading-none transition",
              active
                ? "border-km-text/70 bg-km-raised text-km-text"
                : "border-km-border bg-km-panel2 text-km-dim hover:border-km-text/40 hover:text-km-text",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Structure
 * ------------------------------------------------------------------ */

export function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-1.5 mt-3 flex items-center justify-between gap-2 first:mt-0">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-km-faint">{children}</span>
      {right ? <span className="text-[10px] text-km-faint">{right}</span> : null}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 rounded-md border border-dashed border-km-border px-2.5 py-3 text-[10.5px] leading-relaxed text-km-faint">
      <Info className="mt-px h-3 w-3 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="px-0.5 py-2 text-[10.5px] leading-relaxed text-km-faint">{children}</p>;
}

/* ------------------------------------------------------------------ *
 * Card
 * ------------------------------------------------------------------ */

export type CardAspect = "video" | "square" | "wide" | "banner";

const ASPECT: Record<CardAspect, string> = {
  video: "aspect-video",
  square: "aspect-square",
  wide: "aspect-[4/3]",
  banner: "aspect-[20/9]",
};

/**
 * The one frame every library card uses. `preview` is dropped into a fixed
 * aspect box so a grid of cards lines up whatever each tab is showing.
 *
 * `dragStart` only ARMS a drag (see `lib/mediaDrag`); a press that never moves
 * is still a click, so the card keeps its "add at the playhead" behaviour.
 * Deliberately no `touch-action: none` — that would cost the panel its
 * momentum scrolling on touch, and a cancelled pointer ends the drag anyway.
 */
export function LibraryCard({
  label,
  hint,
  preview,
  onClick,
  dragStart,
  active = false,
  disabled = false,
  aspect = "video",
  badge,
  actionIcon,
  onAction,
  actionTitle,
}: {
  label: string;
  hint?: string;
  preview?: ReactNode;
  onClick?: () => void;
  dragStart?: (event: React.PointerEvent) => void;
  active?: boolean;
  disabled?: boolean;
  aspect?: CardAspect;
  badge?: ReactNode;
  actionIcon?: ReactNode;
  onAction?: () => void;
  actionTitle?: string;
}) {
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-[9px] border bg-[#1c1d1f] transition",
        active ? "border-[#e6e6e5]" : "border-[#2d2e31] hover:border-[#77797d]",
        disabled && "opacity-40",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        onPointerDown={dragStart}
        disabled={disabled || !onClick}
        title={hint}
        className={cn("block w-full text-left disabled:cursor-default", dragStart && "cursor-grab")}
      >
        <div className={cn("relative w-full overflow-hidden bg-km-track", ASPECT[aspect])}>{preview}</div>
        <div className="px-1.5 py-1">
          <div className="truncate text-[11px] leading-tight text-km-text">{label}</div>
          {hint ? <div className="truncate text-[9.5px] leading-tight text-km-faint">{hint}</div> : null}
        </div>
      </button>

      {badge ? <div className="pointer-events-none absolute left-1 top-1">{badge}</div> : null}

      {onAction ? (
        <div className="absolute right-1 top-1 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            title={actionTitle}
            onClick={(e) => {
              e.stopPropagation();
              onAction();
            }}
            className="grid h-5 w-5 place-items-center rounded bg-black/65 text-white/80 backdrop-blur transition hover:bg-km-text hover:text-km-bg"
          >
            {actionIcon}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Small corner tag used by media cards and stock results. */
export function CardTag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded bg-black/70 px-1 py-0.5 text-[9px] uppercase tracking-wide text-white/85 backdrop-blur">
      {children}
    </span>
  );
}
