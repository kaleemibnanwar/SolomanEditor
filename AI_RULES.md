# Tech Stack

- You are building a React application.
- Use TypeScript.
- Use React Router. KEEP the routes in src/App.tsx
- Always put source code in the src folder.
- Put pages into src/pages/
- Put components into src/components/
- The main page (default page) is src/pages/Index.tsx
- UPDATE the main page to include the new components. OTHERWISE, the user can NOT see any components!
- ALWAYS try to use the shadcn/ui library.
- Tailwind CSS: always use Tailwind CSS for styling components. Utilize Tailwind classes extensively for layout, spacing, colors, and other design aspects.

Available packages and libraries:

- The lucide-react package is installed for icons.
- You ALREADY have ALL the shadcn/ui components and their dependencies installed. So you don't need to install them again.
- You have ALL the necessary Radix UI components installed.
- Use prebuilt components from the shadcn/ui library after importing them. Note that these files shouldn't be edited, so make new components if you need to change them.

# Desktop shell & MCP

- This repo is also an Electron app. `main` in package.json is `electron/main.cjs`.
- `package.json` has `"type": "module"`, so **main-process files must be `.cjs`** (CommonJS `require`).
- A renderer cannot open a socket, so two things listen on its behalf and both are transport only —
  they frame HTTP and forward every JSON-RPC message to the renderer, where `src/lib/mcp/server.ts`
  answers it. The tool catalogue never crosses either boundary:
  - **Desktop**: `electron/mcp-http.cjs` binds 127.0.0.1 in the main process, bridged over
    `electron/preload.cjs`.
  - **Browser**: `vite/mcp-bridge.ts` hangs the same endpoint off the Vite dev/preview port, bridged
    over the `/__octo-cut/mcp/*` long-poll routes. Renderer half: `src/lib/mcp/browserHost.ts`;
    both hosts are adopted behind one interface in `src/lib/mcp/host.ts`.
- Tools live in `src/lib/mcp/` only — never duplicate editor logic in a listener file.
- The two listeners' routing must stay in step (`/mcp`, `/sse` as the older alias that announces
  `event: endpoint`, a trailing slash treated as the same resource, and a JSON body whenever the
  client's `Accept` admits to understanding one). A near-miss here is not a harmless 404: the client
  reports only "tool discovery failed", with nothing to say about why.
- The page opens its listener as it boots, so the URL is live without a button press; the panel's
  Start/Stop only toggles answering. `pnpm dev` in a browser tab is therefore enough on its own —
  never make the Agent access panel depend on Electron.
- Scripts use `pnpm` (`pnpm dev`, `pnpm electron:dev`, `electron:start`, `electron:build`). npm is not
  supported here: the repo is pnpm-managed and `npm install` fails on `pnpm-workspace.yaml`.
- `electron:dev` and `electron:start` start Electron through `electron/launch.cjs`, which resolves the
  Linux sandbox flags. A dev script must never invoke `electron` directly — a fresh checkout has an
  unconfigured `chrome-sandbox` and Electron aborts on it before `main.cjs` ever runs.
