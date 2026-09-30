/**
 * The export dialog.
 *
 * Rendering is realtime (see lib/exporter.ts), so this dialog is honest about
 * that: it explains that the preview doubles as the render monitor, and it
 * shows the queue so several renders can be lined up without blocking the UI.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, Ban, Download, FileText, Film, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { NumberField, SegmentedField, SelectField, SliderField, ToggleField } from "@/components/editor/fields";
import { cancelExportJob, exportSupport } from "@/lib/exporter";
import { projectDuration } from "@/lib/project";
import { exportSrt, exportVtt } from "@/lib/subtitles";
import { clamp, formatBytes, formatDurationLong, formatTimecode } from "@/lib/time";
import { captionsTrackId } from "@/lib/tracks";
import { cn } from "@/lib/utils";
import { editor, useEditor } from "@/store/editorStore";
import type { ExportJob, ExportOptions } from "@/types/editor";

function downloadText(text: string, fileName: string, mimeType: string) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type RangeMode = "full" | "tail" | "custom";

const RANGE_MODES: { value: RangeMode; label: string }[] = [
  { value: "full", label: "Whole project" },
  { value: "tail", label: "Playhead → end" },
  { value: "custom", label: "Custom" },
];

const STATUS_META: Record<ExportJob["status"], { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "bg-km-raised text-km-dim" },
  preparing: { label: "Preparing", tone: "bg-km-accent/15 text-km-accent" },
  rendering: { label: "Rendering", tone: "bg-km-accent/15 text-km-accent" },
  encoding: { label: "Finishing", tone: "bg-km-accent/15 text-km-accent" },
  done: { label: "Ready", tone: "bg-emerald-500/15 text-emerald-300" },
  error: { label: "Failed", tone: "bg-red-500/15 text-red-300" },
  canceled: { label: "Canceled", tone: "bg-km-raised text-km-faint" },
};

const isActive = (job: ExportJob) =>
  job.status === "queued" || job.status === "preparing" || job.status === "rendering" || job.status === "encoding";

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

function defaultFileName(projectName: string) {
  const base = (projectName || "octo-cut")
    .trim()
    .toLowerCase()
    .replace(/[^\w\-. ]+/g, "")
    .replace(/\s+/g, "-");
  const stamp = new Date().toISOString().slice(0, 10);
  return `${base || "octo-cut"}-${stamp}`;
}

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

function ExportPanel({ onClose }: { onClose: () => void }) {
  const settings = useEditor((s) => s.project.settings);
  const currentTime = useEditor((s) => s.currentTime);
  const duration = useEditor((s) => projectDuration(s.project));
  const jobs = useEditor((s) => s.exportJobs);
  const support = useMemo(() => exportSupport(), []);

  /* ---- output size: every preset keeps the project's aspect ratio ---- */
  const sizes = useMemo(() => {
    const tags: Record<number, string> = { 1920: "Full HD", 1280: "HD", 854: "SD", 640: "Low" };
    const landscape = settings.width >= settings.height;
    const aspect = settings.width / settings.height;
    const longSide = Math.max(settings.width, settings.height);
    return Array.from(new Set([longSide, 1920, 1280, 854, 640]))
      .filter((n) => n <= longSide)
      .sort((a, b) => b - a)
      .map((n) => {
        const width = landscape ? n : even(n * aspect);
        const height = landscape ? even(n / aspect) : n;
        return { value: String(n), width, height, label: `${width}×${height} · ${tags[n] ?? `${n}p`}` };
      });
  }, [settings.width, settings.height]);

  const [sizeId, setSizeId] = useState(sizes[0].value);
  const size = sizes.find((s) => s.value === sizeId) ?? sizes[0];

  const fpsOptions = useMemo(
    () =>
      Array.from(new Set([24, 30, settings.fps, 60]))
        .filter((f) => f <= 60)
        .sort((a, b) => a - b)
        .map((f) => ({ value: String(f), label: `${f} fps${f === settings.fps ? " · project" : ""}` })),
    [settings.fps],
  );
  const [fpsId, setFpsId] = useState(String(settings.fps));
  const fps = Number(fpsId) || settings.fps;

  const [bitrate, setBitrate] = useState(8);

  const formatOptions = useMemo(() => {
    const options: { value: ExportOptions["format"]; label: string }[] = [
      { value: "auto", label: `Automatic (${support.webm ? "WebM" : support.mp4 ? "MP4" : "none"})` },
    ];
    if (support.mp4) options.push({ value: "mp4", label: "MP4 · H.264" });
    if (support.webm) options.push({ value: "webm", label: "WebM · VP9" });
    return options;
  }, [support]);
  const [format, setFormat] = useState<ExportOptions["format"]>("auto");
  const [includeAudio, setIncludeAudio] = useState(true);
  const [fileName, setFileName] = useState(() => defaultFileName(settings.name));

  /* ---- range ---- */
  const [rangeMode, setRangeMode] = useState<RangeMode>("full");
  const [customStart, setCustomStart] = useState(0);
  const [customEnd, setCustomEnd] = useState(() => Math.max(0.2, duration));

  const range = useMemo(() => {
    if (rangeMode === "full") return { start: 0, end: Math.max(0.2, duration) };
    if (rangeMode === "tail") {
      const start = clamp(currentTime, 0, Math.max(0, duration - 0.5));
      return { start, end: Math.max(start + 0.2, duration) };
    }
    const start = clamp(customStart, 0, Math.max(0, duration - 0.2));
    const end = Math.max(start + 0.2, Math.min(customEnd, Math.max(duration, start + 0.2)));
    return { start, end };
  }, [rangeMode, currentTime, customStart, customEnd, duration]);

  const span = range.end - range.start;
  const estimatedSize = ((bitrate * 1_000_000) / 8) * span;

  const enqueue = () => {
    if (!support.supported) {
      toast.error("This browser cannot record video", {
        description: "MediaRecorder is unavailable. Try Chrome, Edge or another Chromium browser.",
      });
      return;
    }
    editor().enqueueExport({
      width: size.width,
      height: size.height,
      fps,
      bitrateMbps: bitrate,
      rangeStart: range.start,
      rangeEnd: range.end,
      includeAudio,
      format,
      fileName: fileName.trim() || "octo-cut-export",
    });
    toast.success("Added to the export queue", {
      description: `${size.width}×${size.height} · ${formatDurationLong(span)} · about ${formatBytes(estimatedSize)}`,
    });
  };

  const hasAudioLayers = useEditor((s) =>
    Object.values(s.project.layers).some((l) => (l.type === "audio" || l.type === "video") && !!l.assetId),
  );

  return (
    <>
      <DialogHeader className="shrink-0 border-b border-km-border px-5 py-4">
        <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold text-km-text">
          <Film className="h-4 w-4 text-km-accent" />
          Export project
        </DialogTitle>
        <DialogDescription className="text-[11.5px] leading-relaxed text-km-faint">
          Capture happens in realtime, which is what keeps picture and sound perfectly in step in the file. The preview
          doubles as the render monitor, so leave this tab in the foreground until the job finishes — a background tab
          is suspended by the browser and the export is stopped.
        </DialogDescription>
      </DialogHeader>

      <div className="km-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-3.5 px-5 py-4">
          {!support.supported && (
            <div className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                No video container is available in this browser, so exports cannot be written. Chrome or Edge will work.
              </span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3.5">
            <SelectField label="Resolution" value={sizeId} options={sizes} onChange={setSizeId} />
            <SelectField label="Frame rate" value={fpsId} options={fpsOptions} onChange={setFpsId} />
          </div>

          <SliderField
            label="Bitrate"
            value={bitrate}
            min={1}
            max={24}
            step={0.5}
            format={(v) => `${v} Mbps`}
            onChange={setBitrate}
          />

          <div className="grid grid-cols-2 gap-3.5">
            <SelectField
              label="Container"
              value={format}
              options={formatOptions}
              onChange={(value) => setFormat(value as ExportOptions["format"])}
            />
            <div className="flex flex-col justify-end">
              <ToggleField
                label="Include audio"
                value={includeAudio}
                onChange={setIncludeAudio}
                hint={hasAudioLayers ? "Mixes every audio and video track" : "This project has no audio yet"}
              />
            </div>
          </div>

          <label className="block">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-[11px] text-km-dim">File name</span>
              <span className="font-mono text-[10px] text-km-faint">
                .{format === "webm" ? "webm" : support.mp4 ? "mp4" : "webm"}
              </span>
            </div>
            <Input
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              placeholder="octo-cut-export"
              className="h-7 rounded border-km-border bg-km-track px-2 text-[12px] text-km-text placeholder:text-km-faint focus-visible:ring-1 focus-visible:ring-km-accent"
            />
          </label>

          <div className="rounded border border-km-border bg-km-track/50 p-3">
            <SegmentedField
              label="Range"
              value={rangeMode}
              options={RANGE_MODES}
              onChange={(value) => setRangeMode(value as RangeMode)}
            />
            {rangeMode === "custom" && (
              <div className="mt-2.5 grid grid-cols-2 gap-3.5">
                <NumberField
                  label="From"
                  value={customStart}
                  min={0}
                  max={Math.max(0, duration - 0.2)}
                  step={0.1}
                  suffix="s"
                  onChange={setCustomStart}
                />
                <NumberField
                  label="To"
                  value={customEnd}
                  min={0.2}
                  max={duration}
                  step={0.1}
                  suffix="s"
                  onChange={setCustomEnd}
                />
              </div>
            )}
            <div className="mt-2.5 flex items-center justify-between font-mono text-[10.5px] text-km-faint">
              <span>
                {formatTimecode(range.start, false)} → {formatTimecode(range.end, false)}
              </span>
              <span>{formatDurationLong(span)} · about {formatBytes(estimatedSize)}</span>
            </div>
          </div>
        </div>

        <SubtitlesRow />

        <div className="border-t border-km-border px-5 py-4">
          <div className="mb-2.5 flex items-center justify-between">
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-km-faint">Queue</h4>
            <span className="text-[10.5px] text-km-faint">
              {jobs.length ? `${jobs.length} job${jobs.length === 1 ? "" : "s"}` : "Empty"}
            </span>
          </div>
          {jobs.length === 0 ? (
            <p className="rounded border border-dashed border-km-border px-3 py-4 text-center text-[11px] text-km-faint">
              Renders run one at a time so the editor stays responsive. Finished files are also saved automatically.
            </p>
          ) : (
            <div className="space-y-2">
              {jobs.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </div>
          )}
        </div>
      </div>

      <DialogFooter className="shrink-0 gap-2 border-t border-km-border px-5 py-3">
        <Button
          variant="ghost"
          onClick={onClose}
          className="h-8 border border-km-border px-3 text-[12px] text-km-dim hover:bg-km-raised hover:text-km-text"
        >
          Close
        </Button>
        <Button
          onClick={enqueue}
          disabled={!support.supported}
          className="h-8 gap-1.5 bg-km-accent px-3 text-[12px] font-medium text-white hover:bg-km-accent2"
        >
          <Film className="h-3.5 w-3.5" />
          Add to queue
        </Button>
      </DialogFooter>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Subtitles
 * ------------------------------------------------------------------ */

function SubtitlesRow() {
  const project = useEditor((s) => s.project);
  const trackId = captionsTrackId(project);
  const projectName = project.settings.name || "octo-cut";

  const download = (format: "srt" | "vtt") => {
    if (!trackId) return;
    const text = format === "srt" ? exportSrt(project, trackId) : exportVtt(project, trackId);
    downloadText(text, `${projectName}.${format}`, format === "srt" ? "application/x-subrip" : "text/vtt");
  };

  return (
    <div className="border-t border-km-border px-5 py-4">
      <div className="mb-2.5 flex items-center justify-between">
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-km-faint">Subtitles</h4>
      </div>
      {!trackId ? (
        <p className="rounded border border-dashed border-km-border px-3 py-4 text-center text-[11px] text-km-faint">
          No captions track yet — generate a voiceover or run auto-caption on a clip first.
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => download("srt")}
            className="h-8 gap-1.5 border border-km-border px-3 text-[12px] text-km-dim hover:bg-km-raised hover:text-km-text"
          >
            <FileText className="h-3.5 w-3.5" />
            Download .srt
          </Button>
          <Button
            variant="ghost"
            onClick={() => download("vtt")}
            className="h-8 gap-1.5 border border-km-border px-3 text-[12px] text-km-dim hover:bg-km-raised hover:text-km-text"
          >
            <FileText className="h-3.5 w-3.5" />
            Download .vtt
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Queue rows
 * ------------------------------------------------------------------ */

function JobRow({ job }: { job: ExportJob }) {
  const meta = STATUS_META[job.status];
  const active = isActive(job);

  return (
    <div className="rounded border border-km-border bg-km-track/60 p-2.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide",
            meta.tone,
          )}
        >
          {active && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
          {meta.label}
        </span>
        <span className="truncate font-mono text-[11px] text-km-text">
          {job.resultName ?? `${job.options.fileName}.${job.options.format === "webm" ? "webm" : "mp4"}`}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-km-faint">
          {job.options.width}×{job.options.height} · {job.options.fps}fps
        </span>
      </div>

      <Progress
        value={Math.round(job.progress * 100)}
        className={cn(
          "mt-2 h-1.5 bg-km-raised",
          "[&>div]:transition-transform",
          job.status === "error" || job.status === "canceled" ? "[&>div]:bg-red-400/70" : "[&>div]:bg-km-accent",
        )}
      />

      <div className="mt-1.5 flex items-center gap-2">
        <span className="truncate text-[10.5px] text-km-dim">{job.message}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {active && (
            <button
              type="button"
              onClick={() => cancelExportJob(job.id)}
              className="flex h-6 items-center gap-1 rounded border border-km-border px-2 text-[10.5px] text-km-dim transition hover:bg-km-raised hover:text-red-300"
            >
              <Ban className="h-3 w-3" />
              Stop
            </button>
          )}
          {job.status === "done" && job.resultUrl && (
            <a
              href={job.resultUrl}
              download={job.resultName}
              className="flex h-6 items-center gap-1 rounded bg-km-accent/15 px-2 text-[10.5px] text-km-accent transition hover:bg-km-accent/25"
            >
              <Download className="h-3 w-3" />
              {job.resultSize ? formatBytes(job.resultSize) : "Save"}
            </a>
          )}
          {!active && (
            <button
              type="button"
              title="Remove from queue"
              onClick={() => editor().removeExportJob(job.id)}
              className="flex h-6 w-6 items-center justify-center rounded border border-km-border text-km-faint transition hover:bg-km-raised hover:text-km-text"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */

export function ExportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-2xl flex-col gap-0 overflow-hidden border-km-border bg-km-panel p-0 text-km-text">
        <ExportPanel onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
