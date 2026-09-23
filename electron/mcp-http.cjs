/**
 * THE HTTP MCP TRANSPORT.
 *
 * A renderer cannot open a listening socket, so the wire lives here in the main
 * process. This file is a transport and nothing more: it frames HTTP, decides
 * whether a request is allowed to be here at all, and hands every JSON-RPC
 * message to the editor over IPC. `src/lib/mcp/server.ts` stays the single
 * source of truth for what tools exist and what they do — the main process never
 * learns what a clip is.
 *
 * Three decisions worth stating, because both are choices:
 *
 *   · IT BINDS TO 127.0.0.1 ONLY. This server drives a video editor. Reaching it
 *     from the network is not something anyone asked for.
 *   · THE HOST HEADER IS CHECKED, and that check is what makes the permissive
 *     CORS below safe. Answering any Host at all is how a localhost server ends
 *     up drivable by a random web page — or by a public DNS name pointed at
 *     127.0.0.1. Only `127.0.0.1`, `localhost` and `::1`, at our own port, get
 *     past this; everything else is a 403 before a route is even considered.
 *   · GET IS AN EVENT STREAM. MCP's streamable HTTP lets a client hold a GET open
 *     to receive server-initiated notifications, so the editor's own event log is
 *     forwarded down it. A client that never asks loses nothing.
 *
 * Two tolerances here are deliberate, and they exist because of how the failure
 * reads: a client configured as `…/mcp/` and one that cannot parse a stream are
 * both told only "tool discovery failed", with nothing saying why. So the path
 * matches with or without a trailing slash, and a reply goes out as JSON whenever
 * the client admits to accepting it.
 */
"use strict";

const http = require("node:http");

/**
 * High, unusual, and out of the way of anything else a developer runs. Fixed
 * on purpose: a client configures this exact port once and expects it to keep
 * working, so the server binds here or not at all — it never walks up to a
 * different port on collision.
 */
const DEFAULT_PORT = 51351;
const BIND_ADDRESS = "127.0.0.1";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/**
 * A wedged renderer must not hold an HTTP connection open forever. Wide enough
 * for a short async tool (one stock-media search, a quick TTS preview) to
 * finish — anything genuinely long-running (the voiceover pipeline) is queued
 * as a background job instead of answered inline, so it never needs this.
 */
const DISPATCH_TIMEOUT_MS = 60000;
const SSE_KEEPALIVE_MS = 15000;

/** Hostnames that mean "this machine". Anything else is refused. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

/* ------------------------------------------------------------------ *
 * Host header
 * ------------------------------------------------------------------ */

/** Split `host[:port]`, including the bracketed IPv6 form. */
function splitHostHeader(value) {
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

/**
 * Is this request addressed to us at all? A browser will send the Host of the
 * page that made the fetch, which is exactly what makes this check worth having:
 * `Host: evil.example` resolving to 127.0.0.1 is refused here.
 */
function hostAllowed(header, port) {
  if (typeof header !== "string" || header === "") return false;
  const [hostname, headerPort] = splitHostHeader(header.toLowerCase());
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
  // A mismatched port is not proof of anything either way, but a stated one
  // must be ours.
  return headerPort === undefined || headerPort === String(port);
}

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */

function applyCors(res, origin) {
  res.setHeader("access-control-allow-origin", origin || "*");
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, accept, mcp-protocol-version, mcp-session-id, authorization");
  res.setHeader("access-control-expose-headers", "mcp-session-id");
}

const sendText = (res, status, text) => {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
};

const sendJson = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
};

const rpcFault = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

const wantsEventStream = (req) => String(req.headers.accept ?? "").toLowerCase().includes("text/event-stream");

/**
 * A browser pasting the endpoint in asks for HTML; `curl` asks for anything.
 * Either should see the status page rather than a protocol error.
 */
const acceptsHtml = (req) => {
  const accept = String(req.headers.accept ?? "").toLowerCase();
  return accept.includes("text/html") || accept.includes("*/*") || accept.trim() === "";
};

/** JSON is easier to read back than a stream that ends after one frame. */
const acceptsJson = (req) => String(req.headers.accept ?? "").toLowerCase().includes("application/json");

const sseFrame = (payload) => `event: message\ndata: ${JSON.stringify(payload)}\n\n`;

/**
 * A trailing slash names the same resource. `…/mcp/` is as common a way to write
 * the endpoint as `…/mcp`, and without this it would 404 with a plain-text body
 * that a JSON-RPC client can only report as a failed handshake.
 */
const normalisePath = (pathname) => (pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname);

