/**
 * THE DEV-SERVER MCP BRIDGE.
 *
 * The desktop app hosts the HTTP endpoint in its main process, because a page
 * cannot open a listening socket. A browser tab has no such process to lean on —
 * but while you are developing, it does have a server: Vite is already listening
 * on a port, so this plugin hangs the same streamable-HTTP MCP endpoint off it.
 * `pnpm dev` alone is then enough to give an AI tool a URL to connect to.
 *
 * The routing mirrors `electron/mcp-http.cjs` exactly, and that is the whole
 * point of the file: it frames HTTP, hands every JSON-RPC message to the page
 * over a long poll, and carries the reply back. `src/lib/mcp/server.ts` stays the
 * single place that decides what an agent can do — the tool catalogue never
 * crosses this boundary, so a call made through the dev server and the same call
 * made in the desktop app are indistinguishable.
 *
 * Two guards, both of them borrowed from the desktop app:
 *
 *   · THE MCP ENDPOINT ANSWERS LOOPBACK HOSTS ONLY, plus the one origin the page
 *     itself announced at boot (`POST /__octo-cut/mcp/hello`). That second case is
 *     what keeps the URL in the panel honest under a proxy: a dev server reached
 *     on some other hostname would otherwise advertise an endpoint it then
 *     refused. Announcing is safe because the bridge refuses cross-site callers —
 *     a foreign page cannot add its own hostname to the list.
 *   · THE INTERNAL ROUTES ARE SAME-SITE ONLY, for the same reason: the page this
 *     server actually served is the only thing allowed to talk to them.
 *
 * None of this ships. The plugin is registered for the dev and preview servers
 * only; a built bundle is just files, and the panel says so.
 *
 * Two smaller tolerances are load-bearing rather than cosmetic. The path matches
 * with or without a trailing slash, and a reply goes out as plain JSON whenever
 * the client admits to accepting it. Without them a client configured as
 * `…/mcp/` gets the SPA's `index.html`, and one that only understands a JSON body
 * gets a stream — both of which it can report as the same useless sentence,
 * "tool discovery failed".
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** What an AI tool is pointed at — the same path the desktop app serves. */
const MCP_PATH = "/mcp";
/** An alias for the same endpoint, because clients append `/sse` to a base URL. */
const SSE_PATH = "/sse";
/** The page's own channel: it polls here for requests and posts replies back. */
const BRIDGE_PREFIX = "/__octo-cut/mcp";

/** Hostnames that mean "this machine". Anything else must have announced itself. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** How long `GET …/next` is held open before answering with an empty batch. */
const POLL_HOLD_MS = 25000;
/**
 * A wedged page must not hold an HTTP connection open forever. Wide enough for
 * a short async tool (one stock-media search, a quick TTS preview) to finish —
 * anything genuinely long-running (the voiceover pipeline) is queued as a
 * background job instead of answered inline, so it never needs this.
 */
const DISPATCH_TIMEOUT_MS = 60000;
const SSE_KEEPALIVE_MS = 15000;
/** How long after its last poll a page is still considered connected. */
const CONNECTION_GRACE_MS = POLL_HOLD_MS + 5000;

/* ------------------------------------------------------------------ *
 * Framing
 * ------------------------------------------------------------------ */

/** Split `host[:port]`, including the bracketed IPv6 form. */
function splitHostHeader(value: string): [string, string | undefined] {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return [value, undefined];
    const rest = value.slice(end + 1);
    return [value.slice(1, end), rest.startsWith(":") ? rest.slice(1) : undefined];
  }
  const colon = value.lastIndexOf(":");
  if (colon === -1) return [value, undefined];
  return [value.slice(0, colon), value.slice(colon + 1)];
}

const sendText = (res: ServerResponse, status: number, text: string): void => {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
};

const sendEmpty = (res: ServerResponse, status: number): void => {
  res.writeHead(status);
  res.end();
};

