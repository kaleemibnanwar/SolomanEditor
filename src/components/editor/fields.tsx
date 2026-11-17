/**
 * Form primitives for the inspector.
 *
 * All of them share one behaviour: continuous controls (sliders, colours) push a
 * single history entry per gesture, so a drag is one undo step rather than a
 * hundred. `useHistoryGesture` is what makes that happen.
 *
 * The input methods follow the editor conventions:
 *   · number labels are SCRUBBABLE — drag them sideways to adjust, Shift for
 *     fine steps, and the field itself takes typed values and arrow keys;
 *   · slider readouts are clickable — type an exact value, or double-click to
 *     snap back to the control's default;
 *   · colour fields carry a swatch palette beside the picker and hex input;
 *   · selects are styled popovers, not native dropdowns, so long lists (fonts,
 *     blend modes, effect kinds) stay readable in the dark panel.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Palette } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { editor } from "@/store/editorStore";

/** Groups a run of live edits into one undo step. */
export function useHistoryGesture(timeoutMs = 650) {
  const timer = useRef<number | null>(null);
  const active = useRef(false);

  const begin = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (!active.current) {
      active.current = true;
      editor().pushHistory();
    }
  };

  const end = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      active.current = false;
      timer.current = null;
    }, timeoutMs);
  };

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return { begin, end };
}

export function Section({
  title,
  children,
  action,
  className,
}: {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border-b border-km-border/70 px-3 py-3", className)}>
      {title && (
        <div className="mb-2.5 flex items-center justify-between">
          <h4 className="text-[10px] font-semibold uppercase tracking-wider text-km-faint">{title}</h4>
          {action}
        </div>
      )}
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

export function Row({ label, children, hint }: { label?: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      {label && (
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-[11px] text-km-dim">{label}</span>
          {hint && <span className="text-[10px] text-km-faint">{hint}</span>}
        </div>
      )}
      {children}
    </label>
  );
}

const inputClass =
  "h-7 rounded border-km-border bg-km-track px-2 text-[12px] text-km-text placeholder:text-km-faint focus-visible:ring-1 focus-visible:ring-km-accent";

const clampTo = (value: number, min?: number, max?: number) =>
  Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value));

/**
 * A number field with three input methods: type it, arrow-key it, or SCRUB the
 * label sideways. The scrub accumulates from the value at pointer-down (not
 * from the rendered one, which lags a frame behind), and Shift drops to tenth
 * steps for precision work.
 */
export function NumberField({
  label,
  value,
  onChange,
  onCommit,
  min,
  max,
  step = 1,
  suffix,
  disabled,
}: {
  label?: string;
  value: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
}) {
  // Keep the raw text while typing so partial input ("-", "0.", "") isn't
  // reverted by the controlled value; commit on blur/Enter. `type="text"` +
  // `inputMode="decimal"` (rather than `type="number"`) because a number input
  // cannot hold a leading "-" or a trailing ".", which made negatives untypeable.
  const [draft, setDraft] = useState<string | null>(null);
  const display = draft ?? (Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : "0");

  const gesture = useHistoryGesture();
  const scrub = useRef<{ pointerId: number; lastX: number; current: number } | null>(null);

  const scrubStart = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    scrub.current = { pointerId: e.pointerId, lastX: e.clientX, current: value };
    gesture.begin();
  };

  const scrubMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    const state = scrub.current;
    if (!state || state.pointerId !== e.pointerId) return;
    const dx = e.clientX - state.lastX;
    state.lastX = e.clientX;
    state.current = clampTo(state.current + dx * step * (e.shiftKey ? 0.1 : 1), min, max);
    onChange(Math.round(state.current * 1000) / 1000);
  };

  const scrubEnd = (e: React.PointerEvent<HTMLSpanElement>) => {
    const state = scrub.current;
    if (!state || state.pointerId !== e.pointerId) return;
    scrub.current = null;
    gesture.end();
    onCommit?.(state.current);
  };

  const nudge = (direction: 1 | -1, coarse: boolean) => {
    const next = clampTo(value + direction * step * (coarse ? 10 : 1), min, max);
    const rounded = Math.round(next * 1000) / 1000;
    setDraft(null);
    onChange(rounded);
    onCommit?.(rounded);
  };

  return (
    <div className={cn("block", disabled && "opacity-45")}>
      {label && (
        <div className="mb-1 flex items-baseline justify-between">
          <span
            title="Drag sideways to adjust · Shift for fine steps"
            onPointerDown={scrubStart}
            onPointerMove={scrubMove}
            onPointerUp={scrubEnd}
            onPointerCancel={scrubEnd}
            className={cn(
              "select-none text-[11px] text-km-dim",
              !disabled && "cursor-ew-resize decoration-km-faint/60 decoration-dotted underline-offset-2 hover:underline",
            )}
          >
            {label}
          </span>
        </div>
      )}
      <div className="relative">
        <Input
          type="text"
          inputMode="decimal"
          value={display}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            const text = e.target.value.trim();
            if (text === "") return;
            const next = Number(text);
            if (Number.isFinite(next)) onChange(clampTo(next, min, max));
          }}
          onBlur={() => {
            const text = (draft ?? "").trim();
            const next = Number(text);
            if (text !== "" && Number.isFinite(next)) onCommit?.(clampTo(next, min, max));
            else onCommit?.(value);
            setDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
            else if (e.key === "ArrowUp") {
              e.preventDefault();
              nudge(1, e.shiftKey);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              nudge(-1, e.shiftKey);
            }
          }}
          className={cn(inputClass, suffix && "pr-7")}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-km-faint">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A slider whose readout is also an input: click the number to type an exact
 * value, double-click it to snap back to `resetValue` (when given). The drag
 * itself stays one undo step via the shared gesture.
 */
