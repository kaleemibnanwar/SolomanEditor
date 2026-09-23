/**
 * A small non-modal progress pill.
 *
 * Export runs for as long as the clip does, so the modal dialog must not be the
 * only place progress lives — this floats over the editor so the user can watch
 * the render in the preview, exactly as the engine intends.
 */
import { Ban, Loader2 } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cancelExportJob } from "@/lib/exporter";
import { cn } from "@/lib/utils";
import { useEditor } from "@/store/editorStore";
import type { ExportJob } from "@/types/editor";

const isActive = (job: ExportJob) =>
  job.status === "queued" || job.status === "preparing" || job.status === "rendering" || job.status === "encoding";

export function ExportMonitor({ onOpen }: { onOpen: () => void }) {
  const job = useEditor((s) => s.exportJobs.find(isActive));
  const queued = useEditor((s) => s.exportJobs.filter(isActive).length);

  if (!job) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-72 rounded-lg border border-km-border bg-km-panel/95 p-3 shadow-2xl backdrop-blur">
      <div className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-km-accent" />
        <span className="text-[11.5px] font-medium text-km-text">
          {job.status === "queued" ? "Waiting in the queue" : "Exporting"}
        </span>
        <span className="ml-auto font-mono text-[10.5px] text-km-faint">{Math.round(job.progress * 100)}%</span>
      </div>

      <Progress
        value={Math.round(job.progress * 100)}
        className={cn("mt-2 h-1.5 bg-km-raised", "[&>div]:bg-km-accent")}
      />

      <div className="mt-2 flex items-center gap-2">
        <span className="truncate text-[10.5px] text-km-dim">{job.message}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onOpen}
            className="flex h-6 items-center rounded border border-km-border px-2 text-[10.5px] text-km-dim transition hover:bg-km-raised hover:text-km-text"
          >
            Details
          </button>
          <button
            type="button"
            title="Stop this export"
            onClick={() => cancelExportJob(job.id)}
            className="flex h-6 w-6 items-center justify-center rounded border border-km-border text-km-faint transition hover:bg-km-raised hover:text-red-300"
          >
            <Ban className="h-3 w-3" />
          </button>
        </div>
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-km-faint">
        {queued > 1 ? `${queued} jobs in the queue · ` : ""}
        Keep this tab in the foreground — a background tab is suspended and the render stops.
      </p>
    </div>
  );
}