function applyCors(res: ServerResponse, origin: string | undefined): void {
  res.setHeader("access-control-allow-origin", origin || "*");
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, accept, mcp-protocol-version, mcp-session-id, authorization");
  res.setHeader("access-control-expose-headers", "mcp-session-id");
}

const rpcFault = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const acceptHeader = (req: IncomingMessage): string => String(req.headers.accept ?? "").toLowerCase();

const acceptsEventStream = (req: IncomingMessage): boolean => acceptHeader(req).includes("text/event-stream");

/** A browser pasting the URL asks for HTML; `curl` asks for anything at all. */
const wantsHtml = (req: IncomingMessage): boolean => {
  const accept = acceptHeader(req);
  return accept.includes("text/html") || accept.includes("*/*") || accept.trim() === "";
};

/**
 * Does the client take a plain JSON body? MCP clients send
 * `Accept: application/json, text/event-stream`, so JSON is almost always
 * acceptable — and it is the easier of the two to read back. A reply sent as a
 * stream that ends after a single frame is legal, but a client that does not
 * handle that shape reports a perfectly good answer as a failure, so JSON wins
 * whenever the client admits to understanding it.
 */
const acceptsJson = (req: IncomingMessage): boolean => acceptHeader(req).includes("application/json");

const sseFrame = (payload: unknown): string => `event: message\ndata: ${JSON.stringify(payload)}\n\n`;

/**
 * Is this a request from the page itself? The bridge carries an editor's own
 * messages, so a cross-site caller is refused before a route is considered.
 * A client that sends no `Sec-Fetch-Site` at all (curl, an older browser) is let
 * through — it is not a browser, so it can neither read a reply nor be a victim.
 */
