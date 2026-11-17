/**
 * Top bar — project identity, history controls, project settings and export.
 */
import { useState, useEffect, type CSSProperties, type MouseEvent } from "react";
import {
  Activity,
  BarChart2,
  Bot,
  ChevronDown,
  Cpu,
  Download,
  FolderOpen,
  Image,
  KeyRound,
  Loader2,
  MonitorPlay,
  Radio,
  Redo2,
  RefreshCw,
  RotateCcw,
  Save,
  ServerCrash,
  Settings2,
  Undo2,
  Upload,
  Wifi,
} from "lucide-react";
import solomanLogo from "@/assets/soloman-editor-logo.png";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ColorField, NumberField, Row, SegmentedField, Section } from "@/components/editor/fields";
import WindowControls from "@/components/editor/WindowControls";
import { saveProjectNow } from "@/hooks/useProjectLibrary";
import { resetToDemo } from "@/lib/demo";
import { resetActivityTracking } from "@/lib/mcp/activity";
import { useUpdater } from "@/lib/updater";
import { windowControls } from "@/lib/windowControls";
import { cn } from "@/lib/utils";
import { editor, editorStore, selectCanRedo, selectCanUndo, useEditor } from "@/store/editorStore";
import type { EditorMode } from "@/types/editor";

/**
 * The bar doubles as the window's drag handle now that `frame: false` (see
 * `electron/main.cjs`) leaves nothing else to grab. Every interactive cluster
 * inside it opts back out with `data-no-drag` / `WebkitAppRegion: "no-drag"`,
 * so the bar is draggable everywhere except where that would eat a click.
 */
const DRAG_REGION = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;

const RESOLUTIONS: { label: string; width: number; height: number }[] = [
  { label: "3840 × 2160 · 4K Landscape", width: 3840, height: 2160 },
  { label: "2160 × 3840 · 4K Portrait", width: 2160, height: 3840 },
  { label: "1920 × 1080 · HD Landscape", width: 1920, height: 1080 },
  { label: "1080 × 1920 · HD Portrait", width: 1080, height: 1920 },
  { label: "1280 × 720 · 720p Landscape", width: 1280, height: 720 },
  { label: "720 × 1280 · 720p Portrait", width: 720, height: 1280 },
  { label: "1080 × 1080 · Square", width: 1080, height: 1080 },
];