export function SliderField({
  label,
  value,
  min,
  max,
  step = 0.01,
  onChange,
  onCommit,
  format,
  disabled,
  resetValue,
}: {
  label?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  format?: (value: number) => string;
  disabled?: boolean;
  /** Double-clicking the readout snaps back to this value. */
  resetValue?: number;
}) {
  const gesture = useHistoryGesture();
  const [draft, setDraft] = useState<string | null>(null);

  const commitDraft = () => {
    if (draft === null) return;
    const next = Number(draft.trim());
    if (draft.trim() !== "" && Number.isFinite(next)) {
      const clamped = clampTo(next, min, max);
      onChange(clamped);
      onCommit?.(clamped);
    }
    setDraft(null);
  };

  const reset = () => {
    if (resetValue === undefined || disabled) return;
    setDraft(null);
    onChange(resetValue);
    onCommit?.(resetValue);
  };

  return (
    <div className={cn(disabled && "opacity-45")}>
      <div className="mb-1 flex items-baseline justify-between">
        {label && <span className="text-[11px] text-km-dim">{label}</span>}
        {draft !== null ? (
          <input
            autoFocus
            value={draft}
            inputMode="decimal"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitDraft();
              if (e.key === "Escape") setDraft(null);
            }}
            className="h-5 w-16 rounded border border-km-accent bg-km-track px-1 text-right font-mono text-[10.5px] text-km-text outline-none"
          />
        ) : (
          <button
            type="button"
            disabled={disabled}
            title={resetValue !== undefined ? "Click to type a value · double-click to reset" : "Click to type a value"}
            onClick={() => setDraft(String(Math.round(value * 1000) / 1000))}
            onDoubleClick={reset}
            className="rounded px-1 font-mono text-[10.5px] text-km-faint transition hover:bg-km-raised hover:text-km-text"
          >
            {format ? format(value) : Math.round(value * 100) / 100}
          </button>
        )}
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onValueChange={([next]) => {
          gesture.begin();
          onChange(next);
        }}
        onValueCommit={([next]) => {
          gesture.end();
          onCommit?.(next);
        }}
        className="py-1"
      />
    </div>
  );
}

/** The palette every colour field offers beside its picker — the editor's own vocabulary. */
const SWATCHES = [
  "#ffffff", "#0b0b14", "#94a3b8", "#facc15", "#f97316", "#ef4444",
  "#ec4899", "#a855f7", "#6366f1", "#3b82f6", "#22d3ee", "#22c55e",
];

