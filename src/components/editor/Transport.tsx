/**
 * Transport bar — sits directly under the canvas, mirroring the
 * KineMaster layout where playback controls live next to the preview.
 */
import {
  ChevronFirst,
  ChevronLast,
  Mic,
  Pause,
  Play,
  Repeat,
  SkipBack,
  SkipForward,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import { editor, timelineDuration, useEditor } from "@/store/editorStore";
import { formatTimecode } from "@/lib/time";
import { resumeAudioContext } from "@/lib/media";
import { setOutputMuted } from "@/lib/playback";
import { useRecording } from "@/hooks/useRecording";

export default function Transport() {
  const isPlaying = useEditor((s) => s.isPlaying);
  const loop = useEditor((s) => s.loop);
  const currentTime = useEditor((s) => s.currentTime);
  const fps = useEditor((s) => s.project.settings.fps);
  const duration = useEditor(timelineDuration);
  const muted = useEditor((s) => s.ui.muted);
  const { isRecording, start: startRecording, stop: stopRecording } = useRecording();

  const toggleMute = async () => {
    const next = !muted;
    editor().setUi({ muted: next });
    setOutputMuted(next);
    if (!next) await resumeAudioContext();
  };

  return (
    <div className="flex h-[58px] shrink-0 items-center gap-3 border-t border-km-border bg-km-panel px-[18px]">
      <TransportButton title="Go to start (Home)" onClick={() => editor().setCurrentTime(0)}>
        <ChevronFirst className="h-4 w-4" />
      </TransportButton>
      <TransportButton title="Previous frame (←)" onClick={() => editor().seekFrame(-1)}>
        <SkipBack className="h-4 w-4" />
      </TransportButton>

      <button
        type="button"
        onClick={() => {
          void resumeAudioContext();
          editor().togglePlay();
        }}
        className="grid h-9 w-9 place-items-center rounded-full bg-km-accent text-km-bg transition hover:bg-km-accent2"
        title="Play / pause (Space)"
      >
        {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
      </button>

      <button
        type="button"
        onClick={() => {
          void resumeAudioContext();
          if (isRecording) stopRecording();
          else startRecording();
        }}
        className={`grid h-9 w-9 place-items-center rounded-full transition ${
          isRecording ? "bg-red-500 text-white shadow-lg shadow-red-500/30" : "text-km-dim hover:bg-km-raised hover:text-km-text"
        }`}
        title={isRecording ? "Stop recording" : "Record a voice-over from here"}
      >
        {isRecording ? <Square className="h-3.5 w-3.5" /> : <Mic className="h-4 w-4" />}
      </button>

      <TransportButton title="Next frame (→)" onClick={() => editor().seekFrame(1)}>
        <SkipForward className="h-4 w-4" />
      </TransportButton>
      <TransportButton title="Go to end (End)" onClick={() => editor().setCurrentTime(duration)}>
        <ChevronLast className="h-4 w-4" />
      </TransportButton>

      <div className="ml-2 flex items-baseline gap-2 font-mono">
        <span className="text-[11px] tabular-nums text-km-text">{formatTimecode(currentTime)}</span>
        <span className="text-[11px] text-km-faint">/ {formatTimecode(duration)}</span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <span className="rounded bg-km-raised px-2 py-1 text-[11px] text-km-dim">{fps} fps</span>
        <button
          type="button"
          onClick={() => editor().setLoop(!loop)}
          className={`grid h-8 w-8 place-items-center rounded-md transition hover:bg-km-raised ${
            loop ? "text-km-accent" : "text-km-dim"
          }`}
          title="Loop playback (L)"
        >
          <Repeat className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => void toggleMute()}
          className={`grid h-8 w-8 place-items-center rounded-md transition hover:bg-km-raised ${
            muted ? "text-km-accent" : "text-km-dim hover:text-km-text"
          }`}
          title="Mute (M)"
        >
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

function TransportButton({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded-md text-km-dim transition hover:bg-km-raised hover:text-km-text"
    >
      {children}
    </button>
  );
}
