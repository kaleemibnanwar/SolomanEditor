/**
 * THE REMOTE HOST.
 *
 * The window bridge is for a host that already has a handle on this page. This
 * is for every other client — an AI tool that only knows how to be pointed at a
 * URL. A browser tab cannot open a listening socket, so there are two things
 * that listen on its behalf, and this module is the renderer half of both:
 *
 *   · THE DESKTOP APP. `electron/mcp-http.cjs` binds 127.0.0.1 in the main
 *     process, and the preload script is the bridge to it.
 *   · THE VITE DEV SERVER. `vite/mcp-bridge.ts` hangs the same endpoint off the
 *     port the dev server is already using, so `pnpm dev` in a plain browser tab
 *     serves one too. See `browserHost.ts`.
 *
 * Either way the listener forwards each JSON-RPC message here, the editor's own
 * server answers it, and the reply goes back out the same way.
 *
 * That routing is deliberate. Nothing about the tool catalogue crosses the
 * boundary — both listeners frame HTTP and never learn what a clip is, and
 * `server.ts` stays the only place that decides what an agent can do. A call that
 * arrives over HTTP and the same call made in the panel are indistinguishable,
 * which is what makes the panel trustworthy as a way to test the integration.
 *
 * Where neither host exists — a static build, say — every function here degrades
 * to "not available" rather than pretending otherwise.
 */
import { createDevServerHost } from "@/lib/mcp/browserHost";
import { agentServer } from "@/lib/mcp/session";
import type { BroadcastBridge } from "@/lib/broadcastHost";
import type { StoreBridge } from "@/lib/storage";
import type { WindowControlsBridge } from "@/lib/windowControls";

/** Fixed on purpose: a client configures this exact port once and relies on it. */
export const PREFERRED_MCP_PORT = 51351;

export interface HttpHostStatus {
  /** Is there a listener to talk to at all? False in a static build. */
  available: boolean;
  /** Which one is holding the socket, so the panel can say where it is served from. */
  backing: "none" | "desktop" | "dev-server";
  running: boolean;
  /** The full endpoint, e.g. `http://127.0.0.1:51351/mcp`. */
  url: string | null;
  port: number | null;
  /** JSON-RPC messages handled since the listener started. */
  requests: number;
  startedAt: number | null;
  lastRequestAt: number | null;
  /** The last thing that went wrong, phrased for a human. */
  error: string | null;
  /** Clients currently holding an event stream open. */
  streams: number;
}

/**
 * What a host looks like from here. `electron/preload.cjs` publishes this shape
 * across the context bridge, and `browserHost.ts` implements it against the dev
 * server, so nothing below this line needs to know which one it got.
 */
export interface HostBridge {
  status: () => Promise<unknown>;
  start: (port?: number) => Promise<unknown>;
  stop: () => Promise<unknown>;
  respond: (id: number, payload: unknown) => void;
  notify: (notification: unknown) => void;
  onRequest: (handler: (message: { id: number; payload: unknown }) => void) => void;
  onStatus: (handler: (status: unknown) => void) => void;
}

/**
 * The narrow settings channel `electron/preload.cjs` publishes alongside `mcp`
 * — a handful of API keys that need to survive a restart. See `src/lib/settings.ts`.
 */
export interface SettingsBridge {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string | null) => Promise<string | null>;
  getAll: () => Promise<Record<string, string | null>>;
}

/**
 * The one file-read verb the desktop app grants the sandboxed renderer, for
 * loading the agent's own local media (`import_media` with a `path`). Outside
 * the desktop app this bridge does not exist, so a local path is unavailable.
 */
export interface MediaBridge {
  read: (filePath: string) => Promise<{ data: Uint8Array | ArrayBuffer; name: string; size: number }>;
}

/**
 * Read one local file through the desktop bridge, or explain why that cannot
 * work. Electron prefixes an IPC rejection with the channel name, so that is
 * stripped here to leave a message a tool result can show verbatim.
 */
export async function readLocalFile(
  filePath: string,
): Promise<{ data: Uint8Array | ArrayBuffer; name: string; size: number }> {
  const bridge = typeof window === "undefined" ? undefined : window.octoCutHost?.media;
  if (!bridge) {
    throw new Error("Local file paths need the desktop app — pass a `url` instead.");
  }
  try {
    return await bridge.read(filePath);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw.replace(/^Error invoking remote method '[^']+':\s*/, "") || `Could not read "${filePath}".`;
    throw new Error(message);
  }
}

declare global {
  interface Window {
    // Every bridge `electron/preload.cjs` exposes lives on one object, so this
    // is the one place that declares its shape — a second `declare global`
    // elsewhere augmenting the same `octoCutHost` property would conflict rather
    // than merge, since TS requires identical types when a property is
    // redeclared. See `windowControls.ts` for the third bridge.
    octoCutHost?: {
      mcp: HostBridge;
      settings?: SettingsBridge;
      media?: MediaBridge;
      broadcast?: BroadcastBridge;
      store?: StoreBridge;
      windowControls?: WindowControlsBridge;
    };
  }
}

const NO_HOST: HttpHostStatus = {
  available: false,
  backing: "none",
  running: false,
  url: null,
  port: null,
  requests: 0,
  startedAt: null,
  lastRequestAt: null,
  error: null,
  streams: 0,
};

