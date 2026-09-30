/**
 * THE PROJECTS DIALOG — start something new, or come back to something old.
 *
 * One scroll area with two sections, in the order you actually need them:
 * templates first, because a blank timeline is the harder problem, then the
 * projects you have already saved.
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
  LayoutTemplate,
  Loader2,
  Monitor,
  Music,
  Plus,
  Save,
  Smartphone,
  Square,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useProjectLibrary } from "@/hooks/useProjectLibrary";
import { BACKGROUND_PRESETS } from "@/lib/library";
import { type ProjectStatus, type ProjectSummary } from "@/lib/projects";
import { templateSummaries } from "@/lib/templates";

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

/** The template's own backdrop, so a card looks like the thing it opens. */
function swatch(background: string): CSSProperties {
  const preset = BACKGROUND_PRESETS.find((entry) => entry.id === background);
  return { background: preset?.project?.backgroundGradient ?? preset?.project?.backgroundColor ?? "#0b0b14" };
}

const ASPECT_ICON = { "16:9": Monitor, "9:16": Smartphone, "1:1": Square } as const;

export function ProjectsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const {
    summaries,
    userTemplates,
    loading,
    persistent,
    busy,
    currentId,
    createTemplate,
    openSnapshotTemplate,
    openSaved,
    duplicate,
    remove,
    removeTemplate,
    saveCurrent,
    saveCopy,
    saveAsTemplate,
    startNew,
  } = useProjectLibrary(open);

  const templates = templateSummaries();
  const working = busy !== null;

  /** A template is a fork in the road, so a successful one closes the dialog. */
  const pickTemplate = async (id: string) => {
    const result = await createTemplate(id);
    if (result.ok) onOpenChange(false);
  };

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
            <div className="mb-2 flex items-baseline gap-2">
              <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-km-text">
                <LayoutTemplate className="h-3.5 w-3.5 text-km-accent" />
                Start from a template
              </h3>
              <span className="text-[10.5px] text-km-faint">
                A structure to edit into — beats on the main layer, with a labelled row under each one.
              </span>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {templates.map((template) => {
                const Icon = ASPECT_ICON[template.aspect];
                const building = busy === `template:${template.id}`;
                return (
                  <button
                    key={template.id}
                    type="button"
                    title={template.use}
                    disabled={working}
                    onClick={() => void pickTemplate(template.id)}
                    className="relative flex flex-col items-stretch gap-2 overflow-hidden rounded-lg border border-km-border bg-km-track/40 p-2.5 text-left transition hover:border-km-accent/60 hover:bg-km-raised disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {/* The channel colour — the same accent the built project's cards use. */}
                    <span
                      aria-hidden
                      className="absolute inset-x-0 top-0 h-[3px]"
                      style={{ background: `linear-gradient(90deg, ${template.accent} 0%, ${template.accent} 42%, transparent 100%)` }}
                    />
                    <div className="flex items-start justify-between gap-2">
                      <span
                        className="grid h-8 w-8 place-items-center rounded-md border border-km-border text-white/90"
                        style={swatch(template.background)}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      {building ? (
                        <Loader2 className="mt-1 h-3 w-3 animate-spin text-km-accent" />
                      ) : (
                        <span className="rounded-full border border-km-border px-1.5 py-0.5 text-[9.5px] text-km-faint">
                          {template.aspect}
                        </span>
                      )}
                    </div>
                    <div>
                      <p className="text-[12px] font-semibold text-km-text">{template.name}</p>
                      <p className="mt-0.5 text-[10.5px] leading-snug text-km-faint">{template.blurb}</p>
                    </div>
                    <p className="mt-auto flex items-center gap-1.5 text-[10px] text-km-faint">
                      <span>{template.beats.length} beats</span>
                      <span>·</span>
                      <span>{seconds(template.seconds)}</span>
                      {template.music && <Music className="h-3 w-3" />}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-baseline gap-2">
              <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-km-text">
                <FolderOpen className="h-3.5 w-3.5 text-km-accent" />
                Your projects
              </h3>
              <span className="text-[10.5px] text-km-faint">
                {loading && !summaries.length ? "Reading…" : `${summaries.length} saved`}
              </span>
            </div>

            {loading && !summaries.length ? (
              <p className="flex items-center gap-1.5 rounded-lg border border-km-border bg-km-track/40 px-3 py-4 text-[11px] text-km-faint">
                <Loader2 className="h-3 w-3 animate-spin" />
                Reading the library…
              </p>
            ) : summaries.length ? (
              <div className="space-y-1.5">
                {summaries.map((summary) => (
                  <ProjectCard
                    key={summary.id}
                    summary={summary}
                    current={summary.id === currentId}
                    busy={busy}
                    onOpen={() => void openSaved(summary.id)}
                    onDuplicate={() => void duplicate(summary.id)}
                    onDelete={() => void remove(summary.id)}
                  />
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-km-border px-3 py-4 text-[11px] leading-relaxed text-km-faint">
                Nothing here yet. A project is saved as soon as it has a clip on the timeline — or pick
                a template above and it lands here straight away.
              </p>
            )}
          </section>

          {userTemplates.length > 0 && (
            <section>
              <div className="mb-2 flex items-baseline gap-2">
                <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-km-text">
                  <LayoutTemplate className="h-3.5 w-3.5 text-purple-400" />
                  Your templates
                </h3>
                <span className="text-[10.5px] text-km-faint">
                  {userTemplates.length} saved
                </span>
              </div>
              <div className="space-y-1.5">
                {userTemplates.map((template) => (
                  <UserTemplateCard
                    key={template.id}
                    template={template}
                    busy={busy}
                    onOpen={() => {
                      void openSnapshotTemplate(template.id);
                      onOpenChange(false);
                    }}
                    onDelete={() => void removeTemplate(template.id)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t border-km-border px-5 py-3">
          <Button
            variant="ghost"
            onClick={() => void startNew()}
            disabled={working}
            className="mr-auto h-8 gap-1.5 border border-km-border px-3 text-[12px] text-km-dim hover:bg-km-raised hover:text-km-text"
          >
            {busy === "new" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            New project
          </Button>

          <Button
            variant="ghost"
            onClick={() => void saveAsTemplate()}
            disabled={working}
            className="h-8 gap-1.5 border border-km-border px-3 text-[12px] text-km-dim hover:bg-km-raised hover:text-km-text"
          >
            <LayoutTemplate className="h-3.5 w-3.5" />
            Save as template
          </Button>

          <Button
            variant="ghost"
            onClick={() => void saveCopy()}
            disabled={working}
            className="h-8 gap-1.5 border border-km-border px-3 text-[12px] text-km-dim hover:bg-km-raised hover:text-km-text"
          >
            <Copy className="h-3.5 w-3.5" />
            Save as copy
          </Button>

          <Button
            onClick={() => void saveCurrent()}
            disabled={working}
            className="h-8 gap-1.5 bg-km-accent px-3 text-[12px] font-medium text-white hover:bg-km-accent2"
          >
            {busy === "save" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save now
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ *
 * A saved project
 * ------------------------------------------------------------------ */

function ProjectCard({
  summary,
  current,
  busy,
  onOpen,
  onDuplicate,
  onDelete,
}: {
  summary: ProjectSummary;
  current: boolean;
  busy: string | null;
  onOpen: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const status = STATUS[summary.status];
  const working = busy?.endsWith(`:${summary.id}`) ?? false;
  const meta = [
    `${summary.clipCount} ${summary.clipCount === 1 ? "clip" : "clips"}`,
    `${summary.trackCount} ${summary.trackCount === 1 ? "row" : "rows"}`,
    seconds(summary.duration),
    `saved ${relativeTime(summary.updatedAt)}`,
    summary.exported ? `rendered ${fileSize(summary.exported.size)}` : null,
  ].filter(Boolean);

  return (
    <article className="flex items-start gap-3 rounded-lg border border-km-border bg-km-track/40 p-2.5 transition hover:border-km-border hover:bg-km-raised/60">
      <div className="relative h-[52px] w-[92px] shrink-0 overflow-hidden rounded border border-km-border bg-black/50">
        {summary.poster ? (
          <img src={summary.poster} alt="" className="h-full w-full object-cover" />
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
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h4 className="truncate text-[12.5px] font-semibold text-km-text">{summary.name}</h4>
          <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9.5px] ${status.className}`}>
            {status.label}
          </span>
          {current && (
            <span className="shrink-0 rounded-full border border-km-accent/50 px-1.5 py-0.5 text-[9.5px] text-km-accent">
              Open
            </span>
          )}
        </div>

        <p className="mt-0.5 truncate text-[10.5px] text-km-faint">{meta.join(" · ")}</p>

        <div className="mt-2 flex items-center gap-1.5">
          <Button
            variant="ghost"
            onClick={onOpen}
            disabled={busy !== null || current}
            className="h-6 gap-1 px-2 text-[10.5px] text-km-dim hover:bg-km-panel2 hover:text-km-text disabled:opacity-40"
          >
            <FolderOpen className="h-3 w-3" />
            Open
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
            disabled={busy !== null || current}
            title={current ? "The open project cannot be deleted" : "Delete this project"}
            className="h-6 gap-1 px-2 text-[10.5px] text-km-dim hover:bg-red-500/15 hover:text-red-300 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-km-dim"
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </Button>
        </div>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ *
 * A saved user template
 * ------------------------------------------------------------------ */

function UserTemplateCard({
  template,
  busy,
  onOpen,
  onDelete,
}: {
  template: import("@/lib/userTemplates").UserTemplate;
  busy: string | null;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const working = busy?.endsWith(`:${template.id}`) ?? false;

  return (
    <article className="flex items-start gap-3 rounded-lg border border-km-border bg-km-track/40 p-2.5 transition hover:border-km-border hover:bg-km-raised/60">
      <div className="relative h-[52px] w-[92px] shrink-0 overflow-hidden rounded border border-km-border bg-black/50">
        <span
          className="grid h-full w-full place-items-center"
          style={swatch(template.project.settings.backgroundKind === "color" ? template.project.settings.backgroundColor ?? "" : template.project.settings.backgroundGradient ?? "")}
        >
          <LayoutTemplate className="h-4 w-4 text-white/70" />
        </span>
        {working && (
          <span className="absolute inset-0 grid place-items-center bg-black/60">
            <Loader2 className="h-4 w-4 animate-spin text-white" />
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h4 className="truncate text-[12.5px] font-semibold text-km-text">{template.name}</h4>
          <span className="shrink-0 rounded-full border border-purple-400/40 px-1.5 py-0.5 text-[9.5px] text-purple-300">
            Snapshot
          </span>
        </div>

        <p className="mt-0.5 truncate text-[10.5px] text-km-faint">
          {template.blurb || "A saved project snapshot"} · {template.project.trackIds.length} rows · saved {relativeTime(template.createdAt)}
        </p>

        <div className="mt-2 flex items-center gap-1.5">
          <Button
            variant="ghost"
            onClick={onOpen}
            disabled={busy !== null}
            className="h-6 gap-1 px-2 text-[10.5px] text-km-dim hover:bg-km-panel2 hover:text-km-text disabled:opacity-40"
          >
            <FolderOpen className="h-3 w-3" />
            Start from here
          </Button>
          <Button
            variant="ghost"
            onClick={onDelete}
            disabled={busy !== null}
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
