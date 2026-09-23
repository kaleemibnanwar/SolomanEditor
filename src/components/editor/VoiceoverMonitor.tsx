/**
 * A small non-modal progress pill for the voiceover queue — same shape as
 * `ExportMonitor.tsx`, for the same reason: this runs in the background while
 * the editor stays usable, so progress needs to live outside any dialog.
 */
import { Ban, Loader2, Sparkles } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { editor, useEditor } from "@/store/editorStore";
import type { VoiceoverJob } from "@/types/editor";

const isActive = (job: VoiceoverJob) =>
  job.status === "queued" || job.status === "synthesizing" || job.status === "fetching-broll" || job.status === "assembling";

const STATUS_LABEL: Record<VoiceoverJob["status"], string> = {
  queued: "Waiting in the queue",
  synthesizing: "Narrating",
  "fetching-broll": "Finding B-roll",
  assembling: "Assembling",
  done: "Done",
  error: "Failed",
  canceled: "Canceled",
};

export function VoiceoverMonitor() {
  const job = useEditor((s) => s.voiceoverJobs.find(isActive));
  const queued = useEditor((s) => s.voiceoverJobs.filter(isActive).length);

  if (!job) return null;

  return (
    <div className="fixed bottom-4 right-[20rem] z-40 w-72 rounded-lg border border-km-border bg-km-panel/95 p-3 shadow-2xl backdrop-blur">
      <div className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-km-accent" />
        <span className="text-[11.5px] font-medium text-km-text">{STATUS_LABEL[job.status]}</span>
        <span className="ml-auto font-mono text-[10.5px] text-km-faint">{Math.round(job.progress * 100)}%</span>
      </div>

      <Progress value={Math.round(job.progress * 100)} className={cn("mt-2 h-1.5 bg-km-raised", "[&>div]:bg-km-accent")} />

      <div className="mt-2 flex items-center gap-2">
        <span className="truncate text-[10.5px] text-km-dim">{job.message}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {job.status === "queued" && (
            <button
              type="button"
              title="Remove from the queue"
              onClick={() => editor().removeVoiceoverJob(job.id)}
              className="flex h-6 w-6 items-center justify-center rounded border border-km-border text-km-faint transition hover:bg-km-raised hover:text-red-300"
            >
              <Ban className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <p className="mt-2 flex items-center gap-1.5 text-[10px] leading-relaxed text-km-faint">
        <Sparkles className="h-3 w-3 shrink-0" />
        {queued > 1 ? `${queued} voiceovers queued · ` : ""}
        On-device narration, captions and B-roll — no cloud calls.
      </p>
    </div>
  );
}
