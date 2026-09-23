/**
 * Playback loop.
 *
 * A single rAF loop drives the playhead, keeps <video> elements aligned and
 * re-locks the audio scheduler whenever the user seeks mid-playback.
 */
import { useEffect, useRef } from "react";
import { projectDuration } from "@/lib/project";
import { AudioScheduler, pauseAllMedia, setOutputMuted, syncVideoLayers } from "@/lib/playback";
import { editor, editorStore, useEditor } from "@/store/editorStore";

export function usePlayback() {
  const isPlaying = useEditor((s) => s.isPlaying);
  const muted = useEditor((s) => s.ui.muted);
  const schedulerRef = useRef<AudioScheduler | null>(null);
  const expectedRef = useRef(0);
  const seekRef = useRef(0);

  if (!schedulerRef.current) schedulerRef.current = new AudioScheduler();

  useEffect(() => {
    setOutputMuted(muted);
  }, [muted]);

  // advance the playhead + keep media aligned
  useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const st = editorStore.getState();
      const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
      last = now;

      if (st.isPlaying) {
        const scheduler = schedulerRef.current!;
        // an external seek (playhead drag) breaks continuity — re-lock the mix
        if (Math.abs(st.currentTime - expectedRef.current) > 0.2) {
          scheduler.start(st.project, st.assets, st.currentTime);
        }

        const duration = projectDuration(st.project);
        let next = st.currentTime + dt;
        if (next >= duration) {
          if (st.loop && duration > 0.08) {
            next = 0;
            editor().setCurrentTime(0);
            scheduler.start(st.project, st.assets, 0);
          } else {
            next = duration;
            editor().setCurrentTime(duration);
            editor().pause();
            scheduler.stop();
          }
        } else {
          editor().setCurrentTime(next);
        }
        expectedRef.current = next;
      } else {
        expectedRef.current = editorStore.getState().currentTime;
      }

      const after = editorStore.getState();
      syncVideoLayers(after.project, after.assets, after.currentTime, after.isPlaying, seekRef);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // start / stop the audio mix with playback
  useEffect(() => {
    const scheduler = schedulerRef.current!;
    if (isPlaying) {
      const st = editorStore.getState();
      scheduler.start(st.project, st.assets, st.currentTime);
      expectedRef.current = st.currentTime;
    } else {
      scheduler.stop();
      pauseAllMedia(editorStore.getState().assets);
      syncVideoLayers(
        editorStore.getState().project,
        editorStore.getState().assets,
        editorStore.getState().currentTime,
        false,
        seekRef,
      );
    }
  }, [isPlaying]);

  // flush the mix + media when the editor unmounts
  useEffect(
    () => () => {
      schedulerRef.current?.stop();
      pauseAllMedia(editorStore.getState().assets);
    },
    [],
  );
}