export function ColorField({
  label,
  value,
  onChange,
  onCommit,
  allowClear,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
  allowClear?: boolean;
}) {
  const gesture = useHistoryGesture(400);
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff";
  const [paletteOpen, setPaletteOpen] = useState(false);

  const pick = (color: string) => {
    onChange(color);
    onCommit?.(color);
    setPaletteOpen(false);
  };

  return (
    <Row label={label}>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={hex}
          onChange={(e) => {
            gesture.begin();
            onChange(e.target.value);
          }}
          onBlur={(e) => {
            gesture.end();
            onCommit?.(e.target.value);
          }}
          className="h-7 w-9 shrink-0 cursor-pointer rounded border border-km-border bg-km-track p-0.5"
        />
        <Input
          value={value}
          onChange={(e) => {
            gesture.begin();
            onChange(e.target.value);
          }}
          onBlur={(e) => {
            gesture.end();
            onCommit?.(e.target.value);
          }}
          className={cn(inputClass, "min-w-0 flex-1 font-mono text-[11px]")}
        />
        <Popover open={paletteOpen} onOpenChange={setPaletteOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              title="Pick from the palette"
              className="grid h-7 w-7 shrink-0 place-items-center rounded border border-km-border text-km-faint transition hover:bg-km-raised hover:text-km-text"
            >
              <Palette className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[196px] border-km-border bg-km-panel p-2">
            <div className="grid grid-cols-6 gap-1.5">
              {SWATCHES.map((color) => (
                <button
                  key={color}
                  type="button"
                  title={color}
                  onClick={() => pick(color)}
                  className={cn(
                    "h-6 w-6 rounded border transition hover:scale-110",
                    value.toLowerCase() === color ? "border-km-accent ring-1 ring-km-accent" : "border-km-border",
                  )}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
            {allowClear && (
              <button
                type="button"
                onClick={() => pick("transparent")}
                className="mt-2 w-full rounded border border-km-border px-2 py-1 text-[10.5px] text-km-dim transition hover:bg-km-raised hover:text-km-text"
              >
                Clear (transparent)
              </button>
            )}
          </PopoverContent>
        </Popover>
        {allowClear && (
          <button
            type="button"
            title="Clear"
            onClick={() => {
              onChange("transparent");
              onCommit?.("transparent");
            }}
            className="h-7 shrink-0 rounded border border-km-border px-2 text-[10px] text-km-dim transition hover:bg-km-raised hover:text-km-text"
          >
            Clear
          </button>
        )}
      </div>
    </Row>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  optionStyle,
}: {
  label?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  /** Per-option styling — e.g. rendering each font in its own face. */
  optionStyle?: (value: T) => CSSProperties | undefined;
}) {
  const selected = options.find((o) => o.value === value);

  return (
    <Row label={label}>
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger
          className="h-7 w-full rounded border-km-border bg-km-track px-2 text-[12px] text-km-text focus:ring-1 focus:ring-km-accent [&>svg]:h-3.5 [&>svg]:w-3.5 [&>svg]:text-km-faint"
          style={optionStyle?.(value)}
        >
          <SelectValue>{selected?.label ?? value}</SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-64 border-km-border bg-km-panel2 text-km-text">
          {options.map((o) => (
            <SelectItem
              key={o.value}
              value={o.value}
              style={optionStyle?.(o.value)}
              className="text-[12px] text-km-dim focus:bg-km-raised focus:text-km-text"
            >
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  );
}

export function SegmentedField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <Row label={label}>
      <div className="flex overflow-hidden rounded border border-km-border">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex h-7 flex-1 items-center justify-center text-[11px] transition",
              value === o.value ? "bg-km-accent text-km-bg" : "bg-km-track text-km-dim hover:bg-km-raised hover:text-km-text",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </Row>
  );
}

export function ToggleField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="flex w-full items-center justify-between rounded px-0.5 py-1 text-left transition hover:bg-white/[0.03]"
    >
      <span>
        <span className="block text-[11px] text-km-text">{label}</span>
        {hint && <span className="block text-[10px] text-km-faint">{hint}</span>}
      </span>
      <span
        className={cn("relative shrink-0 rounded-full transition", value ? "bg-km-accent" : "bg-km-raised")}
        style={{ height: 18, width: 32 }}
      >
        <span
          className="absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all"
          style={{ left: value ? 16 : 3 }}
        />
      </span>
    </button>
  );
}

export function SmallButton({
  children,
  onClick,
  disabled,
  title,
  tone = "default",
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  tone?: "default" | "accent" | "danger";
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center justify-center gap-1.5 rounded px-2 text-[11px] transition",
        tone === "accent" && "bg-km-accent/15 text-km-accent hover:bg-km-accent/25",
        tone === "danger" && "bg-red-500/10 text-red-300 hover:bg-red-500/20",
        tone === "default" && "border border-km-border text-km-dim hover:bg-km-raised hover:text-km-text",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
      )}
    >
      {children}
    </button>
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="px-3 py-6 text-center text-[11px] leading-relaxed text-km-faint">{children}</p>;
}
