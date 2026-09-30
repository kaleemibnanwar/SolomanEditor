/**
 * The editor shell.
 *
 * Owns the app-level wiring: the dark palette, the demo boot, playback, keyboard
 * shortcuts, the export queue pump and the stage → panel → timeline layout.
 */
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import octoLogo from "@/assets/octo-logo.png";
import BroadcastStudio from "@/components/broadcast/BroadcastStudio";
import ImageStudio from "@/components/image/ImageStudio";
import AgentPanel from "@/components/editor/AgentPanel";
import { DragGhost } from "@/components/editor/DragGhost";
import { ExportDialog } from "@/components/editor/ExportDialog";
import { ExportMonitor } from "@/components/editor/ExportMonitor";
import Inspector from "@/components/editor/Inspector";
import { ProjectsDialog } from "@/components/editor/ProjectsDialog";
import { SettingsDialog } from "@/components/editor/SettingsDialog";
import { VoiceoverMonitor } from "@/components/editor/VoiceoverMonitor";
import AssetLibrary from "@/components/editor/library/AssetLibrary";
import Stage from "@/components/editor/Stage";
import Timeline from "@/components/editor/Timeline";
import TopBar from "@/components/editor/TopBar";
import Transport from "@/components/editor/Transport";
import { Progress } from "@/components/ui/progress";
import { resetToDemo } from "@/lib/demo";
import { pumpExportQueue } from "@/lib/exporter";
import { installHttpHost } from "@/lib/mcp/host";
import { installAgentAccess } from "@/lib/mcp/session";
import { installAutosave, listProjects, openProject } from "@/lib/projects";
import { pumpVoiceoverQueue } from "@/lib/voiceover";
import { editor, useEditor } from "@/store/editorStore";
import { usePlayback } from "@/hooks/usePlayback";
import { saveProjectNow } from "@/hooks/useProjectLibrary";
import { useEditorShortcuts } from "@/hooks/useShortcuts";

export default function EditorShell() {
  const [exportOpen, setExportOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [boot, setBoot] = useState({ message: "Warming up…", progress: 0 });
  /** The mode lives in the store so the MCP server can read it to pick its catalogue. */
  const mode = useEditor((s) => s.ui.mode);
  const booting = useEditor((s) => s.ui.booting);
  /** Lives in the store because the media panel opens it when a key is missing. */
  const settingsOpen = useEditor((s) => s.ui.settingsOpen);
  const projectsOpen = useEditor((s) => s.ui.projectsOpen);
  const exporting = useEditor((s) => s.ui.exporting);
  const queued = useEditor((s) => s.exportJobs.some((job) => job.status === "queued"));
  const voiceoverQueued = useEditor((s) => s.voiceoverJobs.some((job) => job.status === "queued"));

  const booted = useRef(false);

  usePlayback();
  useEditorShortcuts({ onExport: () => setExportOpen(true), onSave: () => void saveProjectNow() });

  /** The image mode is a single frame: entering it freezes playback at the origin. */
  useEffect(() => {
    if (mode === "image") {
      editor().pause();
      editor().setCurrentTime(0);
    }
  }, [mode]);

  /**
   * Radix renders popovers and dialogs into document.body, outside this subtree,
   * so the theme class has to live on the document element.
   */
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("dark");
    return () => root.classList.remove("dark");
  }, []);

  /**
   * Publish the MCP session as soon as the editor exists. Both halves start here
   * rather than when the panel opens: a host that has to wait for someone to click
   * a button is not connected to the editor. `installHttpHost` attaches to the
   * desktop app's listener when there is one, and otherwise probes for the dev
   * server's — either way an AI tool gets a URL to point at.
   */
  useEffect(() => {
    installAgentAccess();
    installHttpHost();
  }, []);

  /**
   * Autosave is a store subscription, so it is installed once for the life of
   * the app rather than tied to any component's mount cycle.
   */
  useEffect(() => installAutosave(), []);

  /** Boot the last edited project or a demo project once, with progress on the overlay. */
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      try {
        const projects = await listProjects();
        if (projects.length > 0) {
          setBoot({ message: "Loading project…", progress: 0.5 });
          await openProject(projects[0].id);
          editor().setUi({ booting: false });
          return;
        }
      } catch (error) {
        console.error("Could not restore the last project; loading the demo instead.", error);
        toast.warning("Your last project could not be opened", {
          description: "Octo Cut loaded the demo so you can keep working. Your saved project was not changed.",
        });
      }
      void resetToDemo((message, progress) => setBoot({ message, progress }));
    })();
  }, []);

  /** Exports run one at a time, driven from here so the UI never blocks. */
  useEffect(() => {
    if (queued) void pumpExportQueue();
  }, [queued]);

  /** Same shape as the export queue: one voiceover job at a time, in the background. */
  useEffect(() => {
    if (voiceoverQueued) void pumpVoiceoverQueue();
  }, [voiceoverQueued]);

  /** A dropped file outside the stage would otherwise navigate the page away. */
  useEffect(() => {
    const stop = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  /** Realtime capture cannot survive a background tab — warn before it dies. */
  useEffect(() => {
    if (!exporting) return;
    const onVisibility = () => {
      if (document.hidden) {
        toast.warning("The export is still running", {
          description: "Keep this tab in the foreground — a background tab is suspended and the render is stopped.",
        });
      }
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [exporting]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-km-bg text-km-text">
      <TopBar
        onExport={() => setExportOpen(true)}
        onAgent={() => setAgentOpen(true)}
        onProjects={() => editor().setUi({ projectsOpen: true })}
        mode={mode}
      />

      {mode === "edit" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            <AssetLibrary />

            <main className="flex min-w-0 flex-1 flex-col">
              <Stage />
              <Transport />
            </main>

            <Inspector />
          </div>

          <Timeline />
        </div>
      ) : mode === "image" ? (
        <ImageStudio />
      ) : (
        <BroadcastStudio />
      )}

      <ExportMonitor onOpen={() => setExportOpen(true)} />
      <VoiceoverMonitor />
      <DragGhost />
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      <AgentPanel open={agentOpen} onOpenChange={setAgentOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={(open) => editor().setUi({ settingsOpen: open })} />
      <ProjectsDialog open={projectsOpen} onOpenChange={(open) => editor().setUi({ projectsOpen: open })} />

      {booting && <BootOverlay message={boot.message} progress={boot.progress} />}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Boot overlay
 * ------------------------------------------------------------------ */

function BootOverlay({ message, progress }: { message: string; progress: number }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-km-bg">
      <img src={octoLogo} alt="Octo Cut" className="h-20 w-20 object-contain drop-shadow-lg" />

      <div className="text-center">
        <h1 className="text-[15px] font-semibold tracking-tight">Octo Cut</h1>
        <p className="mt-1 text-[12px] text-km-dim">{message}</p>
      </div>

      <Progress
        value={Math.round(Math.max(0, Math.min(1, progress)) * 100)}
        className="h-1.5 w-56 bg-km-raised [&>div]:bg-km-accent"
      />

      <p className="flex items-center gap-1.5 text-[10.5px] text-km-faint">
        <Loader2 className="h-3 w-3 animate-spin" />
        Generating demo media in the browser — no downloads needed
      </p>
    </div>
  );
}