function SystemStats() {
  const [stats, setStats] = useState<{ memory: { total: number; free: number; used: number }; cpu: { percentCPUUsage: number }; gpu: number; ping: number } | null>(null);
  
  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.solomanEditorHost?.system;
    if (!bridge) return;
    
    let mounted = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const result = await bridge.stats();
        if (mounted) setStats(result);
      } catch (error) {
        console.warn("System performance stats are unavailable.", error);
      }
      if (mounted) timer = window.setTimeout(tick, 3000);
    };
    void tick();
    return () => {
      mounted = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  if (!stats) return null;
  const memUsed = Math.round(stats.memory.used / 1024 / 1024);
  const memTotal = Math.round(stats.memory.total / 1024 / 1024);
  const cpu = Math.round(stats.cpu.percentCPUUsage);
  const gpu = stats.gpu >= 0 ? Math.round(stats.gpu) : null;

  return (
    <div data-no-drag style={NO_DRAG} className="mx-2">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            title="System performance"
            className="grid h-8 w-8 place-items-center rounded-md text-km-dim transition hover:bg-km-raised hover:text-km-text"
          >
            <BarChart2 className="h-4 w-4" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-48 border-km-border bg-km-panel p-3 shadow-lg">
          <div className="flex flex-col gap-3 text-[11px] text-km-faint">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5"><Cpu className="w-3.5 h-3.5 text-blue-400/80" /> CPU</span>
              <span className="text-km-text font-medium">{cpu}%</span>
            </div>
            {gpu !== null && (
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5"><MonitorPlay className="w-3.5 h-3.5 text-cyan-400/80" /> GPU</span>
                <span className="text-km-text font-medium">{gpu}%</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5"><Activity className="w-3.5 h-3.5 text-purple-400/80" /> RAM</span>
              <span className="text-km-text font-medium">{memUsed} / {memTotal}GB</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5"><Wifi className="w-3.5 h-3.5 text-green-400/80" /> Ping</span>
              {stats.ping >= 0 ? (
                <span className="text-km-text font-medium">{Math.round(stats.ping)}ms</span>
              ) : (
                <span className="text-red-400/80 font-medium">Offline</span>
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * Auto-update affordance. The updater only exists in a packaged desktop build,
 * so in a plain browser tab (`available === false`) this renders nothing. When a
 * download has finished it becomes a restart button; while it is still working
 * it is a quiet "checking… / n%" hint so the user is not left guessing.
 */
function UpdateIndicator() {
  const { state, available, install } = useUpdater();
  if (!available) return null;

  if (state.status === "downloaded") {
    return (
      <Button
        size="sm"
        data-no-drag
        style={NO_DRAG}
        title={`Version ${state.version ?? ""} is ready`}
        onClick={install}
        className="h-8 gap-1.5 border border-km-border bg-km-raised px-2 text-[11.5px] text-km-text hover:bg-km-accent hover:text-km-bg"
      >
        <Download className="h-3.5 w-3.5" />
        Update ready — restart
      </Button>
    );
  }

  if (state.status === "downloading") {
    return (
      <span data-no-drag style={NO_DRAG} className="flex items-center gap-1.5 text-[11px] text-km-faint">
        <RefreshCw className="h-3 w-3 animate-spin" />
        Updating {state.percent}%
      </span>
    );
  }

  if (state.status === "checking" || state.status === "available" || state.status === "installing") {
    return (
      <span data-no-drag style={NO_DRAG} className="flex items-center gap-1.5 text-[11px] text-km-faint">
        <Loader2 className="h-3 w-3 animate-spin" />
        {state.status === "available" ? "Update available" : "Checking for updates…"}
      </span>
    );
  }

  return null;
}

export default function TopBar({
  onExport,
  onAgent,
  onProjects,
  mode,
}: {
  onExport: () => void;
  onAgent: () => void;
  onProjects: () => void;
  mode: EditorMode;
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
      className="flex h-[58px] shrink-0 items-center gap-[18px] border-b border-km-border bg-km-panel px-5"
    >
      <div className="flex w-[196px] shrink-0 items-center gap-2.5">
        <img src={solomanLogo} alt="" className="h-[29px] w-[29px] shrink-0 object-contain drop-shadow-[0_2px_8px_rgba(255,255,255,0.12)]" />
        <span className="text-[17px] font-extrabold tracking-[-0.055em] text-km-text">Soloman Editor</span>
      </div>

      <div data-no-drag style={NO_DRAG} className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => editor().setUi({ mode: "edit" })}
          aria-pressed={mode === "edit"}
          className={cn("rounded-lg px-3 py-2 text-[12px] transition", mode === "edit" ? "bg-km-raised text-km-text" : "text-km-dim hover:text-km-text")}
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => editor().setUi({ mode: "image" })}
          aria-pressed={mode === "image"}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] transition",
            mode === "image" ? "bg-km-raised text-km-text" : "text-km-dim hover:text-km-text",
          )}
        >
          <Image className="h-3 w-3" />
          Image
        </button>
        <button
          type="button"
          onClick={() => editor().setUi({ mode: "broadcast" })}
          aria-pressed={mode === "broadcast"}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] transition",
            mode === "broadcast" ? "bg-km-raised text-km-text" : "text-km-dim hover:text-km-text",
          )}
        >
          <Radio className="h-3 w-3" />
          Broadcast
        </button>
      </div>

      {mode === "edit" && (
        <>
          <div className="h-[22px] w-px bg-km-border" />

          <Input
        data-no-drag
        style={NO_DRAG}
        value={settings.name}
        onChange={(e) => editor().updateSettings({ name: e.target.value })}
        className="h-8 w-56 border-transparent bg-transparent px-2 text-[12px] font-semibold text-km-text hover:border-km-border focus-visible:border-km-border focus-visible:ring-0"
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
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button
              type="button"
              title="Rebuild the demo project"
              className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-km-dim transition hover:bg-km-raised hover:text-km-text"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Demo
            </button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Rebuild the demo project?</AlertDialogTitle>
              <AlertDialogDescription>
                This replaces everything on the canvas with a fresh demo and discards your current work. Save first if you want to keep it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={() => {
                  resetActivityTracking();
                  void resetToDemo();
                }}
              >
                Rebuild demo
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

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
          className="h-9 gap-2 rounded-lg bg-km-accent px-4 text-[12px] font-bold text-km-bg hover:bg-km-accent2"
        >
          <Upload className="h-3.5 w-3.5" />
          {exporting ? "Exporting…" : "Export"}
        </Button>
      </div>
        </>
      )}

      {/* Image mode: just the document name and the agent, no video controls. */}
      {mode === "image" && (
        <>
          <div className="mx-1 h-5 w-px bg-km-border" />

          <Input
            data-no-drag
            style={NO_DRAG}
            value={settings.name}
            onChange={(e) => editor().updateSettings({ name: e.target.value })}
            className="h-7 w-48 border-transparent bg-transparent px-2 text-[12.5px] text-km-text hover:border-km-border focus-visible:border-km-border focus-visible:ring-0"
            aria-label="Image name"
          />

          <div data-no-drag style={NO_DRAG} className="ml-auto flex items-center gap-2">
            <button
              type="button"
              title="Connect an AI agent over MCP"
              onClick={onAgent}
              className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-km-dim transition hover:bg-km-raised hover:text-km-text"
            >
              <Bot className="h-3.5 w-3.5" />
              Agent
            </button>
          </div>
        </>
      )}

      {/* In broadcast mode the editor controls (and their ml-auto spacer) are
          gone, so the window controls need their own right-alignment spacer. */}
      {mode === "broadcast" && <div className="ml-auto" />}

      <UpdateIndicator />

      <SystemStats />

      {windowControls() && <div className="mx-1 h-5 w-px bg-km-border" />}

      <WindowControls />
    </header>
  );
}
