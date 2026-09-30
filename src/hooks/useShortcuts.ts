/**
 * Editor keyboard shortcuts.
 *
 * Registered once by the shell. Keystrokes that originate inside a text field
 * are ignored so typing a caption never scrubs the timeline.
 */
import { useEffect } from "react";
import { resumeAudioContext } from "@/lib/media";
import { setOutputMuted } from "@/lib/playback";
import { editor, editorStore, timelineDuration } from "@/store/editorStore";
import type { Layer } from "@/types/editor";

const TYPING_TAGS = ["INPUT", "TEXTAREA", "SELECT"];

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (TYPING_TAGS.includes(el.tagName)) return true;
  return el.isContentEditable === true;
}

export interface ShortcutOptions {
  onExport?: () => void;
  onSave?: () => void;
}

export function useEditorShortcuts({ onExport, onSave }: ShortcutOptions = {}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      const st = editorStore.getState();

      // The edit surface owns the timeline shortcuts. In image/broadcast mode the
      // Stage/Timeline are unmounted, and while a dialog is open the keys would
      // silently mutate a project the user can't see.
      if (st.ui.mode !== "edit") return;
      if (
        typeof document !== "undefined" &&
        document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')
      ) {
        return;
      }

      /* ---- modifier combos ---- */
      if (mod) {
        switch (e.key.toLowerCase()) {
          case "z":
            e.preventDefault();
            if (e.shiftKey) editor().redo();
            else editor().undo();
            return;
          case "y":
            e.preventDefault();
            editor().redo();
            return;
          case "d":
            e.preventDefault();
            if (st.selection.length) editor().duplicateLayers(st.selection);
            return;
          case "c":
            e.preventDefault();
            if (st.selection.length) {
              editor().copyLayers(st.selection);
            }
            return;
          case "v":
            e.preventDefault();
            editor().pasteLayers();
            return;
          case "a":
            e.preventDefault();
            editor().selectAll();
            return;
          case "e":
            e.preventDefault();
            onExport?.();
            return;
          case "s":
            e.preventDefault();
            onSave?.();
            return;
          default:
            return;
        }
      }

      switch (e.key) {
        case " ":
          e.preventDefault();
          void resumeAudioContext();
          editor().togglePlay();
          return;
        case "ArrowLeft":
          e.preventDefault();
          if (e.shiftKey) editor().seekBy(-1);
          else editor().seekFrame(-1);
          return;
        case "ArrowRight":
          e.preventDefault();
          if (e.shiftKey) editor().seekBy(1);
          else editor().seekFrame(1);
          return;
        case "ArrowUp":
        case "ArrowDown": {
          if (!st.selection.length) return;
          e.preventDefault();
          const step = (e.shiftKey ? 20 : 1) * (e.key === "ArrowUp" ? -1 : 1);
          editor().pushHistory();
          for (const id of st.selection) {
            const layer = st.project.layers[id];
            if (!layer || layer.locked) continue;
            editor().updateLayerTransform(id, { y: layer.transform.y + step }, false);
          }
          return;
        }
        case "Home":
          e.preventDefault();
          editor().setCurrentTime(0);
          return;
        case "End":
          e.preventDefault();
          editor().setCurrentTime(timelineDuration(st));
          return;
        case "Delete":
        case "Backspace":
          if (!st.selection.length) return;
          e.preventDefault();
          editor().removeLayers(st.selection);
          return;
        case "[":
          e.preventDefault();
          editor().zoomBy(1 / 1.25);
          return;
        case "]":
          e.preventDefault();
          editor().zoomBy(1.25);
          return;
        default:
          break;
      }

      switch (e.key.toLowerCase()) {
        case "s": {
          e.preventDefault();
          editor().splitAtPlayhead();
          return;
        }
        case "m":
          e.preventDefault();
          editor().setUi({ muted: !st.ui.muted });
          setOutputMuted(!st.ui.muted);
          return;
        case "l":
          e.preventDefault();
          editor().setLoop(!st.loop);
          return;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onExport, onSave]);
}
