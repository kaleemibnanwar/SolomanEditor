/**
 * THE PROJECTS DIALOG — start something new, or come back to something old.
 *
 * A scroll area showing the projects you have already saved, with a "New
 * project" button at the top.
 *
 * What a saved project shows is STATUS — and it is worth saying plainly, in the
 * header, where these records live: in this browser's own storage, alongside
 * their media. There is nothing to log into and nothing leaves the machine, so
 * the one thing that can go wrong is the storage itself being unavailable
 * (`storagePersists()`), which the note under the header reports rather than
 * leaving the user to find out after a reload.
 */
import type { CSSProperties } from "react";
import {
  Copy,
  FolderOpen,
  ImageOff,
  Info,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useProjectLibrary } from "@/hooks/useProjectLibrary";
import { type ProjectStatus, type ProjectSummary } from "@/lib/projects";

const STATUS: Record<ProjectStatus, { label: string; className: string }> = {
  empty: { label: "Empty", className: "border-km-border text-km-faint" },
  processing: { label: "In processing", className: "border-amber-400/40 text-amber-300" },
  ready: { label: "Ready", className: "border-emerald-400/40 text-emerald-300" },
};

/** Short and honest: "3 h ago" is all a card needs to place a project in time. */
function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(timestamp).toLocaleDateString();
}

const seconds = (value: number) => `${value >= 10 ? Math.round(value) : value.toFixed(1)}s`;

