/**
 * ELECTRON MAIN PROCESS.
 *
 * The renderer is the *same* React editor the web build serves, so this file
 * deliberately does very little: open a window, and feed it the built bundle.
 *
 * It does NOT load that bundle over `file://`. A file URL has an opaque origin,
 * and `history.pushState` throws a SecurityError from an opaque origin — which
 * is exactly what React Router's BrowserRouter calls on every navigation. It
 * would also make `fetch` to the stock-media APIs fail outright. So `dist/` is
 * served over a privileged `app://` scheme instead, which behaves like a normal
 * secure origin: history, fetch, CORS, ES modules, WebGL and `MediaRecorder` all
 * work unchanged, and no React code needs an Electron-specific branch.
 *
 * CommonJS (`.cjs`) because package.json sets `"type": "module"`; this keeps the
 * main process free of a build step.
 */

const { app, BrowserWindow, ipcMain, shell, protocol } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createMcpHttpServer, DEFAULT_PORT, DISPATCH_TIMEOUT_MS } = require("./mcp-http.cjs");
const { createSettingsStore } = require("./settings-store.cjs");
const { createBroadcast } = require("./broadcast.cjs");
const { createStore } = require("./db.cjs");

/* ------------------------------------------------------------------ *
 * Where the renderer comes from
 * ------------------------------------------------------------------ */

const SCHEME = "app";
const HOST = "octo-cut";
const ORIGIN = `${SCHEME}://${HOST}`;

const DIST_DIR = path.join(__dirname, "..", "dist");
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:8080";

/**
 * `electron . --dev` targets the Vite dev server (hot reload, source maps).
 * Anything else — including a packaged build — reads the files in `dist/`.
 * `app.isPackaged` is the backstop so a shipped app can never point at a dev
 * server, even if it somehow inherits a stray argument.
 */
const useDevServer = !app.isPackaged && process.argv.includes("--dev");

/* ------------------------------------------------------------------ *
 * The app:// protocol
 * ------------------------------------------------------------------ */

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Resolve an already-decoded pathname to a file inside `dist/`, or `null` when
 * the request must be refused. Returns a POSIX-style relative path, e.g.
 * `assets/index.js`.
 *
 * Two jobs, both of them security-relevant:
 *
 *   · It must never escape `dist/`. `..` is refused outright, and so is a
 *     backslash — Windows treats it as a separator, so `..\..\secret` would
 *     otherwise walk straight out of the root on that platform.
 *   · A path with no file extension is a client-side route, not a file, so it
 *     falls back to `index.html` — the same rewrite the hosting config applies.
 *     That keeps a deep link working instead of 404ing on a refresh.
 */
function relativePathFromDecoded(decoded) {
  if (decoded.includes("\0") || decoded.includes("\\")) return null;

  const parts = decoded.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) return null;

  const last = parts[parts.length - 1];
  return last && last.includes(".") ? parts.join("/") : "index.html";
}

/**
 * Percent-decoding has to happen first, and it is the step that matters for
 * traversal: `%2e%2e` is a perfectly ordinary string until it is decoded to
 * `..`, so the check above can only be trusted on the decoded form.
 */
function toRelativeAssetPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed %-escape
  }
  return relativePathFromDecoded(decoded);
}

/**
 * Serve the startup failure page for this reserved path. It is answered from
 * here rather than from `dist/` because there is nothing in `dist/` to serve:
 * the whole reason this page exists is that the editor would not load.
 */
const FAILURE_PATH = "/__startup-error";
/** What went wrong, for the page above. Set by `did-fail-load`. */
let startupFailure = null;

