/**
 * THE DEV-SERVER HOST.
 *
 * `electron/preload.cjs` publishes one small surface — status, start, stop, plus
 * a request/reply channel — because the panel should not have to know which
 * process is holding the socket. When the page is served by Vite instead of
 * Electron, `vite/mcp-bridge.ts` is holding it, and this is the renderer half of
 * that arrangement: a long poll for the JSON-RPC messages coming in, a POST for
 * the reply going back out.
 *
 * Every method below deliberately mirrors the preload bridge, so `host.ts` adopts
 * either one without branching. There is no protocol knowledge here at all — the
 * tool catalogue lives in `server.ts` and never crosses this line.
 */
import type { HostBridge } from "@/lib/mcp/host";

/** The page's own channel on the dev server. See `vite/mcp-bridge.ts`. */
const BRIDGE = "/__octo-cut/mcp";

/** How long to wait after a poll fails before trying again. */
const RETRY_MS = 1500;

export interface DevServerHost extends HostBridge {
  /** Is the dev-server bridge actually there? A static build answers "no". */
  probe: () => Promise<boolean>;
}

export function createDevServerHost(): DevServerHost {
  const requestHandlers = new Set<(message: { id: number; payload: unknown }) => void>();
  const statusHandlers = new Set<(status: unknown) => void>();

  let listening = false;
  /** Bumped on every start/stop so a superseded poll loop can tell and exit. */
  let generation = 0;
  let inFlight: AbortController | null = null;

  /** The endpoint is on this page's own origin — the path is the desktop app's. */
  const endpoint = () => `${window.location.origin}/mcp`;

  /**
   * The bridge reports everything except the URL, because only the page knows
   * how it was reached. A proxied dev server printing `127.0.0.1` would hand out
   * an address that refuses it.
   */
  const compose = (raw: unknown): unknown => {
    const status = (raw ?? {}) as Record<string, unknown>;
    return { ...status, url: listening && status.running === true ? endpoint() : null };
  };

  const publish = (raw: unknown): unknown => {
    const status = compose(raw);
    for (const handler of statusHandlers) handler(status);
    return status;
  };

  async function post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${BRIDGE}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`The agent bridge answered ${res.status}.`);
    return res.json();
  }

  async function read(): Promise<unknown> {
    const res = await fetch(`${BRIDGE}/status`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`The agent bridge answered ${res.status}.`);
    return res.json();
  }

  /**
   * One long poll, repeated. It resolves as soon as the server has something to
   * hand over, or once the server's own hold has expired and it answers empty —
   * which is also how the status counters stay fresh without a timer.
   */
  async function pump(gen: number): Promise<void> {
    while (gen === generation && listening) {
      inFlight = new AbortController();
      try {
        const res = await fetch(`${BRIDGE}/next`, { signal: inFlight.signal, headers: { accept: "application/json" } });
        inFlight = null;
        if (!res.ok) throw new Error(`The agent bridge answered ${res.status}.`);

        const body = (await res.json()) as { requests?: { id: number; payload: unknown }[]; status?: unknown };
        if (body.status) publish(body.status);
        for (const request of body.requests ?? []) {
          for (const handler of requestHandlers) handler(request);
        }
      } catch {
        inFlight = null;
        if (gen !== generation || !listening) return;
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  }

  return {
    probe: async () => {
      try {
        const res = await fetch(`${BRIDGE}/status`, { headers: { accept: "application/json" } });
        // A plain static host answers the SPA fallback with `200 text/html`, so
        // the content type is what actually says the bridge is on the other end.
        if (!res.ok || !(res.headers.get("content-type") ?? "").includes("application/json")) return false;
        const status = (await res.json()) as { running?: unknown };
        if (typeof status?.running !== "boolean") return false;

        // Announce the origin this page is served from, so the URL the panel
        // prints is one the endpoint will actually accept.
        await post("hello", { origin: window.location.origin });
        return true;
      } catch {
        return false;
      }
    },

    status: async () => publish(await read()),

    /**
     * The port is ignored: it belongs to the dev server and cannot be chosen
     * from here. Starting simply means "answer again".
     */
    start: async () => {
      const raw = await post("state", { listening: true });
      if (!listening) {
        listening = true;
        generation += 1;
        void pump(generation);
      }
      return publish(raw);
    },

    stop: async () => {
      listening = false;
      generation += 1;
      inFlight?.abort();
      return publish(await post("state", { listening: false }));
    },

    respond: (id, payload) => {
      // The reply carries the fresh counters back, which saves a status round trip.
      void post("reply", { id, payload }).then(publish, () => {});
    },

    notify: (notification) => {
      void post("notify", notification).catch(() => {});
    },

    onRequest: (handler) => {
      requestHandlers.add(handler);
    },

    onStatus: (handler) => {
      statusHandlers.add(handler);
    },
  };
}
