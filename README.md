<p align="center">
  <img src="src/assets/soloman-editor-logo.png" alt="Soloman Editor logo" width="220" />
</p>

# Soloman Editor

A video editor that runs entirely in the browser. Import clips, images and audio, arrange them on a
multi-track timeline, animate them with keyframes, and export a real video file — no upload, no
server, no account. Your media never leaves your machine.

> **Soloman Editor is fully client-side.** Rendering and video encoding both happen in the tab, using
> Canvas 2D, Web Audio and `MediaRecorder`.

---

## Features

- **Multi-layer timeline** — video, image, text, audio, sticker and effect layers, each with its own
  start time, duration and trim (`inPoint`), stacked by z-index.
- **Direct manipulation on the stage** — drag, resize and rotate layers with snapping, alignment
  guides, grid and safe-area overlays.
- **Keyframe animation** — animate opacity, position, scale, rotation and volume, per property,
  with linear / ease-in / ease-out / ease-in-out easing.
- **A 45-strong transition catalogue** — basic dissolves, motion, wipes, shape reveals, light,
  glitch, blur and real GLSL shader warps (ported from the MIT `gl-transitions` collection), each
  applied to a clip's own enter or exit edge.
- **Filters & looks** — one-click looks plus brightness, contrast, saturation, blur, grayscale,
  sepia and hue-rotate; blend modes.
- **Asset library** — a category rail with media, stock, video, audio, overlays, effects,
  transitions, filters, shapes, stickers, text and backgrounds. Every card's thumbnail is rendered
  by the *same* code that draws the frame, so a preview can never misrepresent a result.
- **Free stock search** — live search across Wikimedia Commons and the Metropolitan Museum's
  open-access collection, with optional Pixabay and Pexels keys. Downloads arrive through the
  ordinary import path, so a stock photo behaves exactly like a local file.
- **Generated sound pack** — impacts, whooshes, UI ticks and ambience synthesised in the browser
  with `OfflineAudioContext`, auditioned as the real buffer that will be added.
- **Text and stickers** — full text styling (font, weight, colour, alignment, spacing, outline,
  shadow, background pill) plus emoji stickers.
- **Audio mixing** — per-layer volume with fade in/out and gain envelopes scheduled on Web Audio.
- **Undo / redo** — a full project-graph history that keeps continuous edits (drags, sliders) in a
  single step.
- **Real export** — renders to MP4 or WebM through `MediaRecorder`, with a live monitor showing
  progress, size and elapsed time.

Open the app and it boots with a generated demo project so there is something to play with
immediately.

---

## Getting started

```bash
pnpm install
pnpm dev        # dev server on http://localhost:8080
pnpm build      # production build
pnpm preview    # preview the production build
pnpm lint       # eslint
```

### As a desktop app

```bash
pnpm electron:dev        # Vite + Electron together, hot reload in the window
pnpm electron:start      # build, then run the real production bundle
pnpm electron:build      # build installers into release/
pnpm electron:build:dir  # unpacked app only — quicker, no installer
```

`pnpm dev` opens the editor in a plain browser tab, and so does the desktop app. Packaging is
configured in `electron-builder.yml` (dmg on macOS, NSIS + portable on Windows, AppImage + deb on
Linux), and `main` in `package.json` points at `electron/main.cjs`.

Both routes host the MCP endpoint described below — the dev server serves one on its own port, so you
do not need Electron to drive the editor from an AI tool.

`pnpm electron:build` expects a 1024×1024 `build/icon.png`; without it electron-builder falls back to
the stock Electron icon and the installers are unsigned, so the OS will warn on first launch.

On Linux, `electron:dev` and `electron:start` start Electron through `electron/launch.cjs` instead of
calling `electron` directly. Chromium's sandbox needs either a setuid `chrome-sandbox` helper or an
unprivileged user namespace, and `pnpm install` cannot create the first — only root may setuid a
file — so a fresh checkout has the helper sitting there *unconfigured*, which Electron treats as
fatal rather than falling back on:

```
The SUID sandbox helper binary was found, but is not configured correctly.
Rather than run without sandboxing I'm aborting now.
```

The launcher takes the best option the machine actually has and names the one it took. An
unconfigured helper is bypassed with `--disable-setuid-sandbox`, which lets the namespace sandbox
take over — the renderer is still sandboxed, only the mechanism changes. If no namespace is available
either (Ubuntu 24.04 restricts them through AppArmor), it falls back to `--no-sandbox` and prints the
`chown root:root … && chmod 4755 …` that would restore it. Packaged builds are unaffected:
electron-builder ships the helper and the installer sets its mode.

