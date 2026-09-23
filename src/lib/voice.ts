/**
 * ON-DEVICE VOICE — text-to-speech and speech-to-text, no cloud, no API key.
 *
 * Both models are ONNX/WASM, run entirely in this tab via `@huggingface/transformers`
 * (Whisper, for transcription) and `kokoro-js` (Kokoro-82M, for synthesis).
 * Neither is loaded until first use — a ~75-170MB download depending on the
 * model — and both are cached by the browser afterwards, so a second run is
 * fully offline. This mirrors the "everything lives in the renderer, works in
 * a plain browser tab too" shape the rest of the MCP host already has.
 *
 * Synthesis reuses the exact Asset-construction shape `sound.ts`'s
 * `generateSound` already established for procedurally generated audio: build
 * a real `AudioBuffer`, encode it to WAV, and use `assetMetaPatch` to get a
 * `LoadedMeta` synchronously — no separate metadata-loading pass needed
 * because the duration/waveform are already known from the buffer itself.
 */
import { type AutomaticSpeechRecognitionPipeline, pipeline } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import { toast } from "sonner";
import { uid } from "@/lib/time";
import { assetMetaPatch, computePeaks, encodeWav, getAudioContext, type LoadedMeta } from "@/lib/media";
import { editor } from "@/store/editorStore";
import type { Asset } from "@/types/editor";

const TTS_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const STT_MODEL_ID = "onnx-community/whisper-base";

export const DEFAULT_VOICE = "af_heart";

/**
 * The voices offered in the UI and by `generate_speech`. All of them are
 * already inside the Kokoro-82M checkpoint, so picking one costs nothing
 * extra — only the first synthesis downloads anything.
 */
export const VOICE_OPTIONS: { id: string; name: string; accent: string; character: string }[] = [
  { id: "af_heart", name: "Heart", accent: "US", character: "warm narrator" },
  { id: "af_bella", name: "Bella", accent: "US", character: "bright and clear" },
  { id: "af_nicole", name: "Nicole", accent: "US", character: "soft, conversational" },
  { id: "am_michael", name: "Michael", accent: "US", character: "steady documentary" },
  { id: "am_fenrir", name: "Fenrir", accent: "US", character: "deep, dramatic" },
  { id: "bf_emma", name: "Emma", accent: "UK", character: "crisp presenter" },
  { id: "bm_george", name: "George", accent: "UK", character: "measured and formal" },
  { id: "bm_lewis", name: "Lewis", accent: "UK", character: "relaxed and low" },
];

export const voiceName = (id: string): string => VOICE_OPTIONS.find((voice) => voice.id === id)?.name ?? id;

/** The voice ids `KokoroTTS.generate` accepts — kept loose here so callers (MCP args, UI selects) can pass a plain string. */
type VoiceId = Parameters<KokoroTTS["generate"]>[1] extends { voice?: infer V } ? V : never;

let ttsPromise: Promise<KokoroTTS> | null = null;
function loadTts(): Promise<KokoroTTS> {
  if (!ttsPromise) {
    ttsPromise = KokoroTTS.from_pretrained(TTS_MODEL_ID, { dtype: "q8", device: "wasm" });
  }
  return ttsPromise;
}

/**
 * `pipeline` is overloaded once per task, so inferring the task from an
 * argument makes TypeScript expand every branch and give up with TS 2590
 * ("union type that is too complex"). Naming the task and the result type here
 * removes the inference — a cast on the call would not, because the failure
 * happens while resolving the call itself.
 */
const createSttPipeline = pipeline as unknown as (
  task: "automatic-speech-recognition",
  model: string,
  options: { dtype: string },
) => Promise<AutomaticSpeechRecognitionPipeline>;

let sttPromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
function loadStt(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!sttPromise) {
    sttPromise = createSttPipeline("automatic-speech-recognition", STT_MODEL_ID, { dtype: "q8" });
  }
  return sttPromise;
}

/** Downloads both models ahead of time, e.g. from a "prepare voice" button. */
export async function preloadVoiceModels(): Promise<void> {
  await Promise.all([loadTts(), loadStt()]);
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscribeResult {
  text: string;
  segments: TranscriptSegment[];
}

/**
 * Synthesizes `text` as one clip. Reused per-sentence by the voiceover flow
 * (`lib/voiceover.ts`) so every segment's exact duration is known the moment
 * it's rendered — no separate alignment pass needed.
 */
export async function synthesize(text: string, voice: string = DEFAULT_VOICE): Promise<{ asset: Asset; meta: LoadedMeta }> {
  const tts = await loadTts();
  const raw = await tts.generate(text, { voice: voice as VoiceId });

  // `.audio` is the raw Float32Array kokoro-js always sets directly in its
  // RawAudio constructor — read that instead of the `.data` getter, which
  // kokoro-js's own `@huggingface/transformers` dependency doesn't define.
  const samples = raw.audio as Float32Array;
  const ctx = getAudioContext();
  const buffer = ctx.createBuffer(1, samples.length, raw.sampling_rate);
  buffer.getChannelData(0).set(samples);

  const wav = encodeWav(buffer);
  const url = URL.createObjectURL(wav);
  const asset: Asset = {
    id: uid("asset"),
    kind: "audio",
    name: text.length > 40 ? `${text.slice(0, 40)}…` : text || "Voiceover",
    mime: "audio/wav",
    url,
    size: wav.size,
    generated: true,
    width: 0,
    height: 0,
    duration: buffer.duration,
    audioBuffer: buffer,
    waveform: computePeaks(buffer),
  };
  return { asset, meta: assetMetaPatch(asset) };
}

/**
 * Renders `text` and drops it on the timeline at the playhead.
 *
 * One clip per call rather than one per sentence: this is the "type a line, hear
 * it" path, and a single clip is the thing that can then be trimmed, moved or
 * re-rendered. `lib/voiceover.ts` is the many-sentence version, with captions
 * and B-roll, and it is the same `synthesize` underneath.
 */
export async function addSpeechLayer(
  text: string,
  voice: string = DEFAULT_VOICE,
  startTime?: number,
): Promise<string | null> {
  const script = text.trim();
  if (!script) return null;

  const { asset, meta } = await synthesize(script, voice);
  editor().addAsset(asset);
  editor().updateAsset(asset.id, meta);
  const id = editor().addMediaLayer(asset.id, startTime ?? editor().currentTime);
  if (!id) {
    toast.error("That narration could not be placed");
    return null;
  }
  toast.success("Narration added", {
    description: `${voiceName(voice)} · ${(asset.duration ?? 0).toFixed(1)}s, on the row above the clip you had selected.`,
  });
  return id;
}

/**
 * Transcribes an existing clip, with per-chunk timestamps for captioning. Pass
 * an asset's own `url` — no decoding on this end, `@huggingface/transformers`
 * fetches and resamples the source itself.
 */
export async function transcribe(url: string): Promise<TranscribeResult> {
  const transcriber = await loadStt();
  const output = await transcriber(url, { return_timestamps: true, chunk_length_s: 30, stride_length_s: 5 });
  const result = Array.isArray(output) ? output[0] : output;
  const segments: TranscriptSegment[] = (result.chunks ?? [])
    .filter((chunk) => chunk.text?.trim())
    .map((chunk) => ({
      start: chunk.timestamp[0] ?? 0,
      end: chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0,
      text: chunk.text.trim(),
    }));
  return { text: result.text?.trim() ?? "", segments };
}

/** Splits a script into sentence-level segments for the voiceover flow. */
export function splitSentences(script: string): string[] {
  return script
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
