/**
 * THE VOICEOVER QUEUE — script in, narrated + captioned + B-roll'd timeline out.
 *
 * Mirrors `exporter.ts`'s `pumpExportQueue`/`runExportJob` shape exactly, for
 * the same reason: this is long-running (model inference, several network
 * fetches) and must not block the UI or the MCP dispatch path, so it's a
 * background job with a status a client can poll, not something a single
 * `tools/call` answers inline.
 *
 * Splitting the script into sentences and synthesizing each one separately
 * (rather than one TTS call for the whole thing) is what makes the timing
 * exact: every segment's duration is known the instant it's rendered, so
 * captions and B-roll line up with no forced-alignment step at all. Placement
 * reuses the ordinary `assemble`/`addText`/`addMedia` steps through the same
 * `runPlan` the MCP tools use — one call, one undo step, same guarantees a
 * human's edit gets.
 */
import { toast } from "sonner";
import { TEXT_PRESETS } from "@/lib/library";
import { presetOf } from "@/lib/mcp/kit";
import { runPlan } from "@/lib/mcp/executor";
import type { Step } from "@/lib/mcp/steps";
import { assetMetaPatch, createAssetsFromFiles } from "@/lib/media";
import { getSetting } from "@/lib/settings";
import { fetchStockFile, searchStock, stockSourceSupports, type StockKind, type StockSource } from "@/lib/stock";
import { splitSentences, synthesize } from "@/lib/voice";
import { editor } from "@/store/editorStore";
import type { VoiceoverJob, VoiceoverSegment } from "@/types/editor";

const CAPTION_STYLE = presetOf("text preset", TEXT_PRESETS, "caption").text;

let pumping = false;

/** Processes queued voiceover jobs one after another, same shape as `pumpExportQueue`. */
export async function pumpVoiceoverQueue() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const job = editor().voiceoverJobs.find((j) => j.status === "queued");
      if (!job) break;
      await runVoiceoverJob(job);
    }
  } finally {
    pumping = false;
  }
}

/** A source that actually has what it needs to run, preferring a richer keyed one when configured. */
async function pickBrollSource(preferred?: string): Promise<StockSource> {
  if (preferred) return preferred as StockSource;
  if (await getSetting("pixabayApiKey")) return "pixabay";
  if (await getSetting("pexelsApiKey")) return "pexels";
  return "wikimedia";
}

export async function runVoiceoverJob(job: VoiceoverJob): Promise<void> {
  const id = job.id;
  const patch = (p: Partial<VoiceoverJob>) => editor().patchVoiceoverJob(id, p);

  try {
    patch({ status: "synthesizing", progress: 0.02, message: "Splitting the script…" });
    const sentences = splitSentences(job.script);
    if (!sentences.length) throw new Error("The script has no sentences to narrate.");

    const narrationAssetIds: string[] = [];
    const segments: VoiceoverSegment[] = [];
    let cursor = Math.max(0, job.options.start);

    for (let i = 0; i < sentences.length; i++) {
      patch({
        status: "synthesizing",
        progress: 0.05 + 0.45 * (i / sentences.length),
        message: `Narrating sentence ${i + 1} of ${sentences.length}…`,
      });
      const { asset, meta } = await synthesize(sentences[i], job.options.voice);
      editor().addAsset(asset);
      editor().updateAsset(asset.id, meta);
      narrationAssetIds.push(asset.id);
      const duration = asset.duration ?? 0;
      segments.push({ text: sentences[i], start: cursor, end: cursor + duration });
      cursor += duration;
    }

    const steps: Step[] = [
      { kind: "assemble", clips: narrationAssetIds.map((assetId) => ({ assetId })), start: job.options.start },
    ];

    const captionsTrackId = editor().ensureCaptionsTrack();
    for (const segment of segments) {
      steps.push({
        kind: "addText",
        content: segment.text,
        start: segment.start,
        duration: Math.max(0.3, segment.end - segment.start),
        text: CAPTION_STYLE,
        trackId: captionsTrackId,
      });
    }

    if (job.options.fetchBroll) {
      patch({ status: "fetching-broll", progress: 0.55, message: "Finding B-roll…" });
      const source = await pickBrollSource(job.options.brollSource);
      const kind: StockKind | null = stockSourceSupports(source, "video")
        ? "video"
        : stockSourceSupports(source, "image")
          ? "image"
          : null;

      let brollTrackId: string | null = null;
      if (kind) {
        for (let i = 0; i < segments.length; i++) {
          patch({
            status: "fetching-broll",
            progress: 0.55 + 0.35 * (i / segments.length),
            message: `Finding B-roll for sentence ${i + 1} of ${segments.length}…`,
          });
          // Best-effort: a missing key, an empty result set or a network
          // hiccup on one sentence must not sink the whole voiceover — the
          // narration and caption for it still land, just without a visual.
          try {
            const [item] = await searchStock({ text: segments[i].text, source, kind, limit: 1 });
            if (!item) continue;
            const file = await fetchStockFile(item);
            const [created] = createAssetsFromFiles([file]);
            if (!created) continue;
            editor().addAsset(created.asset);
            const loaded = await created.meta;
            editor().updateAsset(created.asset.id, assetMetaPatch(loaded));
            brollTrackId ??= editor().addTrack("B-roll");
            steps.push({
              kind: "addMedia",
              assetId: created.asset.id,
              start: segments[i].start,
              duration: Math.max(0.3, segments[i].end - segments[i].start),
              trackId: brollTrackId,
            });
          } catch {
            continue;
          }
        }
      }
    }

    patch({ status: "assembling", progress: 0.95, message: "Placing everything on the timeline…" });
    const report = runPlan(steps, { label: "generate_voiceover", record: true });
    if (!report.ok) throw new Error(report.error ?? "Could not place the voiceover on the timeline.");

    patch({ status: "done", progress: 1, message: `Done — ${segments.length} sentence(s) narrated.`, segments });
    toast.success("Voiceover generated", { description: `${segments.length} sentence(s), captions included.` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Voiceover generation failed";
    patch({ status: "error", progress: 0, message, error: message });
    toast.error("Voiceover generation failed", { description: message });
  }
}
