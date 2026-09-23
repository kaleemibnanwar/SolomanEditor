/**
 * Top bar — project identity, history controls, project settings and export.
 */
import { useState, type CSSProperties, type MouseEvent } from "react";
import {
  Bot,
  ChevronDown,
  FolderOpen,
  KeyRound,
  Loader2,
  Radio,
  Redo2,
  RotateCcw,
  Save,
  Settings2,
  Undo2,
  Upload,
} from "lucide-react";
import octoLogo from "@/assets/octo-logo.png";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ColorField, NumberField, Row, SegmentedField, Section } from "@/components/editor/fields";
import WindowControls from "@/components/editor/WindowControls";
import { saveProjectNow } from "@/hooks/useProjectLibrary";
import { resetToDemo } from "@/lib/demo";
import { resetActivityTracking } from "@/lib/mcp/activity";
import { windowControls } from "@/lib/windowControls";
import { cn } from "@/lib/utils";
import { editor, editorStore, selectCanRedo, selectCanUndo, useEditor } from "@/store/editorStore";

/**
 * The bar doubles as the window's drag handle now that `frame: false` (see
 * `electron/main.cjs`) leaves nothing else to grab. Every interactive cluster
 * inside it opts back out with `data-no-drag` / `WebkitAppRegion: "no-drag"`,
 * so the bar is draggable everywhere except where that would eat a click.
 */
const DRAG_REGION = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;

const RESOLUTIONS: { label: string; width: number; height: number }[] = [
  { label: "1920 × 1080 · Landscape", width: 1920, height: 1080 },
  { label: "1080 × 1920 · Portrait", width: 1080, height: 1920 },
  { label: "1080 × 1080 · Square", width: 1080, height: 1080 },
  { label: "1280 × 720 · Light", width: 1280, height: 720 },
  { label: "3840 × 2160 · 4K", width: 3840, height: 2160 },
];

