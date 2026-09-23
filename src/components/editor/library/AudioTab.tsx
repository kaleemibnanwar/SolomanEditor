/**
 * The Audio tab: narration, the procedural sound pack, and whatever is already
 * in the project — the three ways sound gets into a cut.
 *
 * They are one tab rather than three because they answer the same question
 * ("what should this moment sound like?") and are reached from the same place.
 * The chips pick which of them is showing; the search field only ever filters
 * the list it is looking at.
 *
 * Nothing here calls the network. The sound pack is synthesised in an
 * OfflineAudioContext and the narration by Kokoro-82M, both in this tab — the
 * only download is the voice model, once, the first time it is asked for.
 */
import { useEffect, useRef, useState } from "react";
import { Captions, Loader2, Mic, Play, Plus, Square } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ProjectAudio } from "@/components/editor/library/MediaTab";
import { ChipRow, EmptyState, Hint, SectionLabel, type ChipOption } from "@/components/editor/library/pieces";
import {
  SOUND_CATEGORIES,
  SOUND_PRESETS,
  addSoundLayer,
  auditionSound,
  stopAudition,
  type SoundCategory,
  type SoundPreset,
} from "@/lib/sound";
import { addSpeechLayer, splitSentences, VOICE_OPTIONS, voiceName } from "@/lib/voice";
import { cn } from "@/lib/utils";
import { editor, useEditor } from "@/store/editorStore";

type AudioView = "sound" | "voice" | "tracks";

