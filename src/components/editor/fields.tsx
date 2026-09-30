/**
 * Form primitives for the inspector.
 *
 * All of them share one behaviour: continuous controls (sliders, colours) push a
 * single history entry per gesture, so a drag is one undo step rather than a
 * hundred. `useHistoryGesture` is what makes that happen.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
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

  return (
    <Row label={label}>
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
            if (Number.isFinite(next)) onChange(next);
          }}
          onBlur={() => {
            const text = (draft ?? "").trim();
            const next = Number(text);
            if (text !== "" && Number.isFinite(next)) onCommit?.(next);
            else onCommit?.(value);
            setDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          }}
          className={cn(inputClass, suffix && "pr-7")}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-km-faint">
            {suffix}
          </span>
        )}
      </div>
    </Row>
  );
}

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
}) {
  const gesture = useHistoryGesture();

  return (
    <div className={cn(disabled && "opacity-45")}>
      <div className="mb-1 flex items-baseline justify-between">
        {label && <span className="text-[11px] text-km-dim">{label}</span>}
        <span className="font-mono text-[10.5px] text-km-faint">
          {format ? format(value) : Math.round(value * 100) / 100}
        </span>
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

  return (
    <Row label={label}>
      <div className="flex items-center gap-2">
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
          className="h-7 w-9 cursor-pointer rounded border border-km-border bg-km-track p-0.5"
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
          className={cn(inputClass, "flex-1 font-mono text-[11px]")}
        />
        {allowClear && (
          <button
            type="button"
            title="Clear"
            onClick={() => {
              onChange("transparent");
              onCommit?.("transparent");
            }}
            className="h-7 rounded border border-km-border px-2 text-[10px] text-km-dim transition hover:bg-km-raised hover:text-km-text"
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
}: {
  label?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <Row label={label}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-7 w-full rounded border border-km-border bg-km-track px-2 text-[12px] text-km-text outline-none focus:ring-1 focus:ring-km-accent"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-km-panel2">
            {o.label}
          </option>
        ))}
      </select>
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
              value === o.value ? "bg-km-accent text-white" : "bg-km-track text-km-dim hover:bg-km-raised hover:text-km-text",
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