function failurePage() {
  const escape = (text) =>
    String(text).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);

  const fix = useDevServer
    ? "The Vite dev server did not answer. Start it with <code>pnpm dev</code> — or run <code>pnpm electron:dev</code>, which starts both."
    : "There is no build to load. Run <code>pnpm build</code> first, or use <code>pnpm electron:dev</code>.";

  return `<!doctype html><meta charset="utf-8"><title>Octo Cut</title>
<style>
body{background:#0d0d10;color:#e9e9f0;font:14px/1.6 ui-sans-serif,system-ui;margin:0;padding:48px}
h1{font-size:17px;margin:0 0 10px}p{margin:0 0 20px;color:#8b8b98;max-width:70ch}
code{color:#93c5fd;font:12.5px ui-monospace,monospace}
pre{white-space:pre-wrap;color:#8b8b98;font:12.5px ui-monospace,monospace;border-left:2px solid #2a2a33;padding-left:12px}
</style>
<h1>Octo Cut could not load the editor</h1>
<p>${fix}</p>
<pre>${escape(startupFailure ?? "No detail was reported.")}</pre>`;
}

function registerAppProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const { pathname } = new URL(request.url);

    if (pathname === FAILURE_PATH) {
      return new Response(failurePage(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    const relative = toRelativeAssetPath(pathname);

    if (!relative) {
      return new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } });
    }

    const file = path.join(DIST_DIR, ...relative.split("/"));

    try {
      const body = await fs.readFile(file);
      return new Response(body, {
        headers: {
          // Explicit, because a missing Content-Type on a module script makes
          // the browser refuse to execute it.
          "content-type": MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
          "content-length": String(body.byteLength),
        },
      });
    } catch {
      return new Response(`Not found: ${relative}`, { status: 404, headers: { "content-type": "text/plain" } });
    }
  });
}

/* ------------------------------------------------------------------ *
 * The MCP host
 * ------------------------------------------------------------------ */

/**
 * Every HTTP request that reaches this process is really a question for the
 * editor, and the editor lives in the renderer. So the main process forwards the
 * JSON-RPC message over IPC and holds the HTTP connection open until the reply
 * comes back, keyed by an id of our own making — the client's own id belongs to
 * the client, and two clients may well pick the same one.
 */
const pendingRequests = new Map();
let nextRequestId = 1;

function dispatchToEditor(payload) {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) {
    return Promise.reject(new Error("The editor window is not open, so nothing can answer."));
  }

  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`The editor did not answer within ${Math.round(DISPATCH_TIMEOUT_MS / 1000)}s.`));
    }, DISPATCH_TIMEOUT_MS);

    pendingRequests.set(id, { resolve, timer });
    win.webContents.send("octo-cut:mcp:request", { id, payload });
  });
}

/** Tell every window what the listener is doing now. */
function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

const mcpServer = createMcpHttpServer({
  dispatch: dispatchToEditor,
  log: (message) => console.log(`[octo-cut] ${message}`),
  onChange: (status) => broadcast("octo-cut:mcp:status", status),
});

/**
 * The live broadcaster. Its status events are forwarded to the renderer the same
 * way the MCP listener's are — the renderer subscribes with `onStatus`, and the
 * process that actually owns the ffmpeg child pushes changes up over IPC.
 */
const broadcaster = createBroadcast((status) => broadcast("octo-cut:broadcast:status", status));

function registerMcpIpc() {
  ipcMain.handle("octo-cut:mcp:status", () => mcpServer.status());
  ipcMain.handle("octo-cut:mcp:start", (_event, port) => mcpServer.listen(port ?? DEFAULT_PORT));
  ipcMain.handle("octo-cut:mcp:stop", () => mcpServer.stop());

  ipcMain.on("octo-cut:mcp:response", (_event, message) => {
    const id = message?.id;
    const entry = pendingRequests.get(id);
    if (!entry) return; // already timed out, or a duplicate
    pendingRequests.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(message.payload ?? null);
  });

  // The editor's own event log, pushed to any client holding GET /mcp open.
  ipcMain.on("octo-cut:mcp:event", (_event, notification) => mcpServer.notify(notification));
}

const settingsStore = createSettingsStore(app.getPath("userData"));
const store = createStore(app.getPath("userData"));