const VIEWS: ChipOption<AudioView>[] = [
  { value: "sound", label: "Sound effects" },
  { value: "voice", label: "AI voice" },
  { value: "tracks", label: "In the project" },
];

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export default function AudioTab({ query }: { query: string }) {
  const [view, setView] = useState<AudioView>("sound");

  return (
    <div className="space-y-2">
      <ChipRow<AudioView> options={VIEWS} value={view} onChange={setView} />

      {view === "sound" ? (
        <SoundPanel query={query} />
      ) : view === "voice" ? (
        <VoicePanel />
      ) : (
        <ProjectAudio query={query} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Generated sound pack
 * ------------------------------------------------------------------ */

function SoundPanel({ query }: { query: string }) {
  const [category, setCategory] = useState<SoundCategory>("transition");
  const [playing, setPlaying] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const stopTimer = useRef<number | null>(null);

  // Auditioning is a store-external side effect, so it has to be torn down.
  useEffect(
    () => () => {
      if (stopTimer.current !== null) window.clearTimeout(stopTimer.current);
      stopAudition();
    },
    [],
  );

  const clearTimer = () => {
    if (stopTimer.current !== null) window.clearTimeout(stopTimer.current);
    stopTimer.current = null;
  };

  const toggle = (preset: SoundPreset) => {
    if (playing === preset.id) {
      clearTimer();
      stopAudition();
      setPlaying(null);
      return;
    }
    clearTimer();
    setPlaying(preset.id);
    void auditionSound(preset);
    // The pack is fixed-length, so the playing flag can retire on its own.
    stopTimer.current = window.setTimeout(() => setPlaying(null), Math.ceil(preset.seconds * 1000) + 80);
  };

  const add = (preset: SoundPreset) => {
    setAdding(preset.id);
    void addSoundLayer(preset).finally(() => setAdding((id) => (id === preset.id ? null : id)));
  };

  const needle = query.trim().toLowerCase();
  const presets = SOUND_PRESETS.filter(
    (preset) =>
      preset.category === category &&
      (!needle || preset.name.toLowerCase().includes(needle) || preset.blurb.toLowerCase().includes(needle)),
  );

  return (
    <div className="space-y-2">
      <ChipRow<SoundCategory>
        options={SOUND_CATEGORIES.map((option) => ({ value: option.id, label: option.label }))}
        value={category}
        onChange={setCategory}
      />

      {presets.length === 0 ? (
        <EmptyState>No sounds in this set match “{query.trim()}”.</EmptyState>
      ) : (
        <>
          <SectionLabel right={`${presets.length} effects`}>Generated sound</SectionLabel>
          <div className="space-y-1">
            {presets.map((preset) => (
              <SoundRow
                key={preset.id}
                preset={preset}
                playing={playing === preset.id}
                busy={adding === preset.id}
                onPreview={() => toggle(preset)}
                onAdd={() => add(preset)}
              />
            ))}
          </div>
        </>
      )}

      <Hint>
        Rendered in the browser, so the pack needs no download and works offline. Added at the
        playhead on the track above the clip you had selected.
      </Hint>
    </div>
  );
}

function SoundRow({
  preset,
  playing,
  busy,
  onPreview,
  onAdd,
}: {
  preset: SoundPreset;
  playing: boolean;
  busy: boolean;
  onPreview: () => void;
  onAdd: () => void;
}) {
  return (
    <div className="group flex items-center gap-2 rounded-lg border border-km-border bg-km-panel2 px-1.5 py-1.5 transition hover:border-km-accent/55">
      <button
        type="button"
        onClick={onPreview}
        title={playing ? "Stop" : "Audition"}
        className={cn(
          "grid h-7 w-7 shrink-0 place-items-center rounded-full border transition",
          playing
            ? "border-km-accent bg-km-accent/20 text-km-accent"
            : "border-km-border text-km-dim hover:border-km-accent/60 hover:text-km-text",
        )}
      >
        {playing ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3 translate-x-px" />}
      </button>

      <div className="min-w-0 flex-1">
        <div className="truncate text-[11.5px] leading-tight text-km-text">{preset.name}</div>
        <div className="truncate text-[9.5px] leading-tight text-km-faint">{preset.blurb}</div>
      </div>

      <span className="shrink-0 text-[9.5px] tabular-nums text-km-faint">{preset.seconds.toFixed(1)}s</span>

      <button
        type="button"
        onClick={onAdd}
        title="Add to the timeline"
        className="grid h-5 w-5 shrink-0 place-items-center rounded bg-km-raised/70 text-km-dim transition hover:bg-km-accent hover:text-white"
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Narration
 * ------------------------------------------------------------------ */

/**
 * The script and the chosen voice live in the store, not in this component:
 * switching library tabs unmounts the panel, and a half-written paragraph is
 * not something to throw away because someone went to look for a clip.
 */
function VoicePanel() {
  const script = useEditor((s) => s.ui.voiceScript);
  const voice = useEditor((s) => s.ui.voiceId);
  const [busy, setBusy] = useState(false);

  const trimmed = script.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  const sentences = trimmed ? splitSentences(trimmed).length : 0;

  /** One clip, the whole script, at the playhead. */
  const render = async () => {
    setBusy(true);
    try {
      await addSpeechLayer(trimmed, voice);
    } catch (error) {
      toast.error("That narration did not render", { description: describe(error) });
    } finally {
      setBusy(false);
    }
  };

  /** The longer pass: a clip, a caption and B-roll per sentence, in one undo step. */
  const narrate = () => {
    editor().enqueueVoiceover(trimmed, { start: editor().currentTime, voice, fetchBroll: true });
    toast.success("Voiceover queued", {
      description: "Narration, captions and B-roll — the pill above the timeline tracks it.",
    });
  };

  return (
    <div className="space-y-2">
      <SectionLabel right={trimmed ? `${words} words · ${sentences} sentences` : undefined}>Script</SectionLabel>
      <Textarea
        value={script}
        onChange={(e) => editor().setUi({ voiceScript: e.target.value })}
        placeholder="Type or paste the line you want read aloud…"
        spellCheck
        className="min-h-[92px] resize-y border-km-border bg-km-panel2 text-[11.5px] leading-relaxed text-km-text placeholder:text-km-faint focus-visible:ring-1 focus-visible:ring-km-accent"
      />

      <SectionLabel>Voice</SectionLabel>
      <select
        value={voice}
        onChange={(e) => editor().setUi({ voiceId: e.target.value })}
        aria-label="Narration voice"
        className="h-7 w-full rounded border border-km-border bg-km-track px-2 text-[11.5px] text-km-text outline-none focus:ring-1 focus:ring-km-accent"
      >
        {VOICE_OPTIONS.map((option) => (
          <option key={option.id} value={option.id} className="bg-km-panel2">
            {option.name} · {option.accent} — {option.character}
          </option>
        ))}
      </select>

      <div className="space-y-1.5 pt-1">
        <Button
          onClick={() => void render()}
          disabled={!trimmed || busy}
          className="h-8 w-full gap-1.5 bg-km-accent text-[12px] text-white hover:bg-km-accent2 disabled:opacity-45"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mic className="h-3.5 w-3.5" />}
          {busy ? "Rendering…" : `Add in ${voiceName(voice)}'s voice`}
        </Button>

        <Button
          variant="ghost"
          onClick={narrate}
          disabled={!trimmed || busy}
          className="h-8 w-full gap-1.5 border border-km-border text-[11.5px] text-km-dim hover:bg-km-raised hover:text-km-text disabled:opacity-45"
        >
          <Captions className="h-3.5 w-3.5" />
          Narrate with captions and B-roll
        </Button>
      </div>

      <Hint>
        Read on this machine by Kokoro-82M — the model is a one-off download the first time you
        generate, cached afterwards, and the script never leaves the page. <strong>Add</strong>
        {" "}renders the whole script as one clip at the playhead; <strong>narrate</strong> runs the
        longer pass, one clip and one timed caption per sentence with stock visuals under it.
      </Hint>
    </div>
  );
}