let cached: HttpHostStatus = NO_HOST;
let backing: HttpHostStatus["backing"] = "none";
let attached = false;
let devHost: HostBridge | null = null;
let probing = false;

const listeners = new Set<(status: HttpHostStatus) => void>();

/** The preload bridge, or `null` outside the desktop app. */
const desktopHost = (): HostBridge | null => (typeof window === "undefined" ? null : window.octoCutHost?.mcp ?? null);

/** Whichever listener this page has — the desktop app's, else the dev server's. */
const host = (): HostBridge | null => desktopHost() ?? devHost;

/** Whether a listener can exist at all. Answered from the bridge's presence. */
export const httpHostAvailable = (): boolean => host() !== null;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The status arrives from another process, so it is treated as untrusted input
 * and narrowed field by field. A missing field is not an error; it is simply not
 * running yet.
 */
function adopt(raw: unknown): HttpHostStatus {
  const value = (raw ?? {}) as Partial<HttpHostStatus>;
  const number = (input: unknown): number | null => (typeof input === "number" ? input : null);

  cached = {
    ...NO_HOST,
    running: value.running === true,
    url: typeof value.url === "string" ? value.url : null,
    port: number(value.port),
    requests: number(value.requests) ?? 0,
    startedAt: number(value.startedAt),
    lastRequestAt: number(value.lastRequestAt),
    error: typeof value.error === "string" ? value.error : null,
    streams: number(value.streams) ?? 0,
  };

  const next = current();
  for (const listener of listeners) listener(next);
  return next;
}

/**
 * Tell every client holding an event stream open that an edit has happened.
 *
 * MCP only permits a server to push to a client that subscribed, so this reads
 * the server's own subscription list rather than deciding for itself. Nothing is
 * sent when nobody is listening, and a failed call announces nothing — a tool
 * that refused did not change anything.
 */
function announceUpdates(request: unknown, reply: unknown): void {
  if ((request as { method?: string } | null)?.method !== "tools/call") return;

  const answer = reply as { error?: unknown; result?: { isError?: boolean } } | null;
  if (answer?.error || answer?.result?.isError) return;

  const target = host();
  if (!target) return;

  for (const uri of agentServer.state().subscriptions) {
    target.notify({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri } });
  }
}

/**
 * Wire one listener up. Whichever arrives first wins — a page is either inside
 * the desktop app or it is not, and nothing here is meant to run twice.
 */
function attach(target: HostBridge, from: HttpHostStatus["backing"]): void {
  if (attached) return;
  attached = true;
  backing = from;

  target.onStatus((status) => void adopt(status));

  target.onRequest(async (message) => {
    const id = message?.id;
    if (typeof id !== "number") return;

    let reply: unknown = null;
    try {
      reply = await agentServer.handle(message.payload);
    } catch (error) {
      // The server has already answered everything it understands; reaching
      // here means it threw outright, so the client gets an envelope it can
      // parse rather than a connection that simply hangs.
      reply = { jsonrpc: "2.0", id: null, error: { code: -32603, message: describe(error) } };
    }

    // A notification legitimately has no reply, and `null` says exactly that.
    target.respond(id, reply);
    if (reply) announceUpdates(message.payload, reply);
  });

  void target.status().then(adopt).catch(() => {});

  // Open the listener straight away, so the URL is live the moment the panel is.
  void startHttpServer();
}

/**
 * Attach the renderer to whatever listener this page has. Called as the editor
 * boots for the same reason the window bridge is: an endpoint that only answers
 * after a button press would have nothing to say to a client that connected in
 * the meantime.
 *
 * Returns whether the desktop host was found. Outside the desktop app the dev
 * server's bridge is probed for asynchronously — `pnpm dev` in a browser tab
 * serves an endpoint too, and the panel hears about it when the probe lands.
 */
export function installHttpHost(): boolean {
  const desktop = desktopHost();
  if (desktop) {
    attach(desktop, "desktop");
    return true;
  }

  if (!probing) {
    probing = true;
    void (async () => {
      const candidate = createDevServerHost();
      if (!(await candidate.probe())) return;
      devHost = candidate;
      attach(candidate, "dev-server");
    })();
  }

  return false;
}

/** Begin listening. Resolves with the state actually reached, taken or not. */
export async function startHttpServer(port: number = PREFERRED_MCP_PORT): Promise<HttpHostStatus> {
  const target = host();
  if (!target) return cached;
  try {
    return adopt(await target.start(port));
  } catch (error) {
    return adopt({ ...cached, running: false, error: describe(error) });
  }
}

/** Stop listening and close any event streams. The port is released. */
export async function stopHttpServer(): Promise<HttpHostStatus> {
  const target = host();
  if (!target) return cached;
  try {
    return adopt(await target.stop());
  } catch (error) {
    return adopt({ ...cached, error: describe(error) });
  }
}

/**
 * `available` and `backing` are answered from the bridge's presence rather than
 * from the cached payload, so the panel does not spend the first round-trip
 * insisting this is a static page when a listener is sitting right there.
 */
const current = (): HttpHostStatus => {
  const live = host() !== null;
  return { ...cached, available: live, backing: live ? backing : "none" };
};

export const httpHostStatus = (): HttpHostStatus => current();

export function subscribeHttpHostStatus(listener: (status: HttpHostStatus) => void): () => void {
  listeners.add(listener);
  listener(current());
  return () => listeners.delete(listener);
}