function registerStoreIpc() {
  ipcMain.handle("octo-cut:store:available", () => store.available);
  ipcMain.handle("octo-cut:store:get", (_event, domain, key) => store.get(domain, key));
  ipcMain.handle("octo-cut:store:getAll", (_event, domain) => store.getAll(domain));
  ipcMain.handle("octo-cut:store:count", (_event, domain) => store.count(domain));
  ipcMain.handle("octo-cut:store:put", (_event, domain, id, value, blob) => store.put(domain, id, value, blob));
  ipcMain.handle("octo-cut:store:putMany", (_event, domain, records) => store.putMany(domain, records));
  ipcMain.handle("octo-cut:store:delete", (_event, domain, key) => store.delete(domain, key));
}

function registerSettingsIpc() {
  ipcMain.handle("octo-cut:settings:get", (_event, key) => settingsStore.get(key));
  ipcMain.handle("octo-cut:settings:set", (_event, key, value) => settingsStore.set(key, value));
  ipcMain.handle("octo-cut:settings:getAll", () => settingsStore.getAll());
}

/**
 * Broadcast IPC — the renderer's only reach into the ffmpeg process. `start`
 * carries a pre-built ingest URL (with the key), a source file/URL, and the
 * protocol; the main process never logs any of it, and its status carries only
 * a label + protocol.
 */
function registerBroadcastIpc() {
  ipcMain.handle("octo-cut:broadcast:probe", () => broadcaster.probe());
  ipcMain.handle("octo-cut:broadcast:status", () => broadcaster.status());
  ipcMain.handle("octo-cut:broadcast:start", (_event, payload) => broadcaster.start(payload ?? {}));
  ipcMain.handle("octo-cut:broadcast:stop", () => broadcaster.stop());
  // Timeline broadcasts stream MediaRecorder chunks here, forwarded to ffmpeg's stdin.
  ipcMain.on("octo-cut:broadcast:chunk", (_event, chunk) => broadcaster.writeChunk(chunk));
}

/* ------------------------------------------------------------------ *
 * Local media
 *
 * The agent brings its own media (see `import_media` in
 * `src/lib/mcp/importTools.ts`), and when that media is already on this machine
 * the cheapest way in is to read the file here, where `fs` exists, and hand the
 * bytes to the renderer. One narrow verb — read a single regular file at a path
 * the agent supplied — and nothing more. The renderer is sandboxed and cannot
 * read files itself, so this channel is the whole surface.
 * ------------------------------------------------------------------ */

/** The largest file we will pull into memory on the agent's behalf. */
const MAX_LOCAL_MEDIA_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

function describeMediaError(error, filePath) {
  if (error?.code === "ENOENT") return `No file at "${filePath}".`;
  if (error?.code === "EACCES" || error?.code === "EPERM") return `Permission denied reading "${filePath}".`;
  return error instanceof Error ? error.message : String(error);
}

function registerMediaIpc() {
  ipcMain.handle("octo-cut:media:read", async (_event, filePath) => {
    if (typeof filePath !== "string" || filePath.trim() === "") {
      throw new Error("A file path is required.");
    }

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      throw new Error(describeMediaError(error, filePath));
    }

    if (!stat.isFile()) {
      throw new Error(`"${filePath}" is not a regular file.`);
    }
    if (stat.size > MAX_LOCAL_MEDIA_BYTES) {
      throw new Error(`"${filePath}" is larger than ${Math.round(MAX_LOCAL_MEDIA_BYTES / 1024 / 1024 / 1024)} GiB.`);
    }

    let data;
    try {
      data = await fs.readFile(filePath);
    } catch (error) {
      throw new Error(describeMediaError(error, filePath));
    }

    return { data, name: path.basename(filePath), size: stat.size };
  });
}

/* ------------------------------------------------------------------ *
 * Window controls
 *
 * `frame: false` (below) removes the OS title bar on every platform, so the
 * renderer draws its own — see `TopBar.tsx` — and needs a way to do what that
 * bar used to do for free. One handler per verb, resolved against whichever
 * window is asking, since `event.sender` is that window's own `webContents`.
 * ------------------------------------------------------------------ */