/* ------------------------------------------------------------------ *
 * The server
 * ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {(payload: unknown) => Promise<unknown>} options.dispatch
 *   Send one JSON-RPC message to the editor, resolve with its reply (or `null`
 *   when the message was a notification that must not be answered).
 * @param {(message: string) => void} [options.log]
 * @param {(status: object) => void} [options.onChange]
 *   Called whenever the state a panel would display has moved: the listener
 *   started or stopped, a message was handled, or a stream opened or closed.
 *   Whoever owns the window turns this into one broadcast.
 */
function createMcpHttpServer({ dispatch, log = () => {}, onChange = () => {} }) {
  const state = {
    server: null,
    port: null,
    url: null,
    startedAt: null,
    lastRequestAt: null,
    requests: 0,
    error: null,
  };

  /** Open `GET /mcp` streams, waiting for notifications the editor produces. */
  const streams = new Set();

  const status = () => ({
    running: state.server !== null,
    url: state.url,
    port: state.port,
    requests: state.requests,
    startedAt: state.startedAt,
    lastRequestAt: state.lastRequestAt,
    error: state.error,
    streams: streams.size,
  });

  /* ------------------------------ reading ------------------------------ */

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (chunk) => {
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

  /* ------------------------------ routes ------------------------------ */

  async function handlePost(req, res) {
    let raw;
    try {
      raw = await readBody(req);
    } catch (error) {
      return sendJson(res, 413, rpcFault(null, -32600, error.message));
    }

    if (!raw.trim()) {
      return sendJson(res, 400, rpcFault(null, -32700, "Empty body — POST a JSON-RPC message."));
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return sendJson(res, 400, rpcFault(null, -32700, `Body is not JSON: ${error.message}`));
    }

    // A batch is an array of messages; a single message is the common case.
    const batch = Array.isArray(parsed) ? parsed : [parsed];
    const replies = [];
    for (const message of batch) {
      try {
        const reply = await dispatch(message);
        if (reply !== null && reply !== undefined) replies.push(reply);
      } catch (error) {
        // The editor never answered. Say so in the envelope the client is
        // parsing rather than leaving the connection hanging.
        const id = message && typeof message === "object" ? message.id ?? null : null;
        replies.push(rpcFault(id, -32603, error instanceof Error ? error.message : String(error)));
      }
    }

    state.requests += batch.length;
    state.lastRequestAt = Date.now();
    onChange(status());

    // Every message was a notification: accepted, nothing to report back.
    if (replies.length === 0) return res.writeHead(202).end();

    const payload = Array.isArray(parsed) ? replies : replies[0];
    // A stream only when the client asked for one and gave up JSON to get it.
    if (wantsEventStream(req) && !acceptsJson(req)) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" });
      return res.end(sseFrame(payload));
    }
    return sendJson(res, 200, payload);
  }

  function handleStream(res, announceEndpoint) {
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
    if (announceEndpoint) res.write("event: endpoint\ndata: /mcp\n\n");

    const client = { res };
    streams.add(client);
    onChange(status());

    const keepAlive = setInterval(() => {
      try {
        res.write(": keep-alive\n\n");
      } catch {
        // The socket has gone; the close handler below will clean up.
      }
    }, SSE_KEEPALIVE_MS);

    const close = () => {
      clearInterval(keepAlive);
      streams.delete(client);
      onChange(status());
    };
    // The response reports the client going away, whether the stream ended
    // normally or the connection dropped. The request stream is finished as
    // soon as its message is received, so it is not a liveness signal.
    res.on("close", close);
    log(`event stream opened (${streams.size} open)`);
  }

  /** A page a person can paste the URL into to check it is alive. */
  function handleIndex(res) {
    const info = status();
    const body = [
      "<!doctype html><meta charset='utf-8'><title>Octo Cut — MCP</title>",
      "<style>body{background:#0d0d10;color:#e9e9f0;font:14px/1.6 ui-sans-serif,system-ui;margin:0;padding:48px}",
      "code{color:#93c5fd;font:13px ui-monospace,monospace}li{margin:2px 0}",
      "h1{font-size:17px;margin:0 0 4px}p{margin:0 0 20px;color:#8b8b98}</style>",
      "<h1>Octo Cut — MCP server</h1>",
      "<p>The editor is live and answering.</p>",
      "<ul>",
      `<li>Endpoint <code>${info.url}</code> (POST JSON-RPC)</li>`,
      `<li>Stream <code>http://${BIND_ADDRESS}:${info.port}/mcp</code> (GET, <code>Accept: text/event-stream</code>)</li>`,
      `<li>Handled <code>${info.requests}</code> message(s) since start</li>`,
      "</ul>",
    ].join("");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  }

  function handleRequest(req, res) {
    // `localPort` rather than a captured value: the same handler is reused for
    // every port candidate, and only the bound one ever receives traffic.
    if (!hostAllowed(req.headers.host, req.socket.localPort)) {
      log(`refused ${req.headers.host ?? "a request with no Host"} — loopback only`);
      return sendText(res, 403, "Forbidden: this server answers loopback requests only.");
    }

    applyCors(res, req.headers.origin);

    if (req.method === "OPTIONS") return res.writeHead(204).end();

    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const path = normalisePath(pathname);
    const endpoint = path === "/" || path === "/mcp" || path === "/sse";

    // One line per request, for the same reason the dev bridge logs one: the
    // failure a client reports is a bare "tool discovery failed", and the only
    // thing that separates "the request never arrived" from "the reply was not
    // understood" is whether it shows up here.
    log(`${req.method} ${path} · accept: ${req.headers.accept ?? "(none)"}`);

    if (req.method === "POST" && endpoint) return void handlePost(req, res);
    if (req.method === "GET" && path === "/health") return void sendJson(res, 200, status());
    if (req.method === "DELETE" && endpoint) return res.writeHead(204).end();

    if (req.method === "GET" && endpoint) {
      if (wantsEventStream(req)) return void handleStream(res, path === "/sse");
      // Someone pasted the URL into a browser: show the status page, on `/mcp`
      // just as much as on `/`.
      if (acceptsHtml(req)) return void handleIndex(res);
      // Asked for neither, so this was meant to be a POST. Answered in a JSON-RPC
      // envelope, because that is the only answer a protocol client can report:
      // handed a status code alone it says "tool discovery failed" and nothing more.
      res.setHeader("allow", "POST, GET, DELETE, OPTIONS");
      return sendJson(
        res,
        405,
        rpcFault(null, -32000, `GET ${path} needs \`Accept: text/event-stream\`. POST JSON-RPC messages to ${path} instead.`),
      );
    }

    return sendText(res, 404, `No route for ${req.method} ${path}. POST JSON-RPC to /mcp.`);
  }

  /* ------------------------------ binding ------------------------------ */

  /** One bind attempt. A failed listen leaves nothing behind to clean up. */
  function bind(port) {
    return new Promise((resolve) => {
      const candidate = http.createServer(handleRequest);
      candidate.on("clientError", (_error, socket) => socket.destroy());
      candidate.on("error", (error) => {
        log(`listener error — ${error.message}`);
        state.error = error.message;
      });

      const settle = (error) => {
        candidate.removeListener("error", onError);
        candidate.removeListener("listening", onListening);
        resolve({ candidate, error });
      };
      const onError = (error) => settle(error);
      const onListening = () => settle(null);

      candidate.once("error", onError);
      candidate.once("listening", onListening);
      candidate.listen(port, BIND_ADDRESS);
    });
  }

  /**
   * Start listening on the preferred port, or on `DEFAULT_PORT` if none is
   * given. No fallback: a client that has this port configured must be able
   * to rely on it, so a collision is reported rather than silently landing on
   * a different port the client doesn't know about.
   */
  async function listen(preferredPort = DEFAULT_PORT) {
    if (state.server) return status();

    state.error = null;
    const wanted = Number.isInteger(preferredPort) && preferredPort > 0 ? preferredPort : DEFAULT_PORT;

    const { candidate, error } = await bind(wanted);
    if (error) {
      if (error.code === "EADDRINUSE" || error.code === "EACCES" || error.code === "EADDRNOTAVAIL") {
        state.error = `Port ${wanted} is unavailable (${error.code}).`;
        return status();
      }
      throw error;
    }

    state.server = candidate;
    state.port = candidate.address().port;
    state.url = `http://${BIND_ADDRESS}:${state.port}/mcp`;
    state.startedAt = Date.now();
    state.lastRequestAt = null;
    state.requests = 0;
    state.error = null;
    log(`listening on ${state.url}`);
    onChange(status());
    return status();
  }

  function stop() {
    for (const client of [...streams]) {
      try {
        client.res.end();
      } catch {
        // Already gone.
      }
    }
    streams.clear();

    const server = state.server;
    state.server = null;
    state.port = null;
    state.url = null;
    state.startedAt = null;
    state.error = null;

    if (!server) {
      onChange(status());
      return Promise.resolve(status());
    }
    log("listener stopped");
    return new Promise((resolve) =>
      server.close(() => {
        onChange(status());
        resolve(status());
      }),
    );
  }

  /**
   * Push one JSON-RPC notification to every open stream. Returns how many
   * clients received it — zero when nobody is holding a stream open, which is
   * the normal case and not an error.
   */
  function notify(notification) {
    if (streams.size === 0) return 0;
    const frame = sseFrame(notification);
    let sent = 0;
    for (const client of [...streams]) {
      try {
        client.res.write(frame);
        sent += 1;
      } catch {
        streams.delete(client);
      }
    }
    return sent;
  }

  return { listen, stop, notify, status, DEFAULT_PORT };
}

module.exports = { createMcpHttpServer, DEFAULT_PORT, DISPATCH_TIMEOUT_MS, hostAllowed, splitHostHeader };