function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function ProjectsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const {
    summaries,
    loading,
    persistent,
    busy,
    currentId,
    openSaved,
    duplicate,
    remove,
    saveCurrent,
    saveCopy,
    startNew,
  } = useProjectLibrary(open);

  const working = busy !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-3xl flex-col gap-0 overflow-hidden border-km-border bg-km-panel p-0 text-km-text">
        <DialogHeader className="shrink-0 border-b border-km-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold text-km-text">
            <FolderOpen className="h-4 w-4 text-km-accent" />
            Projects
          </DialogTitle>
          <DialogDescription className="text-[11.5px] leading-relaxed text-km-faint">
            Work is saved here as you edit. A project is stored with its own media, in this browser —
            nothing is uploaded, and nothing needs an account.
          </DialogDescription>
        </DialogHeader>

        <div className="km-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {persistent ? null : (
            <p className="flex items-start gap-1.5 rounded border border-km-border bg-km-track/50 px-2.5 py-2 text-[10.5px] leading-snug text-km-faint">
              <Info className="mt-px h-3 w-3 shrink-0" />
              <span>
                This page can't hold on to stored projects, so anything saved here lasts for this
                session only. Everything still works — it just won't be here after a reload.
              </span>
            </p>
          )}

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-km-text">
                <Plus className="h-3.5 w-3.5 text-km-accent" />
                Get started
              </h3>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => void startNew()}
                disabled={working}
                className="h-8 gap-1.5 border-km-border bg-km-track/40 text-[11.5px] text-km-text hover:bg-km-raised disabled:opacity-40"
              >
                <Plus className="h-3.5 w-3.5" />
                New blank project
              </Button>
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-baseline gap-2">
              <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-km-text">
                <FolderOpen className="h-3.5 w-3.5 text-km-accent" />
                Your projects
              </h3>
              <span className="text-[10.5px] text-km-faint">
                {summaries.length === 0
                  ? "Nothing saved yet — start a new project and it will appear here."
                  : `${summaries.length} ${summaries.length === 1 ? "project" : "projects"}`}
              </span>
            </div>

            {loading ? (
              <div className="grid place-items-center py-8 text-km-faint">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : summaries.length === 0 ? (
              <p className="rounded-lg border border-dashed border-km-border py-6 text-center text-[11px] text-km-faint">
                No projects yet. Create a new one to get started.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {summaries.map((summary) => (
                  <ProjectCard
                    key={summary.id}
                    summary={summary}
                    isCurrent={summary.id === currentId}
                    busy={busy}
                    onOpen={() => void openSaved(summary.id)}
                    onDuplicate={() => void duplicate(summary.id)}
                    onDelete={() => void remove(summary.id)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>

        <DialogFooter className="shrink-0 border-t border-km-border px-5 py-3">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => void saveCurrent()}
              disabled={working || !currentId}
              className="h-7 gap-1 border-km-border text-[10.5px] text-km-dim hover:bg-km-raised hover:text-km-text disabled:opacity-40"
            >
              <Save className="h-3 w-3" />
              Save current
            </Button>
            <Button
              variant="outline"
              onClick={() => void saveCopy()}
              disabled={working || !currentId}
              className="h-7 gap-1 border-km-border text-[10.5px] text-km-dim hover:bg-km-raised hover:text-km-text disabled:opacity-40"
            >
              <Copy className="h-3 w-3" />
              Save a copy
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ *
 * Project card
 * ------------------------------------------------------------------ */

function ProjectCard({
  summary,
  isCurrent,
  busy,
  onOpen,
  onDuplicate,
  onDelete,
}: {
  summary: ProjectSummary;
  isCurrent: boolean;
  busy: string | null;
  onOpen: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const working = busy?.endsWith(`:${summary.id}`) ?? false;
  const status = STATUS[summary.status];

  return (
    <article className="flex items-start gap-3 rounded-lg border border-km-border bg-km-track/40 p-2.5 transition hover:border-km-border hover:bg-km-raised/60">
      <div className="relative h-[52px] w-[92px] shrink-0 overflow-hidden rounded border border-km-border bg-black/50">
        {summary.poster ? (
          <img src={summary.poster} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : (
          <span className="grid h-full w-full place-items-center text-km-faint">
            <ImageOff className="h-4 w-4" />
          </span>
        )}
        {working && (
          <span className="absolute inset-0 grid place-items-center bg-black/60">
            <Loader2 className="h-4 w-4 animate-spin text-white" />
          </span>
        )}
        {isCurrent && (
          <span className="absolute left-1 top-1 rounded bg-km-accent/90 px-1 py-px text-[8.5px] font-semibold text-white">
            OPEN
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h4 className="truncate text-[12.5px] font-semibold text-km-text">{summary.name}</h4>
          <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9.5px] ${status.className}`}>
            {status.label}
          </span>
        </div>

        <p className="mt-0.5 truncate text-[10.5px] text-km-faint">
          {summary.clipCount} {summary.clipCount === 1 ? "clip" : "clips"} · {seconds(summary.duration)} ·{" "}
          {summary.trackCount} {summary.trackCount === 1 ? "row" : "rows"} · {relativeTime(summary.updatedAt)}
        </p>

        <div className="mt-1.5 flex items-center gap-3 text-[9.5px] text-km-faint">
          <span>
            {summary.canvas.width}×{summary.canvas.height} @ {summary.canvas.fps}
          </span>
          {summary.exported && <span>· Exported: {fileSize(summary.exported.size)}</span>}
        </div>

        <div className="mt-2 flex items-center gap-1.5">
          <Button
            variant="ghost"
            onClick={onOpen}
            disabled={busy !== null}
            className="h-6 gap-1 px-2 text-[10.5px] text-km-dim hover:bg-km-panel2 hover:text-km-text disabled:opacity-40"
          >
            <FolderOpen className="h-3 w-3" />
            {isCurrent ? "Switch to" : "Open"}
          </Button>
          <Button
            variant="ghost"
            onClick={onDuplicate}
            disabled={busy !== null}
            className="h-6 gap-1 px-2 text-[10.5px] text-km-dim hover:bg-km-panel2 hover:text-km-text disabled:opacity-40"
          >
            <Copy className="h-3 w-3" />
            Duplicate
          </Button>
          <Button
            variant="ghost"
            onClick={onDelete}
            disabled={busy !== null || isCurrent}
            className="h-6 gap-1 px-2 text-[10.5px] text-km-dim hover:bg-red-500/15 hover:text-red-300 disabled:opacity-40"
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </Button>
        </div>
      </div>
    </article>
  );
}
