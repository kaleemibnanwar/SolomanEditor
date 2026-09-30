/**
 * RIGHT DOCK — the inspector.
 *
 * On the canvas you place things by hand; this panel is the precise complement:
 * exact numbers, filters, text styling, transitions, sound, effects and
 * keyframe authoring.
 *
 * Every continuous control folds into ONE undo step per gesture
 * (`useHistoryGesture`), so dragging a slider is a single Ctrl+Z rather than
 * ninety of them. Continuous edits therefore write with `record = false` and
 * let the gesture own the history entry.
 */
import { useMemo, useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Diamond,
  Eye,
  EyeOff,
  Link2,
  Lock,
  RotateCcw,
  Trash2,
  Unlink,
  Unlock,
  X,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { PreviewImage } from "@/components/editor/library/PreviewImage";
import { ChipRow, EmptyState, SearchField } from "@/components/editor/library/pieces";
import {
  ColorField,
  EmptyHint,
  NumberField,
  Row,
  Section,
  SegmentedField,
  SelectField,
  SliderField,
  SmallButton,
  ToggleField,
  useHistoryGesture,
} from "@/components/editor/fields";
import { layerEnd, staticPropValue } from "@/lib/anim";
import {
  DEFAULT_BOND,
  MIN_BOND_OVERLAP,
  bondHoldsLastFrame,
  junctionIndex,
  junctionsOnTrack,
  maxBondDuration,
  type Junction,
} from "@/lib/bonds";
import { evaluatedBox } from "@/lib/geometry";
import { FILTER_LOOKS, lookMatches } from "@/lib/library";
import { LAYER_COLORS, LAYER_LABELS } from "@/lib/project";
import { transitionPreviewDataUrl } from "@/lib/preview";
import { clamp, formatTimecode } from "@/lib/time";
import {
  TRANSITION_CATEGORIES,
  TRANSITION_DEFS,
  isShaderTransition,
  transitionDef,
  type TransitionCategory,
} from "@/lib/transitions";
import { cn } from "@/lib/utils";
import { editor, useEditor, useSelection } from "@/store/editorStore";
import type {
  AnimatableProp,
  BlendMode,
  Easing,
  EditorState,
  EffectStyle,
  Keyframe,
  Layer,
  LayerFilters,
  StickerStyle,
  TextStyle,
  Transition,
  TransitionDirection,
  TransitionType,
} from "@/types/editor";

type InspectorTab = EditorState["ui"]["inspectorTab"];
type TransformPatch = Partial<Layer["transform"]>;

export default function Inspector() {
  const selectedIds = useSelection();
  const project = useEditor((s) => s.project);

  const layers = useMemo(
    () => selectedIds.map((id) => project.layers[id]).filter((l): l is Layer => !!l),
    [selectedIds, project],
  );

  return (
    <aside className="flex w-[288px] shrink-0 flex-col border-l border-km-border bg-km-panel">
      {layers.length === 0 && (
        <div className="flex min-h-0 flex-1 flex-col">
          <PanelTitle title="Properties" hint="nothing selected" />
          <EmptyHint>
            Select a layer to edit its transform, filters, timing and sound.
            <br />
            <br />
            Shift-click or drag a box on the canvas to select several layers at once — the canvas is the fastest way to
            position things, this panel is for exact values.
          </EmptyHint>
        </div>
      )}

      {layers.length === 1 && <SingleLayer layer={layers[0]} />}
      {layers.length > 1 && <MultiPanel layers={layers} />}
    </aside>
  );
}

/* ------------------------------------------------------------------ *
 * Single layer
 * ------------------------------------------------------------------ */

const TAB_META: { value: InspectorTab; label: string; show: (layer: Layer) => boolean }[] = [
  { value: "transform", label: "Transform", show: () => true },
  { value: "filters", label: "Filters", show: (l) => l.type !== "audio" },
  { value: "text", label: "Text", show: (l) => l.type === "text" },
  { value: "sticker", label: "Shape", show: (l) => l.type === "sticker" },
  { value: "transition", label: "Transition", show: () => true },
  { value: "audio", label: "Sound", show: (l) => l.type === "audio" || l.type === "video" },
  { value: "effect", label: "Effect", show: (l) => l.type === "effect" },
  { value: "keyframes", label: "Keys", show: () => true },
];

function SingleLayer({ layer }: { layer: Layer }) {
  const tab = useEditor((s) => s.ui.inspectorTab);
  const tabs = useMemo(() => TAB_META.filter((t) => t.show(layer)), [layer]);
  const active = tabs.some((t) => t.value === tab) ? tab : "transform";

  return (
    <>
      <LayerHeader layer={layer} />

      <div className="grid shrink-0 grid-cols-4 gap-1 border-b border-km-border p-2">
        {tabs.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => editor().setUi({ inspectorTab: t.value })}
            className={cn(
              "truncate rounded px-1 py-1 text-[10.5px] transition",
              active === t.value
                ? "bg-km-accent text-white"
                : "bg-km-panel2 text-km-dim hover:bg-km-raised hover:text-km-text",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="km-scroll min-h-0 flex-1 overflow-y-auto">
        {active === "transform" && <TransformPanel layer={layer} />}
        {active === "filters" && <FiltersPanel layer={layer} />}
        {active === "text" && <TextPanel layer={layer} />}
        {active === "sticker" && <StickerPanel layer={layer} />}
        {active === "transition" && <TransitionPanel layer={layer} />}
        {active === "audio" && <AudioPanel layer={layer} />}
        {active === "effect" && <EffectPanel layer={layer} />}
        {active === "keyframes" && <KeyframesPanel layer={layer} />}
      </div>
    </>
  );
}

function LayerHeader({ layer }: { layer: Layer }) {
  const gesture = useHistoryGesture(900);
  const media = layer.type === "video" || layer.type === "image" || layer.type === "audio";

  return (
    <div className="shrink-0 border-b border-km-border px-3 pb-2.5 pt-2.5">
      <div className="flex items-center gap-2">
        <span className="h-7 w-1 shrink-0 rounded-full" style={{ backgroundColor: LAYER_COLORS[layer.type] }} />
        <div className="min-w-0 flex-1">
          <Input
            value={layer.name}
            aria-label="Layer name"
            onChange={(e) => {
              gesture.begin();
              editor().updateLayer(layer.id, { name: e.target.value }, false);
            }}
            onBlur={() => gesture.end()}
            className="h-6 border-transparent bg-transparent px-1 text-[12.5px] font-medium text-km-text hover:border-km-border focus-visible:border-km-border focus-visible:ring-0"
          />
          <div className="px-1 text-[9.5px] uppercase tracking-wider text-km-faint">
            {LAYER_LABELS[layer.type]}
            {media ? " layer" : ""}
          </div>
        </div>
        <IconButton
          title={layer.hidden ? "Show" : "Hide"}
          active={layer.hidden}
          onClick={() => editor().toggleHidden(layer.id)}
        >
          {layer.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </IconButton>
        <IconButton
          title={layer.locked ? "Unlock" : "Lock"}
          active={layer.locked}
          onClick={() => editor().toggleLocked(layer.id)}
        >
          {layer.locked ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
        </IconButton>
      </div>

      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
        <SmallButton title="Duplicate (Ctrl+D)" onClick={() => editor().duplicateLayers([layer.id])}>
          <Copy className="h-3 w-3" /> Duplicate
        </SmallButton>
        <SmallButton title="Copy (Ctrl+C)" onClick={() => editor().copyLayers([layer.id])}>
          <ClipboardCopy className="h-3 w-3" /> Copy
        </SmallButton>
        <SmallButton title="Paste (Ctrl+V)" onClick={() => editor().pasteLayers()}>
          <ClipboardPaste className="h-3 w-3" /> Paste
        </SmallButton>
        <SmallButton tone="danger" title="Delete (Del)" onClick={() => editor().removeLayers([layer.id])}>
          <Trash2 className="h-3 w-3" /> Delete
        </SmallButton>
        <span className="ml-auto font-mono text-[10px] text-km-faint">{formatTimecode(layerEnd(layer))}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Transform + timing
 * ------------------------------------------------------------------ */

function TransformPanel({ layer }: { layer: Layer }) {
  const settings = useEditor((s) => s.project.settings);
  const assets = useEditor((s) => s.assets);
  const currentTime = useEditor((s) => s.currentTime);
  const gesture = useHistoryGesture();

  const asset = layer.assetId ? assets[layer.assetId] : undefined;
  const hasSource = layer.type === "video" || layer.type === "audio";

  /** Number inputs commit live but only bank one history entry per run of edits. */
  const num = (apply: (v: number) => void) => ({
    onChange: (v: number) => {
      gesture.begin();
      apply(v);
    },
    onCommit: () => gesture.end(),
  });

  const setT = (patch: TransformPatch, record = false) => editor().updateLayerTransform(layer.id, patch, record);

  // Evaluated at the playhead (clamped into the layer) so Fit/Fill account for
  // the layer's real on-canvas size rather than just its source dimensions.
  const box = useMemo(() => {
    const time = clamp(currentTime, layer.startTime, Math.max(layer.startTime, layerEnd(layer) - 1e-3));
    return evaluatedBox(layer, assets, settings, time);
  }, [layer, assets, settings, currentTime]);

  const scaleAnimated = layer.keyframes.some((k) => k.prop === "scale");
  const posAnimated = layer.keyframes.some((k) => k.prop === "x" || k.prop === "y");

  const applyFit = (mode: "contain" | "cover") => {
    if (!box || box.scale <= 0) return;
    const baseW = box.w / box.scale;
    const baseH = box.h / box.scale;
    if (!baseW || !baseH) return;
    const factor =
      mode === "contain"
        ? Math.min(settings.width / baseW, settings.height / baseH)
        : Math.max(settings.width / baseW, settings.height / baseH);
    const patch: TransformPatch = {};
    if (!scaleAnimated) patch.scale = factor;
    if (!posAnimated) {
      patch.x = settings.width / 2;
      patch.y = settings.height / 2;
    }
    if (Object.keys(patch).length) setT(patch, true);
  };

  const fitDisabled = scaleAnimated && posAnimated;

  return (
    <>
      <Section title="Position">
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="X"
            value={layer.transform.x}
            step={1}
            suffix="px"
            {...num((v) => setT({ x: v }))}
          />
          <NumberField
            label="Y"
            value={layer.transform.y}
            step={1}
            suffix="px"
            {...num((v) => setT({ y: v }))}
          />
        </div>
        <div className="flex gap-1.5">
          <SmallButton
            title={fitDisabled ? "Scale and position are animated" : "Fit the layer inside the canvas"}
            disabled={fitDisabled}
            onClick={() => applyFit("contain")}
          >
            Fit
          </SmallButton>
          <SmallButton
            title={fitDisabled ? "Scale and position are animated" : "Fill the canvas with the layer"}
            disabled={fitDisabled}
            onClick={() => applyFit("cover")}
          >
            Fill
          </SmallButton>
          <SmallButton title="Reset size and rotation" onClick={() => setT({ scale: 1, rotation: 0 }, true)}>
            <RotateCcw className="h-3 w-3" /> Reset
          </SmallButton>
        </div>
      </Section>

      <Section title="Size &amp; rotation">
        <SliderField
          label="Scale"
          value={layer.transform.scale}
          min={0.02}
          max={8}
          step={0.01}
          format={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => setT({ scale: v })}
        />
        <SliderField
          label="Rotation"
          value={layer.transform.rotation}
          min={-180}
          max={180}
          step={1}
          format={(v) => `${Math.round(v)}°`}
          onChange={(v) => setT({ rotation: v })}
        />
        <div className="grid grid-cols-3 gap-2">
          <NumberField
            label="Scale"
            value={layer.transform.scale}
            min={0.02}
            max={8}
            step={0.01}
            {...num((v) => setT({ scale: clamp(v, 0.02, 8) }))}
          />
          <NumberField
            label="Stretch X"
            value={layer.transform.scaleX ?? 1}
            min={0.01}
            max={10}
            step={0.01}
            {...num((v) => setT({ scaleX: Math.max(0.01, v) }))}
          />
          <NumberField
            label="Stretch Y"
            value={layer.transform.scaleY ?? 1}
            min={0.01}
            max={10}
            step={0.01}
            {...num((v) => setT({ scaleY: Math.max(0.01, v) }))}
          />
        </div>
        <div className="mt-2">
          <NumberField
            label="Rotation value"
            value={layer.transform.rotation}
            step={1}
            suffix="°"
            {...num((v) => setT({ rotation: v }))}
          />
        </div>
      </Section>

      <Section title="Opacity">
        <SliderField
          label="Opacity"
          value={layer.opacity}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => editor().updateLayer(layer.id, { opacity: v }, false)}
        />
        {layer.keyframes.some((k) => k.prop === "opacity") && (
          <p className="text-[10px] text-km-faint">
            Opacity is keyframed — the slider sets the base value, keyframes override it.
          </p>
        )}
      </Section>

      <Section title="Timing">
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Start"
            value={layer.startTime}
            min={0}
            step={0.05}
            suffix="s"
            {...num((v) => editor().setLayerStart(layer.id, v, false))}
          />
          <NumberField
            label="Duration"
            value={layer.duration}
            min={0.08}
            step={0.05}
            suffix="s"
            {...num((v) => editor().trimEnd(layer.id, layer.startTime + v, false))}
          />
        </div>

        {hasSource && (
          <NumberField
            label={`Source in-point${asset?.duration ? ` · ${asset.duration.toFixed(1)}s long` : ""}`}
            value={layer.inPoint}
            min={0}
            step={0.05}
            suffix="s"
            {...num((v) =>
              editor().updateLayer(
                layer.id,
                { inPoint: clamp(v, 0, Math.max(0, (asset?.duration ?? v) - 0.05)) },
                false,
              ),
            )}
          />
        )}

        <div className="flex gap-1.5">
          <SmallButton
            title="Move the clip start to the playhead"
            onClick={() => editor().setLayerStart(layer.id, Math.max(0, currentTime))}
          >
            Start at playhead
          </SmallButton>
          <SmallButton
            title="Trim the clip end to the playhead"
            onClick={() => editor().trimEnd(layer.id, Math.max(layer.startTime + 0.08, currentTime))}
          >
            End at playhead
          </SmallButton>
        </div>

        <div className="flex items-center justify-between text-[10px] text-km-faint">
          <span>
            {formatTimecode(layer.startTime)} → {formatTimecode(layerEnd(layer))}
          </span>
          <span>{`${layer.duration.toFixed(2)}s visible`}</span>
        </div>
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

function FiltersPanel({ layer }: { layer: Layer }) {
  const f = layer.filters;
  const set = (patch: Partial<LayerFilters>) => editor().updateLayerFilters(layer.id, patch, false);
  // A look carries both the canvas filter chain and the grade, so the selected
  // state has to compare both — a half-applied look must not read as active.
  const active = FILTER_LOOKS.find((look) => lookMatches(look, layer.filters, layer.grade))?.id;

  return (
    <>
      <Section
        title="Looks"
        action={
          <SmallButton title="Back to neutral" onClick={() => editor().resetFilters(layer.id)}>
            <RotateCcw className="h-3 w-3" /> Reset
          </SmallButton>
        }
      >
        <div className="grid grid-cols-2 gap-1.5">
          {FILTER_LOOKS.map((look) => (
            <button
              key={look.id}
              type="button"
              title={look.hint}
              onClick={() => editor().applyFilterLook(look.id)}
              className={cn(
                "truncate rounded border px-2 py-1.5 text-[11px] transition",
                active === look.id
                  ? "border-km-accent bg-km-accent/15 text-km-accent"
                  : "border-km-border bg-km-track text-km-dim hover:bg-km-raised hover:text-km-text",
              )}
            >
              {look.name}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Light">
        <SliderField
          label="Brightness"
          value={f.brightness}
          min={0}
          max={2}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => set({ brightness: v })}
        />
        <SliderField
          label="Contrast"
          value={f.contrast}
          min={0}
          max={2}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => set({ contrast: v })}
        />
        <SliderField
          label="Saturation"
          value={f.saturate}
          min={0}
          max={2}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => set({ saturate: v })}
        />
        <SliderField
          label="Hue shift"
          value={f.hueRotate}
          min={-180}
          max={180}
          step={1}
          format={(v) => `${Math.round(v)}°`}
          onChange={(v) => set({ hueRotate: v })}
        />
      </Section>

      <Section title="Texture">
        <SliderField
          label="Blur"
          value={f.blur}
          min={0}
          max={40}
          step={0.5}
          format={(v) => `${v.toFixed(1)}px`}
          onChange={(v) => set({ blur: v })}
        />
        <SliderField
          label="Grayscale"
          value={f.grayscale}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => set({ grayscale: v })}
        />
        <SliderField
          label="Sepia"
          value={f.sepia}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => set({ sepia: v })}
        />
      </Section>

      <Section className="border-b-0">
        <p className="text-[10.5px] leading-relaxed text-km-faint">
          Filters are baked into the preview and into the exported frames through the same canvas filter chain.
        </p>
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

const FONTS = [
  { value: "Inter, system-ui, sans-serif", label: "Inter (default)" },
  { value: "Georgia, 'Times New Roman', serif", label: "Georgia serif" },
  { value: "ui-monospace, 'SF Mono', Menlo, monospace", label: "Monospace" },
  { value: "Impact, 'Arial Black', sans-serif", label: "Impact" },
  { value: "'Trebuchet MS', sans-serif", label: "Trebuchet" },
  { value: "Verdana, sans-serif", label: "Verdana" },
];

function StickerPanel({ layer }: { layer: Layer }) {
  const sticker = layer.sticker;

  if (!sticker) {
    return <EmptyHint>This layer is not a shape.</EmptyHint>;
  }

  const setSticker = (patch: Partial<StickerStyle>, record = false) =>
    editor().updateLayer(layer.id, { sticker: { ...sticker, ...patch } }, record);

  return (
    <>
      <Section title="Appearance">
        <ColorField label="Fill color" value={sticker.fill} onChange={(v) => setSticker({ fill: v })} />
        <ColorField label="Stroke color" value={sticker.stroke} onChange={(v) => setSticker({ stroke: v })} />
        <SliderField
          label="Stroke width"
          value={sticker.strokeWidth}
          min={0}
          max={40}
          step={1}
          format={(v) => `${Math.round(v)}px`}
          onChange={(v) => setSticker({ strokeWidth: v })}
        />
        <SliderField
          label="Inner depth"
          value={sticker.depth}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setSticker({ depth: v })}
        />
      </Section>
    </>
  );
}

function TextPanel({ layer }: { layer: Layer }) {
  const gesture = useHistoryGesture(800);
  const text = layer.text;

  if (!text) {
    return <EmptyHint>This layer has no text. Select a text layer to style its type.</EmptyHint>;
  }

  const setText = (patch: Partial<TextStyle>, record = false) =>
    editor().updateLayer(layer.id, { text: { ...text, ...patch } }, record);

  return (
    <>
      <Section title="Content">
        <Textarea
          value={text.content}
          rows={3}
          placeholder="Type your caption…"
          onChange={(e) => {
            gesture.begin();
            setText({ content: e.target.value });
          }}
          onBlur={() => gesture.end()}
          className="min-h-[64px] resize-y border-km-border bg-km-track text-[12px] leading-snug text-km-text focus-visible:ring-1 focus-visible:ring-km-accent"
        />
      </Section>

      <Section title="Type">
        <SelectField 
          label="Animation" 
          value={text.animation || "none"} 
          options={[
            { value: "none", label: "None" },
            { value: "typing", label: "Typing" },
            { value: "marquee", label: "Marquee" },
            { value: "slideUp", label: "Slide Up" },
          ]} 
          onChange={(v) => setText({ animation: v as "none" | "typing" | "marquee" | "slideUp" }, true)} 
        />
        <SelectField label="Font" value={text.fontFamily} options={FONTS} onChange={(v) => setText({ fontFamily: v }, true)} />
        <SliderField
          label="Size"
          value={text.fontSize}
          min={8}
          max={400}
          step={1}
          format={(v) => `${Math.round(v)}px`}
          onChange={(v) => setText({ fontSize: v })}
        />
        <SegmentedField
          label="Weight"
          value={String(text.fontWeight)}
          options={[
            { value: "400", label: "Reg" },
            { value: "600", label: "Semi" },
            { value: "800", label: "Bold" },
            { value: "900", label: "Black" },
          ]}
          onChange={(v) => setText({ fontWeight: Number(v) }, true)}
        />
        <SegmentedField<"left" | "center" | "right">
          label="Align"
          value={text.align}
          options={[
            { value: "left", label: "Left" },
            { value: "center", label: "Center" },
            { value: "right", label: "Right" },
          ]}
          onChange={(v) => setText({ align: v }, true)}
        />
        <SliderField
          label="Line height"
          value={text.lineHeight}
          min={0.8}
          max={2}
          step={0.01}
          format={(v) => v.toFixed(2)}
          onChange={(v) => setText({ lineHeight: v })}
        />
        <SliderField
          label="Letter spacing"
          value={text.letterSpacing}
          min={-10}
          max={40}
          step={0.5}
          format={(v) => `${v.toFixed(1)}px`}
          onChange={(v) => setText({ letterSpacing: v })}
        />
      </Section>

      <Section title="Colour">
        <ColorField label="Fill" value={text.color} onChange={(v) => setText({ color: v })} />
        <ColorField
          label="Plate"
          value={text.backgroundColor}
          allowClear
          onChange={(v) => setText({ backgroundColor: v })}
        />
        <SliderField
          label="Plate radius"
          value={text.backgroundRadius}
          min={0}
          max={120}
          step={1}
          format={(v) => `${Math.round(v)}px`}
          onChange={(v) => setText({ backgroundRadius: v })}
        />
      </Section>

      <Section title="Outline &amp; shadow">
        <ColorField label="Stroke" value={text.strokeColor} onChange={(v) => setText({ strokeColor: v })} />
        <SliderField
          label="Stroke width"
          value={text.strokeWidth}
          min={0}
          max={24}
          step={0.5}
          format={(v) => `${v.toFixed(1)}px`}
          onChange={(v) => setText({ strokeWidth: v })}
        />
        <ToggleField
          label="Drop shadow"
          hint="keeps text readable over busy footage"
          value={text.shadow}
          onChange={(v) => setText({ shadow: v }, true)}
        />
      </Section>

      <Section className="border-b-0">
        <p className="text-[10.5px] leading-relaxed text-km-faint">
          Text wraps to 92% of the canvas width. Drag it on the canvas to reposition, or use Transform for exact values.
        </p>
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Transitions
 * ------------------------------------------------------------------ */

const DIRECTIONS: { value: TransitionDirection; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "up", label: "Up" },
  { value: "down", label: "Down" },
];

const CATEGORY_LABEL = Object.fromEntries(TRANSITION_CATEGORIES.map((c) => [c.id, c.label])) as Record<
  TransitionCategory,
  string
>;

/** The params a transition actually reads, defaulted the way the engine does. */
const transitionPreviewOptions = (t: Transition) => ({
  direction: t.direction,
  softness: t.softness,
  color: t.color,
  intensity: t.intensity,
});

/**
 * Choosing from ~45 transitions inside a 288px column needs a real picker: a
 * flat `<select>` buries them, so this is a popover carrying the same family
 * chips, search box and rendered preview the library tab uses. Both surfaces
 * therefore read the same, and the trigger doubles as a mini monitor of the
 * transition as the layer currently has it configured.
 */
function TransitionPicker({ value, onChange }: { value: Transition; onChange: (type: TransitionType) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<TransitionCategory>(() => transitionDef(value.type)?.category ?? "basic");
  const current = transitionDef(value.type);

  const needle = query.trim().toLowerCase();
  const matching = (label: string, hint: string) =>
    !needle || label.toLowerCase().includes(needle) || hint.toLowerCase().includes(needle);
  // A search spans every family — staying inside the active chip would hide
  // exactly the thing being looked for.
  const defs = TRANSITION_DEFS.filter((def) =>
    needle ? matching(def.label, def.hint) : def.category === category && matching(def.label, def.hint),
  );

  const preview = (type: TransitionType, options: Parameters<typeof transitionPreviewDataUrl>[1]) => (
    <PreviewImage
      cacheKey={`tx:${type}:${options?.direction ?? ""}:${options?.softness ?? ""}:${options?.color ?? ""}:${
        options?.intensity ?? ""
      }`}
      factory={() => transitionPreviewDataUrl(type, options)}
    />
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded border border-km-border bg-km-track px-1.5 py-1.5 text-left transition hover:border-km-accent/55"
        >
          <span className="h-8 w-14 shrink-0 overflow-hidden rounded bg-km-panel2">
            {value.type === "none" ? null : preview(value.type, transitionPreviewOptions(value))}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[11.5px] text-km-text">{current?.label ?? value.type}</span>
            <span className="block truncate text-[9.5px] text-km-faint">
              {current ? CATEGORY_LABEL[current.category] : "unknown"}
            </span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-km-faint" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[272px] border-km-border bg-km-panel p-2">
        <SearchField value={query} onChange={setQuery} placeholder="Search transitions" />
        {!needle && (
          <div className="mt-2">
            <ChipRow<TransitionCategory>
              options={TRANSITION_CATEGORIES.map((option) => ({ value: option.id, label: option.label }))}
              value={category}
              onChange={setCategory}
            />
          </div>
        )}
        <div className="km-scroll mt-2 max-h-60 space-y-0.5 overflow-y-auto pr-1">
          {defs.length === 0 ? (
            <EmptyState>No transition matches “{query.trim()}”.</EmptyState>
          ) : (
            defs.map((def) => (
              <button
                key={def.id}
                type="button"
                title={def.hint}
                onClick={() => {
                  onChange(def.id);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-1 py-1 text-left transition",
                  def.id === value.type
                    ? "bg-km-accent/15 text-km-text"
                    : "text-km-dim hover:bg-km-raised hover:text-km-text",
                )}
              >
                <span className="h-7 w-12 shrink-0 overflow-hidden rounded bg-km-panel2">
                  {def.id === "none" ? null : preview(def.id, { direction: value.direction })}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px]">{def.label}</span>
                  <span className="block truncate text-[9px] text-km-faint">{def.hint}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The transition tab: the clip's own enter/exit ramps, and — where this clip
 * touches a neighbour on its track — the SEAM between them.
 *
 * The two are mutually exclusive on any one edge. A bond physically overlaps
 * the pair, so it is not a property of the clip edge at all: `setTransition`
 * would re-time a duration without moving the outgoing clip's tail, which is
 * exactly the invariant `applyBond` maintains. A bonded edge therefore hands
 * the section to `JointPanel` and never shows the edge controls beside it.
 */
function TransitionPanel({ layer }: { layer: Layer }) {
  const project = useEditor((s) => s.project);
  const gesture = useHistoryGesture();

  /**
   * The joins on this clip's own track, indexed by clip, so each edge can ask
   * whether it is a free edge or a seam with a neighbour.
   */
  const joins = useMemo(
    () => junctionIndex(junctionsOnTrack(project, layer.trackId)).get(layer.id),
    [project, layer.trackId, layer.id],
  );

  const edges: { edge: "in" | "out"; title: string; hint: string }[] = [
    { edge: "in", title: "Enter", hint: "how the clip arrives" },
    { edge: "out", title: "Exit", hint: "how the clip leaves" },
  ];

  return (
    <>
      {edges.map(({ edge, title, hint }) => {
        const junction = joins?.[edge];
        if (junction?.bonded) return <JointPanel key={edge} junction={junction} />;

        const transition = edge === "in" ? layer.transitionIn : layer.transitionOut;
        const def = transitionDef(transition.type);
        const params = def?.params ?? [];
        const set = (patch: Partial<Transition>, record = true) => editor().setTransition(layer.id, edge, patch, record);
        const maxDuration = Math.max(0.1, layer.duration / 2);
        // "none" and "cut" are instants — the ramp never runs, so its controls go quiet.
        const ramps = transition.type !== "none" && transition.type !== "cut";

        return (
          <Section key={edge} title={title}>
            <div className="space-y-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[10.5px] text-km-dim">Type</span>
                <span className="text-[10px] text-km-faint">{hint}</span>
              </div>
              <TransitionPicker value={transition} onChange={(type) => set({ type })} />
            </div>

            <SliderField
              label="Duration"
              value={Math.min(transition.duration, maxDuration)}
              min={0.1}
              max={Math.max(0.2, Math.round(maxDuration * 10) / 10)}
              step={0.05}
              format={(v) => `${v.toFixed(2)}s`}
              disabled={!ramps}
              onChange={(v) => {
                gesture.begin();
                set({ duration: v }, false);
              }}
              onCommit={() => gesture.end()}
            />

            {ramps && def?.directional && (
              <SegmentedField
                label="Direction"
                value={transition.direction}
                options={DIRECTIONS}
                onChange={(direction) => set({ direction })}
              />
            )}

            {ramps && params.includes("softness") && (
              <SliderField
                label="Softness"
                value={transition.softness ?? 0.35}
                min={0}
                max={1}
                step={0.01}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => {
                  gesture.begin();
                  set({ softness: v }, false);
                }}
                onCommit={() => gesture.end()}
              />
            )}

            {ramps && params.includes("intensity") && (
              <SliderField
                label="Strength"
                value={transition.intensity ?? 1}
                min={0}
                max={2}
                step={0.01}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => {
                  gesture.begin();
                  set({ intensity: v }, false);
                }}
                onCommit={() => gesture.end()}
              />
            )}

            {ramps && params.includes("color") && (
              <ColorField
                label="Colour"
                value={transition.color ?? "#ffffff"}
                onChange={(v) => {
                  gesture.begin();
                  set({ color: v }, false);
                }}
                onCommit={() => gesture.end()}
              />
            )}

            <div className="flex gap-1.5">
              <SmallButton
                onClick={() => set({ type: "fade", duration: Math.min(0.5, maxDuration) })}
                tone={transition.type === "fade" ? "accent" : "default"}
              >
                Fade {edge === "in" ? "in" : "out"}
              </SmallButton>
              <SmallButton onClick={() => set({ type: "none" })} disabled={transition.type === "none"}>
                Remove
              </SmallButton>
            </div>

            {isShaderTransition(transition.type) && (
              <p className="text-[10px] leading-relaxed text-km-faint">
                Runs a GLSL pass over both clips. When WebGL is unavailable the compositor falls back to a plain
                cross-fade, so the export still renders.
              </p>
            )}

            {junction && <SeamNote junction={junction} layer={layer} />}
          </Section>
        );
      })}

      <Section className="border-b-0">
        <p className="text-[10.5px] leading-relaxed text-km-faint">
          Transitions ramp at the clip's own edges, so moving the clip on the timeline keeps them attached. Durations are
          capped at half the clip length. Applying one from the library hits every selected clip at once.
        </p>
        <p className="text-[10.5px] leading-relaxed text-km-faint">
          Where two clips touch on a track the SEAM takes over: bonding them runs the outgoing clip past the join, so the
          incoming clip's ramp draws over real footage instead of over a gap. A bonded edge hands this tab to the seam
          editor, because there the overlap and the ramp are a single setting.
        </p>
      </Section>
    </>
  );
}

/**
 * The seam between two clips that touch, offered from the free edge of one of
 * them. A transition alone ramps *inside* the clip's own time, which at a hard
 * cut means fading up over whatever happens to sit underneath — not the same
 * thing as dissolving from the neighbour. Bonding is the way to get the latter,
 * and this is where the Inspector offers it.
 */
function SeamNote({ junction, layer }: { junction: Junction; layer: Layer }) {
  const project = useEditor((s) => s.project);
  const neighbour = project.layers[junction.from === layer.id ? junction.to : junction.from];

  return (
    <div className="rounded border border-dashed border-km-border px-2 py-1.5">
      <p className="text-[10px] leading-relaxed text-km-faint">
        {`${layer.name} butts up against ${neighbour?.name ?? "the next clip"} at ${formatTimecode(junction.seam)}. The transition above ramps inside this clip's own time — bond the two clips to overlap them so both are on screen while it runs.`}
      </p>
      <div className="mt-1.5">
        <SmallButton
          title={`Overlap the two clips by ${DEFAULT_BOND.duration.toFixed(2)}s and cross them over`}
          onClick={() => editor().bondTransition(junction.from, junction.to, { ...DEFAULT_BOND })}
        >
          <Link2 className="h-3 w-3" /> Bond these clips
        </SmallButton>
      </div>
    </div>
  );
}

/**
 * The seam editor: the precise-number surface for a bond that already exists.
 *
 * The timeline glyph owns *creating* a bond; this panel re-lengths the overlap
 * against the geometry the clips actually have, retunes the transition, or
 * breaks the pair back into a plain cut.
 *
 * Every write goes through `bondTransition`, and that is the whole point: the
 * overlap IS the outgoing clip's tail, so a control that re-timed the ramp
 * without moving the tail would leave the geometry lying about what is on
 * screen. The clip-edge controls therefore never appear beside these — for any
 * one edge they are an either/or.
 */
function JointPanel({ junction }: { junction: Junction }) {
  const project = useEditor((s) => s.project);
  const assets = useEditor((s) => s.assets);

  const from = project.layers[junction.from];
  const to = project.layers[junction.to];

  const transition = junction.transition;
  const def = transitionDef(transition.type);
  const params = def?.params ?? [];
  // The clips can be pulled apart under the bond's feet; clamping the controls
  // to what the geometry currently supports keeps the slider inside its range.
  const limit = Math.max(MIN_BOND_OVERLAP, maxBondDuration(project, junction.from, junction.to));
  const overlap = clamp(junction.overlap, MIN_BOND_OVERLAP, limit);

  if (!from || !to) return null;

  const source = from.assetId ? assets[from.assetId] : undefined;
  const holds = bondHoldsLastFrame(from, source?.duration ?? 0);

  /** One writer for this seam, so the picker and the slider cannot disagree. */
  const bond = (patch: Partial<Transition>, record = true) =>
    editor().bondTransition(junction.from, junction.to, patch, record);

  return (
    <Section
      title={`Seam · ${def?.label ?? transition.type}`}
      action={<span className="font-mono text-[10px] text-km-faint">{formatTimecode(junction.seam)}</span>}
    >
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="h-4 w-1 shrink-0 rounded-full" style={{ backgroundColor: LAYER_COLORS[from.type] }} />
        <span className="min-w-0 flex-1 truncate text-km-text">{from.name}</span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-km-faint" />
        <span className="h-4 w-1 shrink-0 rounded-full" style={{ backgroundColor: LAYER_COLORS[to.type] }} />
        <span className="min-w-0 flex-1 truncate text-km-text">{to.name}</span>
      </div>

      <p className="text-[10.5px] leading-relaxed text-km-faint">
        {`${from.name} runs ${overlap.toFixed(2)}s past the join and ${to.name} fades up across it, so both clips are on screen for the overlap.`}
      </p>

      {holds && (
        <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[10px] leading-relaxed text-amber-200">
          {`${from.name} is already at the end of its source, so its final frame is held for the overlap.`}
        </p>
      )}

      <TransitionPicker value={transition} onChange={(type) => bond({ type })} />

      <SliderField
        label="Overlap"
        value={overlap}
        min={MIN_BOND_OVERLAP}
        max={Math.max(MIN_BOND_OVERLAP + 0.05, Math.round(limit * 100) / 100)}
        step={0.05}
        format={(v) => `${v.toFixed(2)}s`}
        onChange={(v) => bond({ duration: v }, false)}
        onCommit={(v) => bond({ duration: v }, false)}
      />

      {def?.directional && (
        <SegmentedField
          label="Direction"
          value={transition.direction}
          options={DIRECTIONS}
          onChange={(direction) => bond({ direction }, false)}
        />
      )}

      {params.includes("softness") && (
        <SliderField
          label="Softness"
          value={transition.softness ?? 0.35}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => bond({ softness: v }, false)}
          onCommit={(v) => bond({ softness: v }, false)}
        />
      )}

      {params.includes("intensity") && (
        <SliderField
          label="Strength"
          value={transition.intensity ?? 1}
          min={0}
          max={2}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => bond({ intensity: v }, false)}
          onCommit={(v) => bond({ intensity: v }, false)}
        />
      )}

      {params.includes("color") && (
        <ColorField
          label="Colour"
          value={transition.color ?? "#ffffff"}
          onChange={(v) => bond({ color: v }, false)}
          onCommit={(v) => bond({ color: v }, false)}
        />
      )}

      <div className="flex gap-1.5">
        <SmallButton
          title="Trim the tail back to the join and leave a clean cut"
          onClick={() => editor().unbondTransition(junction.from, junction.to)}
        >
          <Unlink className="h-3 w-3" /> Remove bond
        </SmallButton>
      </div>

      {isShaderTransition(transition.type) && (
        <p className="text-[10px] leading-relaxed text-km-faint">
          {`A shader bond samples the frame beneath it, which is why ${from.name} is kept solid across the overlap instead of ramping with it.`}
        </p>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ *
 * Audio
 * ------------------------------------------------------------------ */

function AudioPanel({ layer }: { layer: Layer }) {
  const assets = useEditor((s) => s.assets);
  const asset = layer.assetId ? assets[layer.assetId] : undefined;
  const set = (patch: Partial<Layer>, record = false) => editor().updateLayer(layer.id, patch, record);

  return (
    <>
      <Section title="Level">
        <SliderField
          label="Volume"
          value={layer.volume}
          min={0}
          max={2}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => set({ volume: v })}
        />
        <div className="flex gap-1.5 flex-wrap">
          <SmallButton onClick={() => set({ volume: 1 }, true)}>100%</SmallButton>
          <SmallButton onClick={() => set({ volume: 0.6 }, true)}>-4 dB</SmallButton>
          <SmallButton onClick={() => set({ volume: 0 }, true)}>Silence</SmallButton>
          <SmallButton onClick={() => set({ volume: Math.max(0, layer.volume - 0.1) }, true)}>-10%</SmallButton>
          <SmallButton onClick={() => set({ volume: Math.min(2, layer.volume + 0.1) }, true)}>+10%</SmallButton>
        </div>
      </Section>

      <Section title="Fades">
        <SliderField
          label="Fade in"
          value={layer.audioFadeIn}
          min={0}
          max={Math.max(0.5, layer.duration / 2)}
          step={0.05}
          format={(v) => `${v.toFixed(2)}s`}
          onChange={(v) => set({ audioFadeIn: v })}
        />
        <SliderField
          label="Fade out"
          value={layer.audioFadeOut}
          min={0}
          max={Math.max(0.5, layer.duration / 2)}
          step={0.05}
          format={(v) => `${v.toFixed(2)}s`}
          onChange={(v) => set({ audioFadeOut: v })}
        />
      </Section>

      <Section title="Source">
        <Row label="File">
          <div className="truncate rounded border border-km-border bg-km-track px-2 py-1 text-[11px] text-km-dim">
            {asset ? asset.name : "no media attached"}
          </div>
        </Row>
        <div className="flex items-center justify-between text-[10.5px] text-km-faint">
          <span>{asset?.duration ? `${asset.duration.toFixed(2)}s source` : "—"}</span>
          <span>{asset?.audioBuffer ? "decoded" : "decodes on export"}</span>
        </div>
        <p className="text-[10.5px] leading-relaxed text-km-faint">
          Preview plays through the Web Audio graph; export mixes the same gain envelope into the recorded track. A video
          keeps its own sound — move the playhead over it and press space to hear it.
        </p>
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Effect
 * ------------------------------------------------------------------ */

const EFFECT_KINDS: { value: "solid" | "gradient" | "vignette" | "glow"; label: string }[] = [
  { value: "solid", label: "Solid card" },
  { value: "gradient", label: "Gradient wash" },
  { value: "vignette", label: "Vignette" },
  { value: "glow", label: "Glow" },
];

const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: "source-over", label: "Normal" },
  { value: "multiply", label: "Multiply" },
  { value: "screen", label: "Screen" },
  { value: "overlay", label: "Overlay" },
  { value: "lighten", label: "Lighten" },
  { value: "darken", label: "Darken" },
  { value: "color-dodge", label: "Colour dodge" },
  { value: "soft-light", label: "Soft light" },
];

function EffectPanel({ layer }: { layer: Layer }) {
  const settings = useEditor((s) => s.project.settings);
  const effect = layer.effect;

  if (!effect) {
    return <EmptyHint>This layer carries no effect. Add a gradient, vignette, glow or solid card from the left panel.</EmptyHint>;
  }

  const set = (patch: Partial<typeof effect>, record = true) =>
    editor().updateLayer(layer.id, { effect: { ...effect, ...patch } }, record);

  return (
    <>
      <Section title="Effect">
        <SelectField label="Kind" value={effect.kind} options={EFFECT_KINDS} onChange={(kind) => set({ kind })} />
        <ColorField label="Primary" value={effect.color} onChange={(v) => set({ color: v }, false)} />
        <ColorField label="Secondary" value={effect.color2} onChange={(v) => set({ color2: v }, false)} />
        <SliderField
          label="Angle"
          value={effect.angle}
          min={0}
          max={360}
          step={1}
          format={(v) => `${Math.round(v)}°`}
          onChange={(v) => set({ angle: v }, false)}
        />
        <SelectField label="Blend" value={effect.blend} options={BLEND_MODES} onChange={(blend) => set({ blend })} />
      </Section>

      <Section title="Coverage">
        <p className="text-[10.5px] leading-relaxed text-km-faint">
          An effect fills its own layer box — scale it on the canvas to cover the whole frame, and keyframe Opacity in the
          Keys tab to fade it in and out.
        </p>
        <div className="flex gap-1.5">
          <SmallButton
            onClick={() => editor().updateLayerTransform(layer.id, { x: settings.width / 2, y: settings.height / 2 }, true)}
          >
            Center
          </SmallButton>
          <SmallButton
            title="Stretch the wash across the frame"
            onClick={() =>
              editor().updateLayerTransform(layer.id, { scale: 1, x: settings.width / 2, y: settings.height / 2 }, true)
            }
          >
            Reset size
          </SmallButton>
        </div>
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Keyframes
 * ------------------------------------------------------------------ */

const PROP_META: Record<AnimatableProp, { label: string; step: number }> = {
  opacity: { label: "Opacity", step: 0.01 },
  scale: { label: "Scale", step: 0.01 },
  scaleX: { label: "Scale X", step: 0.01 },
  scaleY: { label: "Scale Y", step: 0.01 },
  rotation: { label: "Rotation", step: 1 },
  x: { label: "X", step: 1 },
  y: { label: "Y", step: 1 },
  volume: { label: "Volume", step: 0.01 },
};

const PROPS_BASE: AnimatableProp[] = ["opacity", "scale", "rotation", "x", "y"];

const EASING_OPTIONS: { value: Easing; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "easeIn", label: "Ease in" },
  { value: "easeOut", label: "Ease out" },
  { value: "easeInOut", label: "Ease in/out" },
];

function KeyframesPanel({ layer }: { layer: Layer }) {
  const currentTime = useEditor((s) => s.currentTime);
  const gesture = useHistoryGesture();
  const local = clamp(currentTime - layer.startTime, 0, layer.duration);
  const animated = layer.type === "audio" || layer.type === "video";
  const props = animated ? [...PROPS_BASE, "volume" as AnimatableProp] : PROPS_BASE;
  const sorted = useMemo(() => [...layer.keyframes].sort((a, b) => a.time - b.time), [layer.keyframes]);

  const keyAt = (prop: AnimatableProp) =>
    layer.keyframes.find((k) => k.prop === prop && Math.abs(k.time - local) < 1e-3);

  const toggleKey = (prop: AnimatableProp) => {
    const existing = keyAt(prop);
    if (existing) editor().removeKeyframe(layer.id, existing.id);
    else editor().addKeyframe(layer.id, prop, undefined, local);
  };

  /** Writes keyframes without its own history entry, so a drag stays one step. */
  const patchKeyframe = (id: string, patch: Partial<Keyframe>) => {
    const keyframes = layer.keyframes
      .map((k) =>
        k.id === id
          ? { ...k, ...patch, time: patch.time !== undefined ? clamp(patch.time, 0, layer.duration) : k.time }
          : k,
      )
      .sort((a, b) => a.time - b.time);
    editor().updateLayer(layer.id, { keyframes }, false);
  };

  return (
    <>
      <Section
        title="At the playhead"
        action={
          sorted.length > 0 ? (
            <SmallButton tone="danger" onClick={() => editor().clearKeyframes(layer.id)}>
              Clear all
            </SmallButton>
          ) : undefined
        }
      >
        <p className="mb-1 font-mono text-[10.5px] text-km-faint">
          layer time {formatTimecode(local)} / {layer.duration.toFixed(2)}s
        </p>
        <div className="space-y-1">
          {props.map((prop) => {
            const has = !!keyAt(prop);
            const value = staticPropValue(layer, prop);
            return (
              <button
                key={prop}
                type="button"
                onClick={() => toggleKey(prop)}
                title={has ? "Remove the keyframe here" : "Add a keyframe here"}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition",
                  has ? "bg-km-accent/15 text-km-accent" : "bg-km-panel2 text-km-dim hover:bg-km-raised hover:text-km-text",
                )}
              >
                <Diamond className={cn("h-3 w-3 shrink-0", has && "fill-current")} />
                <span className="text-[11.5px]">{PROP_META[prop].label}</span>
                <span className="ml-auto font-mono text-[10.5px] text-km-faint">
                  {prop === "opacity" || prop === "volume"
                    ? `${Math.round(value * 100)}%`
                    : prop === "rotation"
                      ? `${Math.round(value)}°`
                      : value.toFixed(1)}
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title={`Keyframes · ${sorted.length}`} className="border-b-0">
        {sorted.length === 0 ? (
          <p className="text-[10.5px] leading-relaxed text-km-faint">
            No keyframes yet. Park the playhead, then click a property above to lock in a value. Two or more keyframes
            animate the property between them with the easing of the earlier keyframe.
          </p>
        ) : (
          <div className="space-y-2">
            {sorted.map((keyframe) => (
              <div key={keyframe.id} className="rounded border border-km-border bg-km-track p-2">
                <div className="flex items-center gap-2">
                  <Diamond className="h-3 w-3 shrink-0 fill-current text-km-accent" />
                  <span className="text-[11px] text-km-text">{PROP_META[keyframe.prop].label}</span>
                  <button
                    type="button"
                    title="Jump the playhead here"
                    onClick={() => editor().setCurrentTime(layer.startTime + keyframe.time)}
                    className="ml-auto rounded px-1 font-mono text-[10px] text-km-faint transition hover:bg-km-raised hover:text-km-text"
                  >
                    {formatTimecode(keyframe.time)}
                  </button>
                  <button
                    type="button"
                    title="Delete keyframe"
                    onClick={() => editor().removeKeyframe(layer.id, keyframe.id)}
                    className="grid h-5 w-5 place-items-center rounded text-km-faint transition hover:bg-red-500/20 hover:text-red-300"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <NumberField
                    label="Time"
                    value={keyframe.time}
                    min={0}
                    max={layer.duration}
                    step={0.05}
                    suffix="s"
                    onChange={(v) => {
                      gesture.begin();
                      patchKeyframe(keyframe.id, { time: v });
                    }}
                    onCommit={() => gesture.end()}
                  />
                  <NumberField
                    label="Value"
                    value={keyframe.value}
                    step={PROP_META[keyframe.prop].step}
                    onChange={(v) => {
                      gesture.begin();
                      patchKeyframe(keyframe.id, { value: v });
                    }}
                    onCommit={() => gesture.end()}
                  />
                </div>
                <div className="mt-2">
                  <SelectField
                    label="Easing"
                    value={keyframe.easing}
                    options={EASING_OPTIONS}
                    onChange={(easing) => patchKeyframe(keyframe.id, { easing })}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Multiple selection
 * ------------------------------------------------------------------ */

function MultiPanel({ layers }: { layers: Layer[] }) {
  const ids = layers.map((l) => l.id);
  const gesture = useHistoryGesture();

  const num = (apply: (v: number) => void) => ({
    onChange: (v: number) => {
      gesture.begin();
      apply(v);
    },
    onCommit: () => gesture.end(),
  });

  const setTransformAll = (patch: TransformPatch) => {
    for (const id of ids) editor().updateLayerTransform(id, patch, false);
  };

  return (
    <>
      <PanelTitle title={`${layers.length} layers selected`} hint="shift-click to add" />

      <div className="shrink-0 border-b border-km-border px-3 pb-3">
        <div className="flex items-center gap-1.5 flex-wrap">
          <SmallButton title="Duplicate all (Ctrl+D)" onClick={() => editor().duplicateLayers(ids)}>
            <Copy className="h-3 w-3" /> Duplicate
          </SmallButton>
          <SmallButton title="Copy all (Ctrl+C)" onClick={() => editor().copyLayers(ids)}>
            <ClipboardCopy className="h-3 w-3" /> Copy
          </SmallButton>
          <SmallButton title="Paste (Ctrl+V)" onClick={() => editor().pasteLayers()}>
            <ClipboardPaste className="h-3 w-3" /> Paste
          </SmallButton>
          <SmallButton tone="danger" title="Delete all (Del)" onClick={() => editor().removeLayers(ids)}>
            <Trash2 className="h-3 w-3" /> Delete
          </SmallButton>
        </div>
      </div>

      <div className="km-scroll min-h-0 flex-1 overflow-y-auto">
        <Section title="Shared values">
          <SliderField
            label="Opacity"
            value={layers[layers.length - 1].opacity}
            min={0}
            max={1}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => editor().updateSelected({ opacity: v }, false)}
          />
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="X for all"
              value={Math.round(layers[layers.length - 1].transform.x)}
              step={1}
              suffix="px"
              {...num((v) => setTransformAll({ x: v }))}
            />
            <NumberField
              label="Y for all"
              value={Math.round(layers[layers.length - 1].transform.y)}
              step={1}
              suffix="px"
              {...num((v) => setTransformAll({ y: v }))}
            />
          </div>
          <SliderField
            label="Scale for all"
            value={layers[layers.length - 1].transform.scale}
            min={0.02}
            max={8}
            step={0.01}
            format={(v) => `${v.toFixed(2)}×`}
            onChange={(v) => setTransformAll({ scale: v })}
          />
          <SliderField
            label="Rotation for all"
            value={layers[layers.length - 1].transform.rotation}
            min={-180}
            max={180}
            step={1}
            format={(v) => `${Math.round(v)}°`}
            onChange={(v) => setTransformAll({ rotation: v })}
          />
        </Section>

        <Section title="Selection" className="border-b-0">
          <div className="space-y-1">
            {[...layers].reverse().map((layer) => (
              <button
                key={layer.id}
                type="button"
                onClick={() => editor().select([layer.id])}
                className="flex w-full items-center gap-2 rounded bg-km-panel2 px-2 py-1.5 text-left transition hover:bg-km-raised"
              >
                <span className="h-4 w-1 shrink-0 rounded-full" style={{ backgroundColor: LAYER_COLORS[layer.type] }} />
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-km-text">{layer.name}</span>
                <span className="shrink-0 text-[10px] text-km-faint">{LAYER_LABELS[layer.type]}</span>
              </button>
            ))}
          </div>
          <p className="text-[10.5px] leading-relaxed text-km-faint">
            Click a layer to edit it on its own. Arrow keys nudge every selected layer; hold Shift for 20px steps.
          </p>
        </Section>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Small pieces
 * ------------------------------------------------------------------ */

function PanelTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-km-border px-3">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-km-dim">{title}</span>
      {hint && <span className="ml-auto text-[10px] text-km-faint">{hint}</span>}
    </div>
  );
}

function IconButton({
  children,
  title,
  onClick,
  active,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "grid h-6 w-6 shrink-0 place-items-center rounded transition hover:bg-km-raised",
        active ? "text-km-accent" : "text-km-faint hover:text-km-text",
      )}
    >
      {children}
    </button>
  );
}