export default function TopBar({
  onExport,
  onAgent,
  onProjects,
  mode,
  onToggleMode,
}: {
  onExport: () => void;
  onAgent: () => void;
  onProjects: () => void;
  mode: "edit" | "broadcast";
  onToggleMode: () => void;
}) {
  const settings = useEditor((s) => s.project.settings);
  const canUndo = useEditor(selectCanUndo);
  const canRedo = useEditor(selectCanRedo);
  const exporting = useEditor((s) => s.ui.exporting);
  const lastAction = useEditor((s) => s.lastAction);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  /** An explicit save, for when autosave has not caught up with you yet. */
  const save = async () => {
    setSaving(true);
    try {
      await saveProjectNow();
    } finally {
      setSaving(false);
    }
  };

  /** Resizes the canvas and rescales layers so their framing survives — one undo step. */
  const applyResolution = (width: number, height: number) => {
    const project = editor().project;
    const prev = project.settings;
    if (prev.width === width && prev.height === height) return;
    const sx = width / prev.width;
    const sy = height / prev.height;
    const shrink = Math.min(sx, sy);

    const layers = { ...project.layers };
    for (const id of project.layerIds) {
      const layer = layers[id];
      if (!layer) continue;
      layers[id] = {
        ...layer,
        transform: {
          ...layer.transform,
          x: layer.transform.x * sx,
          y: layer.transform.y * sy,
          scale: layer.transform.scale * shrink,
        },
      };
    }

    editor().pushHistory();
    editorStore.setState({
      project: { ...project, settings: { ...prev, width, height }, layers },
      lastAction: "Canvas size",
    });
  };

  /** A double-click anywhere on the drag region toggles maximize, like a native bar. */
  const onBarDoubleClick = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    void windowControls()?.toggleMaximize();
  };

  return (
    <header
      style={DRAG_REGION}
      onDoubleClick={onBarDoubleClick}
      className="flex h-12 shrink-0 items-center gap-3 border-b border-km-border bg-km-panel px-3"
    >
      <div className="flex items-center gap-2">
        <img src={octoLogo} alt="" className="h-7 w-7 shrink-0 object-contain" />
        <span className="text-[13px] font-semibold tracking-tight text-km-text">Octo Cut</span>
      </div>

      <div className="mx-1 h-5 w-px bg-km-border" />

      <div data-no-drag style={NO_DRAG} className="flex items-center gap-0.5 rounded-md border border-km-border bg-km-track p-0.5">
        <button
          type="button"
          onClick={() => mode !== "edit" && onToggleMode()}
          className={cn("rounded px-2 py-0.5 text-[11px] transition", mode === "edit" ? "bg-km-raised text-km-text" : "text-km-dim hover:text-km-text")}
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => mode !== "broadcast" && onToggleMode()}
          className={cn(
            "flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition",
            mode === "broadcast" ? "bg-km-accent text-white" : "text-km-dim hover:text-km-text",
          )}
        >
          <Radio className="h-3 w-3" />
          Broadcast
        </button>
      </div>

      {mode === "edit" && (
        <>
          <div className="mx-1 h-5 w-px bg-km-border" />

          <Input
        data-no-drag
        style={NO_DRAG}
        value={settings.name}
        onChange={(e) => editor().updateSettings({ name: e.target.value })}
        className="h-7 w-56 border-transparent bg-transparent px-2 text-[12.5px] text-km-text hover:border-km-border focus-visible:border-km-border focus-visible:ring-0"
        aria-label="Project name"
      />

      <div data-no-drag style={NO_DRAG} className="flex items-center gap-1">
        <button
          type="button"
          title="Undo (Ctrl+Z)"
          disabled={!canUndo}
          onClick={() => editor().undo()}
          className="grid h-8 w-8 place-items-center rounded-md text-km-dim transition hover:bg-km-raised hover:text-km-text disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
        >
          <Undo2 className="h-4 w-4" />
        </button>
        <button
          type="button"
          title="Redo (Ctrl+Shift+Z)"
          disabled={!canRedo}
          onClick={() => editor().redo()}
          className="grid h-8 w-8 place-items-center rounded-md text-km-dim transition hover:bg-km-raised hover:text-km-text disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
        >
          <Redo2 className="h-4 w-4" />
        </button>
      </div>

      <div data-no-drag style={NO_DRAG} className="flex items-center gap-1">
        <button
          type="button"
          title="Save now (Ctrl+S)"
          disabled={saving}
          onClick={() => void save()}
          className="grid h-8 w-8 place-items-center rounded-md text-km-dim transition hover:bg-km-raised hover:text-km-text disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        </button>
        <button
          type="button"
          title="Templates and saved projects"
          onClick={onProjects}
          className="grid h-8 w-8 place-items-center rounded-md text-km-dim transition hover:bg-km-raised hover:text-km-text"
        >
          <FolderOpen className="h-4 w-4" />
        </button>
      </div>

      <span className="hidden max-w-[220px] truncate text-[11px] text-km-faint xl:inline">{lastAction}</span>

      <div data-no-drag style={NO_DRAG} className="ml-auto flex items-center gap-2">
        <button
          type="button"
          title="Rebuild the demo project"
          onClick={() => {
            resetActivityTracking();
            void resetToDemo();
          }}
          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-km-dim transition hover:bg-km-raised hover:text-km-text"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Demo
        </button>

        <button
          type="button"
          title="Connect an AI agent over MCP"
          onClick={onAgent}
          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-km-dim transition hover:bg-km-raised hover:text-km-text"
        >
          <Bot className="h-3.5 w-3.5" />
          Agent
        </button>

        <button
          type="button"
          title="Stock-media API keys"
          onClick={() => editor().setUi({ settingsOpen: true })}
          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-km-dim transition hover:bg-km-raised hover:text-km-text"
        >
          <KeyRound className="h-3.5 w-3.5" />
          Keys
        </button>

        <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-km-dim transition hover:bg-km-raised hover:text-km-text"
            >
              <Settings2 className="h-3.5 w-3.5" />
              {settings.width}×{settings.height} · {settings.fps}fps
              <ChevronDown className="h-3 w-3" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 border-km-border bg-km-panel p-0">
            <Section title="Canvas">
              <Row label="Preset">
                <select
                  value={`${settings.width}x${settings.height}`}
                  onChange={(e) => {
                    const [w, h] = e.target.value.split("x").map(Number);
                    applyResolution(w, h);
                  }}
                  className="h-7 w-full rounded border border-km-border bg-km-track px-2 text-[12px] text-km-text outline-none focus:ring-1 focus:ring-km-accent"
                >
                  {RESOLUTIONS.map((r) => (
                    <option key={r.label} value={`${r.width}x${r.height}`} className="bg-km-panel2">
                      {r.label}
                    </option>
                  ))}
                  {!RESOLUTIONS.some((r) => r.width === settings.width && r.height === settings.height) && (
                    <option value={`${settings.width}x${settings.height}`} className="bg-km-panel2">
                      Custom {settings.width} × {settings.height}
                    </option>
                  )}
                </select>
              </Row>
              <div className="grid grid-cols-2 gap-2">
                <NumberField
                  label="Width"
                  value={settings.width}
                  min={64}
                  step={2}
                  onChange={(v) => editor().updateSettings({ width: Math.round(v) })}
                />
                <NumberField
                  label="Height"
                  value={settings.height}
                  min={64}
                  step={2}
                  onChange={(v) => editor().updateSettings({ height: Math.round(v) })}
                />
              </div>
              <SegmentedField
                label="Frame rate"
                value={String(settings.fps)}
                options={[
                  { value: "24", label: "24" },
                  { value: "30", label: "30" },
                  { value: "60", label: "60" },
                ]}
                onChange={(v) => editor().updateSettings({ fps: Number(v) })}
              />
              <ColorField
                label="Background"
                value={settings.backgroundColor}
                onChange={(v) => editor().updateSettings({ backgroundColor: v })}
              />
            </Section>
            <Section className="border-b-0">
              <p className="text-[10.5px] leading-relaxed text-km-faint">
                Changing the canvas rescales existing layers so their framing is preserved.
              </p>
            </Section>
          </PopoverContent>
        </Popover>

        <Button
          size="sm"
          onClick={onExport}
          disabled={exporting}
          className="h-8 gap-1.5 bg-km-accent text-[12px] text-white hover:bg-km-accent2"
        >
          <Upload className="h-3.5 w-3.5" />
          {exporting ? "Exporting…" : "Export"}
        </Button>
      </div>
        </>
      )}

      {/* In broadcast mode the editor controls (and their ml-auto spacer) are
          gone, so the window controls need their own right-alignment spacer. */}
      {mode === "broadcast" && <div className="ml-auto" />}

      {windowControls() && <div className="mx-1 h-5 w-px bg-km-border" />}

      <WindowControls />
    </header>
  );
}
