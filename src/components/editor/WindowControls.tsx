/**
 * Minimize / maximize / close — the desktop window's custom titlebar controls,
 * replacing what the OS chrome drew before `frame: false` removed it. Renders
 * nothing outside Electron: a browser tab already gets this from the browser.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { windowControls } from "@/lib/windowControls";

const NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;

export default function WindowControls() {
  const bridge = windowControls();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge.isMaximized().then((value) => {
      if (!cancelled) setMaximized(value);
    });
    bridge.onMaximizedChange((value) => setMaximized(value));
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  if (!bridge) return null;

  return (
    <div data-no-drag style={NO_DRAG} className="flex items-center gap-0.5">
      <button
        type="button"
        title="Minimize"
        onClick={() => void bridge.minimize()}
        className="grid h-8 w-10 place-items-center rounded-md text-km-dim transition hover:bg-km-raised hover:text-km-text"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => void bridge.toggleMaximize()}
        className="grid h-8 w-10 place-items-center rounded-md text-km-dim transition hover:bg-km-raised hover:text-km-text"
      >
        {maximized ? <Copy className="h-3.5 w-3.5 -scale-x-100" /> : <Square className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        title="Close"
        onClick={() => void bridge.close()}
        className="grid h-8 w-10 place-items-center rounded-md text-km-dim transition hover:bg-red-500 hover:text-white"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
