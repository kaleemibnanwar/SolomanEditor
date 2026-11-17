/**
 * THE PRELOAD.
 *
 * The renderer runs sandboxed with context isolation on, so it has no `require`
 * and no Node — which is the point. This file is the only bridge it gets, and it
 * exposes three narrow, purpose-built channels: the MCP host, a small settings
 * store for a handful of API keys, and one file-read verb for local media. The
 * only file access is `media.read` — it reads a single regular file at a path
 * the agent supplied — nothing here can spawn a process or reach an arbitrary
 * IPC target; the channel names are fixed, and the payloads are plain JSON data
 * in both directions.
 *
 * The shape it publishes is a *client of the main process*, not a wrapper around
 * it — `start`/`stop`/`status` are the same three calls the panel makes, and the
 * request handler below is what turns an inbound HTTP body into a reply from the
 * editor's own server.
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/** Register `handler` for one channel. Returns nothing: nothing detaches. */
const listen = (channel, handler) => {
  ipcRenderer.on(channel, (_event, payload) => {
    try {
      handler(payload);
    } catch (error) {
      // A throwing renderer handler would otherwise surface as an unhandled
      // rejection inside Electron's IPC plumbing, which is much harder to read.
      console.error(`[soloman-editor] ${channel} handler failed`, error);
    }
  });
};

contextBridge.exposeInMainWorld("solomanEditorHost", {
  /** A handful of API keys that need to survive a restart. Narrow on purpose: no generic IPC. */
  settings: {
    get: (key) => ipcRenderer.invoke("soloman-editor:settings:get", key),
    set: (key, value) => ipcRenderer.invoke("soloman-editor:settings:set", key, value),
    getAll: () => ipcRenderer.invoke("soloman-editor:settings:getAll"),
  },

  /** One verb: read a single regular file at a path the agent supplied. */
  media: {
    read: (filePath) => ipcRenderer.invoke("soloman-editor:media:read", filePath),
  },

  /** The SQLite-backed durable store (projects, media, templates, macros, streams). */
  store: {
    available: () => ipcRenderer.invoke("soloman-editor:store:available"),
    get: (domain, key) => ipcRenderer.invoke("soloman-editor:store:get", domain, key),
    getAll: (domain) => ipcRenderer.invoke("soloman-editor:store:getAll", domain),
    count: (domain) => ipcRenderer.invoke("soloman-editor:store:count", domain),
    put: (domain, id, value, blob) => ipcRenderer.invoke("soloman-editor:store:put", domain, id, value, blob),
    putMany: (domain, records) => ipcRenderer.invoke("soloman-editor:store:putMany", domain, records),
    delete: (domain, key) => ipcRenderer.invoke("soloman-editor:store:delete", domain, key),
  },

  /** Drive the main process's ffmpeg to re-stream a file (or the live timeline). */
  broadcast: {
    probe: () => ipcRenderer.invoke("soloman-editor:broadcast:probe"),
    status: () => ipcRenderer.invoke("soloman-editor:broadcast:status"),
    start: (payload) => ipcRenderer.invoke("soloman-editor:broadcast:start", payload),
    stop: (id) => ipcRenderer.invoke("soloman-editor:broadcast:stop", id),
    /** A MediaRecorder chunk (timeline broadcast), forwarded to ffmpeg's stdin. */
    chunk: (payload) => ipcRenderer.send("soloman-editor:broadcast:chunk", payload),
    onStatus: (handler) => listen("soloman-editor:broadcast:status", handler),
  },

  mcp: {
    /** The listener's current state, whether or not it is running. */
    status: () => ipcRenderer.invoke("soloman-editor:mcp:status"),
    /** Start listening, preferring `port`. Resolves with the state it reached. */
    start: (port) => ipcRenderer.invoke("soloman-editor:mcp:start", port),
    stop: () => ipcRenderer.invoke("soloman-editor:mcp:stop"),

    /** The reply to a request that arrived over HTTP. `null` for a notification. */
    respond: (id, payload) => ipcRenderer.send("soloman-editor:mcp:response", { id, payload }),
    /** A notification to forward to every client holding an event stream open. */
    notify: (notification) => ipcRenderer.send("soloman-editor:mcp:event", notification),

    /** Inbound HTTP bodies, as `{ id, payload }`. */
    onRequest: (handler) => listen("soloman-editor:mcp:request", handler),
    /** The listener changed, without anyone having asked for the new state. */
    onStatus: (handler) => listen("soloman-editor:mcp:status", handler),
  },

  /** What the OS title bar used to do, now that `frame: false` removed it. */
  windowControls: {
    minimize: () => ipcRenderer.invoke("soloman-editor:window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("soloman-editor:window:toggleMaximize"),
    close: () => ipcRenderer.invoke("soloman-editor:window:close"),
    isMaximized: () => ipcRenderer.invoke("soloman-editor:window:isMaximized"),

    /** Fires on any change, not just ones made through the two calls above. */
    onMaximizedChange: (handler) => listen("soloman-editor:window:maximized-changed", handler),
  },

  /** Machine resources and network checks. */
  system: {
    stats: () => ipcRenderer.invoke("soloman-editor:system:stats"),
  },

  /** Auto-update (packaged builds only) — one status shape plus three verbs. */
  update: {
    status: () => ipcRenderer.invoke("soloman-editor:update:status"),
    check: () => ipcRenderer.invoke("soloman-editor:update:check"),
    download: () => ipcRenderer.invoke("soloman-editor:update:download"),
    install: () => ipcRenderer.invoke("soloman-editor:update:install"),
    onStatus: (handler) => listen("soloman-editor:update:status", handler),
  },
});
