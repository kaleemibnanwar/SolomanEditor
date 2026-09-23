/**
 * SRT/VTT export for the captions track.
 *
 * There's no separate subtitle data model — a caption IS a text layer on the
 * track flagged `captions` (see `lib/tracks.ts`). This just walks that track
 * in timeline order and formats each layer's `startTime`/`duration`/`text.content`
 * as a standard subtitle cue, so the same captions that are burned into the
 * picture can also leave the project as a sidecar file.
 */
import { layersOnTrack } from "@/lib/tracks";
import type { Project, TrackId } from "@/types/editor";

function pad(n: number, width = 2): string {
  return String(Math.floor(n)).padStart(width, "0");
}

function srtTimestamp(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms, 3)}`;
}

function vttTimestamp(seconds: number): string {
  return srtTimestamp(seconds).replace(",", ".");
}

interface Cue {
  start: number;
  end: number;
  text: string;
}

function captionCues(project: Project, trackId: TrackId): Cue[] {
  return layersOnTrack(project, trackId)
    .filter((layer) => layer.type === "text" && layer.text?.content)
    .map((layer) => ({
      start: layer.startTime,
      end: layer.startTime + layer.duration,
      text: layer.text!.content,
    }))
    .sort((a, b) => a.start - b.start);
}

export function exportSrt(project: Project, trackId: TrackId): string {
  const cues = captionCues(project, trackId);
  return cues
    .map((cue, i) => `${i + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}\n${cue.text}\n`)
    .join("\n");
}

export function exportVtt(project: Project, trackId: TrackId): string {
  const cues = captionCues(project, trackId);
  const body = cues.map((cue) => `${vttTimestamp(cue.start)} --> ${vttTimestamp(cue.end)}\n${cue.text}\n`).join("\n");
  return `WEBVTT\n\n${body}`;
}