function registerWindowControlsIpc() {
  const windowOf = (event) => BrowserWindow.fromWebContents(event.sender);

  ipcMain.handle("octo-cut:window:minimize", (event) => windowOf(event)?.minimize());
  ipcMain.handle("octo-cut:window:toggleMaximize", (event) => {
    const win = windowOf(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle("octo-cut:window:close", (event) => windowOf(event)?.close());
  ipcMain.handle("octo-cut:window:isMaximized", (event) => windowOf(event)?.isMaximized() ?? false);
}

/* ------------------------------------------------------------------ *
 * The window
 * ------------------------------------------------------------------ */

/** Anything that is not the editor itself belongs in the user's real browser. */
const openExternally = (url) => {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
};

/**
 * How long to wait for a paintable first frame before showing the window anyway.
 *
 * `ready-to-show` is the nice path — it means the editor has actually painted and
 * there is nothing to flicker — but it is not a guarantee. It never arrives when
 * the first load fails, and a process holding no visible window is indistinguishable
 * from an app that did not start. This is the backstop that makes that impossible.
 */
const SHOW_FALLBACK_MS = 4000;

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    // The editor draws its own dark chrome; a white flash before first paint
    // would be the only light surface in the app.
    backgroundColor: "#0d0d10",
    title: "Octo Cut",
    // The default menu still supplies Ctrl+R and the devtools accelerator, but
    // a "File / Edit / View" bar over a video editor is clutter.
    autoHideMenuBar: true,
    // No native title bar on any platform — the renderer draws its own in
    // `TopBar.tsx`, wired up over `octo-cut:window:*` below.
    frame: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The one channel the renderer gets: the MCP host. See `preload.cjs`.
      preload: path.join(__dirname, "preload.cjs"),
      /**
       * Export is a realtime capture — the renderer drives the playhead and
       * records the canvas as the frames are actually produced, so time spent
       * with the window behind another is time the recording does not cover.
       * Chromium throttles a backgrounded renderer to a crawl; the editor warns
       * about this, and this flag is what makes the warning unnecessary.
       */
      backgroundThrottling: false,
    },
  });

  /**
   * Show the window once, whenever the first of several signals arrives. Idempotent
   * because several of them legitimately race: a normal boot fires `ready-to-show`,
   * a failed one fires the fallback timer, and a failure deep enough to matter may
   * fire both.
   */
  const reveal = () => {
    if (win.isDestroyed()) return;
    if (win.isVisible()) return;
    win.show();
    win.focus();
  };

  // The custom titlebar's maximize button needs to know which icon to show,
  // including when the state changes some other way (a double-click on the
  // bar, or the OS's own snap/tile gestures).
  const notifyMaximizedChange = () => {
    if (!win.isDestroyed()) win.webContents.send("octo-cut:window:maximized-changed", win.isMaximized());
  };
  win.on("maximize", notifyMaximizedChange);
  win.on("unmaximize", notifyMaximizedChange);

  win.once("ready-to-show", reveal);
  // `ready-to-show` is the preferred signal, not the only one: it is skipped
  // entirely when the first load fails. Showing on a timer as well means a broken
  // build or an absent dev server produces a window that says so, rather than a
  // running process with no window at all.
  const revealTimer = setTimeout(reveal, SHOW_FALLBACK_MS);
  win.once("closed", () => clearTimeout(revealTimer));

  // A `target="_blank"` in the stock panel should not open a bare Electron
  // window with no address bar.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });

  // The editor is the only page this window may ever show.
  win.webContents.on("will-navigate", (event, url) => {
    const internal = useDevServer ? url.startsWith(DEV_SERVER_URL) : url.startsWith(ORIGIN);
    if (internal) return;
    event.preventDefault();
    openExternally(url);
  });

  /**
   * With nothing on screen, a load failure is invisible: Electron logs it and
   * carries on, and the user is left looking at a process that appears not to have
   * started. So the failure is turned into the one thing that can be seen — a page
   * in the window that names the problem. Everything else still goes to the
   * console, where a packaged build can be diagnosed from.
   */
  let failed = false;
  win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    console.error(`[octo-cut] failed to load ${url} — ${description} (${code})`);
    if (useDevServer) {
      console.error(`[octo-cut] is the Vite dev server running on ${DEV_SERVER_URL}?`);
    }

    // A subframe's failure is not the editor's, and -3 is ABORTED, which is what
    // an ordinary superseded navigation reports. Neither should blank the window.
    if (!isMainFrame || code === -3 || url.startsWith(`${ORIGIN}${FAILURE_PATH}`)) return;

    if (!failed) {
      failed = true;
      startupFailure = `${url}\n${description} (${code})`;
      void win.loadURL(`${ORIGIN}${FAILURE_PATH}`);
    }
    reveal();
  });

  // Three lines that make a silent failure legible in the terminal: whether a
  // load was attempted at all, where it was pointed, and whether it landed. A
  // process that never logs even the first of them never got as far as a window.
  console.log(`[octo-cut] window created — loading ${useDevServer ? DEV_SERVER_URL : `${ORIGIN}/`}`);
  win.webContents.once("did-finish-load", () => console.log("[octo-cut] editor loaded"));

  if (useDevServer) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    // `/`, not `/index.html`: the protocol handler serves the same file for
    // both (see `relativePathFromDecoded`), but React Router's `<Route
    // path="/">` matches on `location.pathname` and only `/` is an exact hit.
    // Loading `/index.html` directly landed on the catch-all 404 route on
    // first paint, and only recovered once something navigated to `/`.
    void win.loadURL(`${ORIGIN}/`);
  }

  return win;
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