function sameSite(req: IncomingMessage): boolean {
  const site = String(req.headers["sec-fetch-site"] ?? "");
  return site !== "cross-site" && site !== "same-site";
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Body is larger than ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB.`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readBody(req);
    if (!raw.trim()) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * The bridge
 * ------------------------------------------------------------------ */

/** One JSON-RPC message on its way to the page, and the reply on its way back. */
interface PendingRequest {
  id: number;
  payload: unknown;
  settle: (reply: unknown) => void;
}

type Middleware = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;

function createHandler(): Middleware {
  let nextId = 1;
  let listening = true;
  const startedAt = Date.now();
  let requests = 0;
  let lastRequestAt: number | null = null;
  let lastPollAt = 0;

  /** Dispatched but not yet collected by the page. */
  const queued: PendingRequest[] = [];
  /** Polls held open, waiting for a request to hand over. */
  const waiting: ((request: PendingRequest) => void)[] = [];
  /** In flight at the page, keyed by our own id — the client's id is the client's. */
  const outstanding = new Map<number, PendingRequest>();
  /** Open `GET /mcp` streams, waiting for notifications the editor produces. */
  const streams = new Set<ServerResponse>();
  /** Origins the page has claimed as its own, so a proxied dev server still works. */
  const announced = new Set<string>();

  const status = () => ({
    running: listening,
    requests,
    startedAt,
    lastRequestAt,
    streams: streams.size,
    error: null as string | null,
  });

  const connected = (): boolean => {
    const result = waiting.length > 0 || Date.now() - lastPollAt < CONNECTION_GRACE_MS;
    console.log(`[octo-cut debug] connected() -> ${result}, waiting=${waiting.length}, lastPollAt=${lastPollAt}, now=${Date.now()}, delta=${Date.now() - lastPollAt}`);
    return result;
  };

  const endStreams = (): void => {
    for (const res of [...streams]) {
      try {
        res.end();
      } catch {
        // Already gone.
      }
    }
    streams.clear();
  };

  /* ------------------------------ the page's channel ------------------------------ */

  /** Hand a request to a waiting poll, or park it until one comes back. */
  function deliver(entry: PendingRequest): void {
    const waiter = waiting.shift();
    if (waiter) waiter(entry);
    else queued.push(entry);
  }

  /** Send one JSON-RPC message to the editor and resolve with its reply. */
  function dispatch(payload: unknown): Promise<unknown> {
    if (!connected()) {
      return Promise.reject(new Error("No editor is connected to this endpoint. Open the app in a tab and try again."));
    }

    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        outstanding.delete(id);
        reject(new Error(`The editor did not answer within ${Math.round(DISPATCH_TIMEOUT_MS / 1000)}s.`));
      }, DISPATCH_TIMEOUT_MS);

      const entry: PendingRequest = {
        id,
        payload,
        settle: (reply) => {
          clearTimeout(timer);
          outstanding.delete(id);
          resolve(reply);
        },
      };

      outstanding.set(id, entry);
      deliver(entry);
    });
  }

  /** `GET …/next` — held open until there is something for the page to answer. */
  async function handleNext(res: ServerResponse): Promise<void> {
    lastPollAt = Date.now();

    const ready = queued.splice(0);
    if (ready.length) return sendJson(res, 200, { requests: ready, status: status() });

    const entry = await new Promise<PendingRequest | null>((resolve) => {
      let finished = false;
      const done = (value: PendingRequest | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const at = waiting.indexOf(waiter);
        if (at !== -1) waiting.splice(at, 1);
        resolve(value);
      };
      const waiter = (value: PendingRequest) => done(value);
      const timer = setTimeout(() => done(null), POLL_HOLD_MS);

      waiting.push(waiter);

      // Only the response is watched. Its `close` fires when the response
      // finishes *or* the connection dies first — the two events this needs —
      // whereas a request stream is done as soon as its message has been
      // received, which for a bodyless GET is immediately. Hanging the hold off
      // that would answer every poll at once and turn the page into a spin loop.
      res.on("close", () => done(null));
    });

    sendJson(res, 200, { requests: entry ? [entry] : [], status: status() });
  }

  /** `POST …/reply` — the page's answer to a request. `null` means notification. */
  async function handleReply(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const id = body?.id;
    const entry = typeof id === "number" ? outstanding.get(id) : undefined;
    if (!entry) return sendJson(res, 200, { ok: false, reason: "That request is no longer waiting.", status: status() });
    entry.settle(body?.payload ?? null);
    sendJson(res, 200, { ok: true, status: status() });
  }

  /** `POST …/notify` — a notification the page wants pushed to open streams. */
  async function handleNotify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const notification = await readJson(req);
    if (notification && streams.size) {
      const frame = sseFrame(notification);
      for (const stream of [...streams]) {
        try {
          stream.write(frame);
        } catch {
          streams.delete(stream);
        }
      }
    }
    sendJson(res, 200, { ok: true, sent: streams.size });
  }

  /** `POST …/state` — start or stop answering, from the panel's own button. */
  async function handleState(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    listening = body?.listening !== false;
    if (!listening) {
      // A stopped endpoint should not leave a caller hanging on a reply that is
      // never coming, so everything in flight fails now.
      for (const entry of [...outstanding.values()]) {
        entry.settle(null);
        outstanding.delete(entry.id);
      }
      endStreams();
    }
    sendJson(res, 200, status());
  }

  /** `POST …/hello` — the page says which origin it is being served from. */
  async function handleHello(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const origin = typeof body?.origin === "string" ? body.origin : "";
    try {
      announced.add(new URL(origin).host.toLowerCase());
    } catch {
      return sendJson(res, 400, { ok: false, reason: "Expected a JSON body like { \"origin\": \"http://localhost:8080\" }." });
    }
    sendJson(res, 200, { ok: true, allowed: [...announced] });
  }

  async function handleBridge(req: IncomingMessage, res: ServerResponse, route: string): Promise<void> {
    applyCors(res, req.headers.origin);
    if (req.method === "OPTIONS") return sendEmpty(res, 204);
    if (!sameSite(req)) return sendText(res, 403, "Forbidden: the agent bridge answers this page only.");

    if (route === "status" && req.method === "GET") return sendJson(res, 200, status());
    if (req.method !== "POST") return sendText(res, 404, `No route for ${req.method} ${BRIDGE_PREFIX}/${route}.`);

    if (route === "next") return void handleNext(res);
    if (route === "reply") return void handleReply(req, res);
    if (route === "notify") return void handleNotify(req, res);
    if (route === "state") return void handleState(req, res);
    if (route === "hello") return void handleHello(req, res);
    return sendText(res, 404, `Unknown bridge route ${BRIDGE_PREFIX}/${route}.`);
  }

  /* ------------------------------ the MCP endpoint ------------------------------ */

  async function handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (error) {
      return sendJson(res, 413, rpcFault(null, -32600, error instanceof Error ? error.message : String(error)));
    }

    if (!raw.trim()) return sendJson(res, 400, rpcFault(null, -32700, "Empty body — POST a JSON-RPC message."));

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return sendJson(res, 400, rpcFault(null, -32700, `Body is not JSON: ${error instanceof Error ? error.message : "parse failed"}`));
    }

    const batch: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    const replies: unknown[] = [];
    for (const message of batch) {
      try {
        const reply = await dispatch(message);
        if (reply !== null && reply !== undefined) replies.push(reply);
      } catch (error) {
        // The editor never answered. Say so in the envelope the client is parsing
        // rather than leaving the connection hanging.
        const id = message && typeof message === "object" ? (message as { id?: unknown }).id : null;
        replies.push(rpcFault(id, -32603, error instanceof Error ? error.message : String(error)));
      }
    }

    requests += batch.length;
    lastRequestAt = Date.now();

    // Every message was a notification: accepted, nothing to report back.
    if (replies.length === 0) return sendEmpty(res, 202);

    const payload = Array.isArray(parsed) ? replies : replies[0];
    // A stream only when the client asked for one and gave up JSON to get it.
    if (acceptsEventStream(req) && !acceptsJson(req)) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" });
      return void res.end(sseFrame(payload));
    }
    sendJson(res, 200, payload);
  }

  function handleStream(res: ServerResponse, announceEndpoint: boolean): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    res.write(": octo-cut mcp stream — notifications from the editor\n\n");

    /**
     * The older HTTP+SSE transport has no way to know where to send its POSTs
     * until the server says so, and a client that never hears it waits forever —
     * which is another way to arrive at a bare "tool discovery failed". Only the
     * `/sse` alias announces, because only a client that chose `/sse` is speaking
     * that dialect; a client on `/mcp` is already using the newer transport.
     */
    if (announceEndpoint) res.write(`event: endpoint\ndata: ${MCP_PATH}\n\n`);

    streams.add(res);

    const keepAlive = setInterval(() => {
      try {
        res.write(": keep-alive\n\n");
      } catch {
        // The socket has gone; the close handler below cleans up.
      }
    }, SSE_KEEPALIVE_MS);

    const close = () => {
      clearInterval(keepAlive);
      streams.delete(res);
    };
    // As in `handleNext`: the response is what reports the client going away.
    res.on("close", close);
  }

  /** Pasted into a browser, this is the page that says the endpoint is alive. */
  function handleIndex(res: ServerResponse): void {
    const info = status();
    const body = [
      "<!doctype html><meta charset='utf-8'><title>Octo Cut — MCP</title>",
      "<style>body{background:#0d0d10;color:#e9e9f0;font:14px/1.6 ui-sans-serif,system-ui;margin:0;padding:48px}",
      "code{color:#93c5fd;font:13px ui-monospace,monospace}li{margin:2px 0}",
      "h1{font-size:17px;margin:0 0 4px}p{margin:0 0 20px;color:#8b8b98}</style>",
      "<h1>Octo Cut — MCP server</h1>",
      "<p>The editor is live and answering, from the dev server.</p>",
      "<ul>",
      "<li>Endpoint <code>/mcp</code> (POST JSON-RPC)</li>",
      "<li>Stream <code>/mcp</code> (GET, <code>Accept: text/event-stream</code>)</li>",
      `<li>Handled <code>${info.requests}</code> message(s) since start</li>`,
      "</ul>",
    ].join("");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  }

  function handleMcp(req: IncomingMessage, res: ServerResponse, path: string): void {
    applyCors(res, req.headers.origin);
    if (req.method === "OPTIONS") return sendEmpty(res, 204);

    const header = String(req.headers.host ?? "");
    const [hostname] = splitHostHeader(header.toLowerCase());
    if (!header || !(LOOPBACK_HOSTNAMES.has(hostname) || announced.has(header.toLowerCase()))) {
      return sendText(res, 403, "Forbidden: this endpoint answers loopback requests only.");
    }

    // One line per request. This is the log that answers "tool discovery failed":
    // it says whether the request arrived at all, and what it asked for. A client
    // that never appears here never reached this port, which no amount of
    // inspection on the client side can tell you.
    console.log(`[octo-cut] ${req.method} ${path} · accept: ${String(req.headers.accept ?? "(none)")}`);

    if (!listening) {
      // In an envelope rather than prose: a client that is parsing JSON-RPC
      // reports *this* message, which says what to do, instead of a bare
      // "tool discovery failed" caused by a body it could not parse.
      return sendJson(
        res,
        503,
        rpcFault(null, -32002, "The editor's HTTP endpoint is stopped. Start it from the Agent access panel."),
      );
    }

    // This server keeps no session, so teardown is a formality.
    if (req.method === "DELETE") return sendEmpty(res, 204);
    if (req.method === "POST") return void handlePost(req, res);
    if (req.method === "GET") {
      if (acceptsEventStream(req)) return handleStream(res, path === SSE_PATH);
      if (wantsHtml(req)) return handleIndex(res);
      // Wanted neither, so this was meant to be a POST. Say so in an envelope
      // the client can parse rather than handing it a page to choke on.
      res.setHeader("allow", "POST, GET, DELETE, OPTIONS");
      return sendJson(
        res,
        405,
        rpcFault(null, -32000, `GET ${MCP_PATH} needs \`Accept: text/event-stream\`. POST JSON-RPC messages to ${MCP_PATH} instead.`),
      );
    }
    return sendText(res, 404, `No route for ${req.method} ${MCP_PATH}. POST JSON-RPC to ${MCP_PATH}.`);
  }

  function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
    sendJson(res, 200, status());
  }

  /* ------------------------------ routing ------------------------------ */

  return (req, res, next) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");

    /**
     * A trailing slash names the same resource. Clients get configured with
     * `…/mcp/` about as often as `…/mcp`, and the near-miss is not a harmless
     * 404 here: the request falls through to Vite's SPA rewrite and the client
     * is handed `index.html` where it expected JSON — which it can only report
     * as a failed handshake, with nothing to say about why.
     */
    const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

    if (path === MCP_PATH || path === SSE_PATH) return handleMcp(req, res, path);
    if (path === `${MCP_PATH}/health`) return handleHealth(req, res);
    if (path === BRIDGE_PREFIX || path.startsWith(`${BRIDGE_PREFIX}/`)) {
      return void handleBridge(req, res, path.slice(BRIDGE_PREFIX.length + 1));
    }

    next();
  };
}

/**
 * Say on the terminal that the endpoint is mounted. Without it, "the tool cannot
 * find any tools" is indistinguishable from "the tool never reached this server",
 * and those two need opposite fixes.
 */
function announce(kind: string): void {
  console.log(`[octo-cut] MCP endpoint mounted on the ${kind} server — POST /mcp for JSON-RPC, GET /mcp for a stream.`);
}

/**
 * Registered for the dev and preview servers. `/` and every app route are left
 * alone — only `/mcp` and the page's own `__octo-cut` channel are ours.
 */
export function mcpBridge(): Plugin {
  return {
    name: "octo-cut:mcp-bridge",
    configureServer(server) {
      server.middlewares.use(createHandler());
      announce("dev");
    },
    configurePreviewServer(server) {
      server.middlewares.use(createHandler());
      announce("preview");
    },
  };
}
