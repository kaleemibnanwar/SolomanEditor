/**
 * Mic dubbing: click Record, the timeline plays from wherever the playhead
 * is (reusing `usePlayback.ts`'s existing RAF loop — no separate playhead
 * mechanism needed), the mic is captured alongside it, and Stop drops the
 * clip back at the exact point recording began, not wherever playback ended
 * up. Mirrors `media.ts`'s `generateDemoVideo` for the MediaRecorder→Blob
 * shape, and `importFiles.ts` for turning the result into a timeline clip.
 */
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { assetMetaPatch, createAssetsFromFiles, pickAudioRecorderMime } from "@/lib/media";
import { editor, editorStore } from "@/store/editorStore";

function extensionFor(mime: string): string {
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

export function useRecording() {
  const [isRecording, setIsRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startTimeRef = useRef(0);
  const wasPlayingRef = useRef(false);

  const start = useCallback(async () => {
    if (recorderRef.current) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      toast.error("Couldn't access the microphone", { description: (error as Error)?.message });
      return;
    }

    const mime = pickAudioRecorderMime();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      toast.error("Couldn't start recording", { description: (error as Error)?.message });
      return;
    }

    chunksRef.current = [];
    recorder.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
    recorderRef.current = recorder;
    streamRef.current = stream;
    startTimeRef.current = editorStore.getState().currentTime;
    wasPlayingRef.current = editorStore.getState().isPlaying;

    recorder.start(120);
    editor().play();
    setIsRecording(true);
  }, []);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    const stream = streamRef.current;
    if (!recorder) return;

    const done = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" }));
    });
    recorder.stop();
    if (!wasPlayingRef.current) editor().pause();

    const blob = await done;
    stream?.getTracks().forEach((track) => track.stop());
    recorderRef.current = null;
    streamRef.current = null;
    setIsRecording(false);

    if (!blob.size) {
      toast.error("No audio was captured");
      return;
    }

    const mime = blob.type || "audio/webm";
    const file = new File([blob], `dub-${Date.now()}.${extensionFor(mime)}`, { type: mime });
    const [item] = createAssetsFromFiles([file]);
    if (!item) {
      toast.error("Couldn't import the recording");
      return;
    }

    editor().addAsset(item.asset);
    const loaded = await item.meta;
    editor().updateAsset(item.asset.id, assetMetaPatch(loaded));
    const id = editor().addMediaLayer(item.asset.id, startTimeRef.current);
    if (!id) {
      toast.error("Couldn't place the recording on the timeline");
      return;
    }
    toast.success("Dub added", { description: "Placed at the point you started recording." });
  }, []);

  return { isRecording, start: () => void start(), stop: () => void stop() };
}