// Must run before `app.whenReady()`. `standard` gives the scheme a real tuple
// origin (so history and relative URLs behave); `secure` keeps it out of the
// "insecure origin" bucket; `stream` matters for media.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

app.whenReady().then(async () => {
  // First line of the app's own log. It is written before anything can go wrong
  // with a window, so its absence means Electron never reached this point at all
  // — which is the difference between "the window is hidden" and "nothing started".
  console.log(`[octo-cut] electron ${process.versions.electron} ready on ${process.platform} (${process.arch})`);

  /**
   * Each startup step is guarded on its own, because they used to share one
   * fate: anything that threw in here skipped `createWindow` entirely, and a
   * process holding no window looks exactly like an app that did not launch —
   * which is the hardest possible thing to diagnose from the outside.
   */
  const attempt = (what, step) => {
    try {
      step();
    } catch (error) {
      console.error(`[octo-cut] could not set up ${what} — ${error?.message ?? error}`, error);
    }
  };

  attempt("the app:// protocol", registerAppProtocol);
  attempt("the MCP IPC channels", registerMcpIpc);
  attempt("the settings IPC channel", registerSettingsIpc);
  attempt("the store IPC channels", registerStoreIpc);
  attempt("the media IPC channel", registerMediaIpc);
  attempt("the broadcast IPC channels", registerBroadcastIpc);
  attempt("the window-control IPC channels", registerWindowControlsIpc);

  if (!useDevServer) {
    try {
      await fs.access(path.join(DIST_DIR, "index.html"));
    } catch {
      console.error(`[octo-cut] No build in ${DIST_DIR}. Run \`pnpm build\` first, or use \`pnpm electron:dev\`.`);
    }
  }

  try {
    createWindow();
  } catch (error) {
    console.error(`[octo-cut] could not create the window — ${error?.message ?? error}`, error);
    app.quit();
    return;
  }

  /**
   * Open the listener without waiting to be asked. The point of the URL is that
   * someone can paste it into an AI tool, and an endpoint that only exists after
   * a button press cannot be pasted anywhere useful. The panel can still stop it.
   */
  void mcpServer.listen(DEFAULT_PORT);

  // macOS keeps the app alive with no windows; clicking the dock icon reopens.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  void mcpServer.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