The main process narrates its own boot, because a window that never appears is otherwise
indistinguishable from a process that never started. Three lines, in order:

```
[soloman-editor] electron 44.3.0 ready on darwin (arm64)   ← Electron reached `app.whenReady`
[soloman-editor] window created — loading http://localhost:8080
[soloman-editor] editor loaded                              ← the first load finished
```

Read the first one you are missing. No line at all means Electron itself never started — usually an
incomplete `electron` install (`pnpm install` runs its postinstall download) or an environment with
no display. `window created` without `editor loaded` means the window exists and its load failed; the
window is still shown, on a four-second fallback timer, and displays the reason. And a window that
appears on its own saying *Soloman Editor could not load the editor* is the editor bundle failing rather
than Electron: it names the URL and the error code, and the terminal says so too.

---

## Releases & auto-update

The desktop app ships through a two-repository setup: source lives in the private
`solomaneditor-source` repo, and installers are published to the public `solomaneditor` repo, where
`electron-updater` reads its feed. On macOS and Windows the app checks for updates at
launch and hourly, downloads them in the background, and shows an "Update ready —
restart" button in the top bar. Linux updates are manual.

Usage is tracked anonymously with [Microsoft Clarity](https://www.npmjs.com/package/@microsoft/clarity)
and is on by default — turn it off any time under **Keys → Privacy** in the app.

The full build/release pipeline — CI matrix, signing, secrets, versioning — is
documented in [`docs/BUILD_RELEASE_UPDATE.md`](docs/BUILD_RELEASE_UPDATE.md).

---

## How it works

The app is a React + Vite + TypeScript project styled with Tailwind CSS and shadcn/ui components.

```
src/
  types/editor.ts        Data model: layers, assets, keyframes, project, export jobs
  store/
    editorStore.ts       Single source of truth: project graph, selection, playhead, history
    createStore.ts       Dependency-free zustand-style store built on useSyncExternalStore
  lib/
    anim.ts              Layer + time -> concrete values (opacity, x, y, scale, rotation, volume)
    compositor.ts        drawFrame(): paints one frame into any 2D context
    geometry.ts          Direct-manipulation math in project pixels
    exporter.ts          Realtime export engine (MediaRecorder + separately mixed audio)
    media.ts             Import -> DOM element, poster frame, decoded audio, waveform peaks
    playback.ts          Video sync + Web Audio scheduler and gain envelopes
    project.ts           Timeline queries: duration, ordering, layer lookup
    importFiles.ts       File / drag-and-drop intake
    demo.ts              In-browser generated demo project
    time.ts              Timecode formatting and clamping helpers
    transitions.ts       Transition catalogue + ink model (one definition, three tiers)
    gl.ts                WebGL transition pass (GLSL ports of the gl-transitions collection)
    library.ts           Filter looks, effect presets, backgrounds, shapes, stickers, text styles
    preview.ts           Memoised thumbnail renders, reusing the compositor's own code
    stock.ts             Wikimedia / Met / Pixabay / Pexels clients
    sound.ts             Procedural sound pack (OfflineAudioContext -> WAV)
    random.ts            Seeded RNG so a preview and the export agree
    mcp/                 The agent interface: server, transport, tools, and both hosts
  components/editor/     EditorShell, Stage, Timeline, Inspector, TopBar, Transport, ...
    library/             AssetLibrary + one file per tab, with the shared rail/cards
  hooks/                 usePlayback, useShortcuts
  pages/Index.tsx        Entry page

vite/
  mcp-bridge.ts          The dev server's MCP transport — framing only, same as below
electron/
  main.cjs               Window, the app:// scheme, and the listener's lifecycle
  launch.cjs             Dev entry point: picks the Linux sandbox flags, then starts Electron
  mcp-http.cjs           The desktop MCP transport — framing only, no editor knowledge
  preload.cjs            The context-isolated bridge both of those talk through
```

### Three things worth knowing

**Preview and export share one renderer.** `lib/compositor.ts::drawFrame()` paints a frame into any
2D context. The preview passes it the on-screen canvas, the exporter passes it a recording canvas, so
what you see is what gets written. Nothing is reimplemented for export.

**Animation is evaluated, not baked.** `lib/anim.ts` takes a layer and a point in time and returns
the concrete property values for that instant, sampling the layer's keyframes with easing. The
compositor and the audio scheduler both read from that. Keyframe times are layer-local, so trimming
a clip never shifts its animation.

**History snapshots the project graph only.** Selection, playhead and zoom stay out of undo, and
`useHistoryGesture` folds a continuous edit into one entry.

**A transition is defined once, as data plus an ink function.** `lib/transitions.ts` holds the whole
catalogue and one pure `makeRamp(type, progress)` that returns *ink* — a clip mask, transform nudges
and an overlay. The compositor applies that ink to the frame; the library thumbnails and the
inspector preview call the identical function. There is no separate "preview mode", which is why a
transition card cannot misrepresent what it does. Capability falls into three tiers chosen per
transition: transform (alpha/offset/scale/rotation), raster (a scratch surface for feathering,
slices, RGB split) and shader (a real GLSL pass via `lib/gl.ts`).

### Export

Export is a *realtime capture*: the renderer drives the store playhead (so the preview doubles as an
export monitor), draws each frame through the compositor, and records the canvas plus a separately
mixed audio graph into a real file. Browsers only timestamp media as it is actually produced, so an
offscreen fast-forward render would produce a file that plays at the wrong speed. Realtime keeps
picture, sound and container timing identical.

Format support is probed at runtime — `exportSupport()` asks `MediaRecorder.isTypeSupported`, and the
export dialog only offers what the current browser can actually write. Chrome and Edge can typically
write both MP4 and WebM; Firefox and Safari usually cannot produce MP4 locally, so pick WebM there.

---

## Driving it from an AI tool

The editor embeds a Model Context Protocol server — 60 tools across six groups. **Observe** tools
read the timeline, selection and playhead; **Control** tools perform edits; **Media** finds stock
footage and places it; **Voice** speaks a line, transcribes a take and builds a voiced-over
sequence; **Projects** work the saved library and the starter templates; **Flows** are the
multi-step playbooks. There are resources and prompts alongside them.

`src/lib/mcp/tools.ts` composes the catalogue from `OBSERVE_TOOLS` and `CONTROL_TOOLS`,
`mediaTools.ts`, `voiceTools.ts` and `projectTools.ts` contribute the rest, `flows.ts` adds the
flows, `observe.ts` holds the readers they are built from, and `playbook.ts` is the prose an agent
is handed on connect. The agent panel in the top bar is a client of that same server, so anything it
can do, an external tool can do identically.
There are two ways in.

**The window bridge.** A `postMessage` bridge on the `soloman-editor:mcp` channel, for a host that already
has a handle on the page — a wrapper window, an extension, the agent panel itself. Nothing to
configure.

**The HTTP endpoint.** A real streamable-HTTP MCP server, served from whichever of the two shells you
are running:

| Where you are running | Endpoint |
| --- | --- |
| Desktop app | `http://127.0.0.1:51351/mcp` |
| `pnpm dev` in a browser | `http://localhost:8080/mcp` |

The agent panel prints the URL actually bound, with a copy button and a start/stop toggle. The
desktop app always binds exactly port 51351 — if it's taken, starting the listener fails rather
than silently landing on a different port a configured client wouldn't know to look for.

A page cannot open a listening socket, so the listener is never the renderer. There are two of them,
and both are transports and nothing more:

- **`electron/mcp-http.cjs`** binds `127.0.0.1` in the Electron **main process**. Every JSON-RPC
  message is forwarded over IPC to the renderer, where `src/lib/mcp/server.ts` answers it.
- **`vite/mcp-bridge.ts`** hangs the same endpoint off the port Vite is already using, so a plain
  browser tab serves one too. The page holds a long poll open (`/__soloman-editor/mcp/next`); the plugin
  hands it each incoming message and carries the reply back to the waiting client.

Either way the tool catalogue never crosses the boundary, and there is exactly one definition of
what an agent can do.

Three guards are worth knowing about, because they are what make a permissively-CORS'd localhost
server safe to leave running:

- **The desktop listener binds to `127.0.0.1` and refuses anything else.** Reaching the editor over
  the network was never asked for.
- **The `Host` header is validated.** The desktop app accepts `127.0.0.1`, `localhost` and `::1` at
  our own port; the dev bridge also accepts the one hostname the page itself announced at boot, so a
  dev server behind a proxy still advertises a URL that works. Anything else is a `403` before a
  route is considered. Without this, a web page you happen to visit — or a public DNS name pointed at
  `127.0.0.1` — could drive your editor.
- **The dev bridge's page channel is same-site only.** The page the server actually served is the
  only thing allowed to collect requests or post replies, so a foreign page cannot insert itself
  between a tool and the editor.

Routes follow the streamable-HTTP spec: `POST /mcp` for JSON-RPC (answered as JSON, or as a single
SSE frame when the client sends `Accept: text/event-stream`), `GET /mcp` for a held-open event
stream that forwards `notifications/resources/updated`, `DELETE /mcp` for session teardown, and
`OPTIONS` for preflight. Status is `GET /health` in the desktop app and `GET /mcp/health` on the dev
server, which namespaces it under the only path prefix it can claim. `GET /mcp` with no
`Accept: text/event-stream` returns a small page confirming the server is alive — and on the dev
server, `GET /` is still the editor.

Two tolerances are deliberate, and both exist because of how the failure reads. A client configured
as `…/mcp/` is answering the same resource as `…/mcp`, and a client that cannot parse a stream is
not asking for one: **the path matches with or without a trailing slash, `/sse` is an alias for the
same endpoint, and a reply goes out as JSON whenever the client admits to accepting it.** Without
those, `…/mcp/` falls through to the single-page rewrite and is handed `index.html` where it
expected JSON — which it can only report as `tool discovery failed`, saying nothing about why.
`/sse` additionally announces `event: endpoint` on its stream, which is how the older HTTP+SSE
transport learns where to POST; clients on `/mcp` use the newer transport and are never sent it.

When a tool cannot connect, the endpoint says why rather than going quiet. A stopped endpoint is a
`503`, a `GET` that asked for neither a stream nor HTML is a `405` naming the method to use, and both
arrive as JSON-RPC error envelopes — the only shape a protocol client can actually report.

The dev bridge logs one line per request (`POST /mcp · accept: application/json, text/event-stream`),
and the desktop app logs the same over its stdout. That log is the fastest way to tell the two halves
of a connection failure apart: **a request that never appears in it never reached the server** — a
wrong port, a wrong host, or a client in another container — while a request that does appear was
answered and the reply is what was rejected.

---

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Step one frame |
| `Shift` + `←` / `→` | Seek one second |
| `↑` / `↓` | Nudge selected layers (`Shift` = 20px) |
| `Home` / `End` | Jump to start / end |
| `S` | Split at the playhead |
| `M` | Mute output |
| `L` | Toggle loop |
| `[` / `]` | Zoom timeline out / in |
| `Delete` / `Backspace` | Remove selected layers |
| `Ctrl/Cmd` + `Z` | Undo |
| `Ctrl/Cmd` + `Shift` + `Z`, `Ctrl/Cmd` + `Y` | Redo |
| `Ctrl/Cmd` + `A` | Select all |
| `Ctrl/Cmd` + `D` | Duplicate selection |
| `Ctrl/Cmd` + `E` | Open export |

Keystrokes inside a text field are ignored, so typing a caption never scrubs the timeline.

---

## Browser support

A modern Chromium, Firefox or Safari build with `MediaRecorder`, `AudioContext` and
`canvas.captureStream()`. Playback runs on a `requestAnimationFrame` loop that corrects video
elements only when they drift past a threshold, while audio is scheduled ahead of time through Web
Audio. Encoding quality and available formats follow the browser's own encoder.

---

## Known limitations

- **Projects autosave locally.** Work is written to a local store as you edit — SQLite in the desktop
  app, IndexedDB in a plain browser tab — so a reload restores your last project. Clearing the
  browser's site data removes it.
- **Keep the tab in the foreground while exporting.** The encoder is wall-clock driven; a backgrounded
  tab gets throttled and the recording will drift or stall.
- **MP4 is browser-dependent** (see *Export* above).
- **Shader transitions need WebGL.** The GLSL warps (swirl, ripple, melt, cross zoom, luma,
  cross warp, water drop) require a WebGL context; the inspector says so when one is unavailable.
  Every other transition is plain Canvas 2D and always works.
- **Stock search needs a network.** Results come straight from the public APIs, so with no
  connection the tab reports the failure and the bundled media, sounds, shapes and effects are
  unaffected.
- Imported media object URLs are never revoked, and deleting an asset leaves its layers in place.
