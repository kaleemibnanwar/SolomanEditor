/**
 * THE MCP SERVER.
 *
 * The protocol layer: it takes a JSON-RPC message, routes it to the catalogues
 * (`tools.ts`, `flows.ts`), the readers (`observe.ts`) and the playbook, and
 * returns the envelope the spec asks for. It holds no editing logic and no
 * transport — a caller hands it a parsed message and gets back a response, or
 * `null` when the message was a notification that must not be answered.
 *
 * Two decisions worth stating, because both are choices:
 *
 *   · BAD ARGUMENTS are a protocol error (-32602). The request itself was
 *     malformed, and `schema.ts` can say exactly which path was wrong.
 *   · A TOOL THAT CANNOT DO ITS JOB is not. An unknown clip id, an empty
 *     selection, a transition that does not exist — those come back in-band
 *     with `isError: true`, so the model reads the reason and corrects itself
 *     in the same conversation instead of the host surfacing a transport fault.
 *
 * Because the server runs in the same page as the editor, `resources/read` is
 * not a snapshot: it renders the live state at the moment it is asked.
 */
import { buildAssets, buildEditorState, buildExportStatus, buildLibrary, buildProjects, buildSelection, buildTimeline } from "@/lib/mcp/observe";
import { EDITING_PLAYBOOK, PROMPT_TEMPLATES, SERVER_INSTRUCTIONS } from "@/lib/mcp/playbook";
import {
  MCP_PROTOCOL_VERSION,
  RPC_ERRORS,
  SERVER_CAPABILITIES,
  SERVER_INFO,
  SUPPORTED_PROTOCOL_VERSIONS,
  isNotification,
  isRequest,
  jsonText,
  rpcError,
  rpcResult,
} from "@/lib/mcp/protocol";
import type {
  JsonRpcMessage,
  JsonRpcResponse,
  McpContent,
  McpPromptResult,
  McpResource,
  McpResourceReadResult,
  McpTool,
  RpcId,
} from "@/lib/mcp/protocol";
import { formatIssues, validateArgs } from "@/lib/mcp/schema";
import { IMAGE_TOOLS } from "@/lib/mcp/imageTools";
import { CONTROL_TOOLS, IMPORT_TOOLS, OBSERVE_TOOLS, TOOLS } from "@/lib/mcp/tools";
import type { ToolDefinition } from "@/lib/mcp/kit";
import { round } from "@/lib/time";
import { editor } from "@/store/editorStore";

/* ------------------------------------------------------------------ *
 * Events — what the panel shows and a host can follow
 * ------------------------------------------------------------------ */

export type ServerEventKind = "request" | "call" | "read" | "prompt" | "subscribe" | "error" | "log";

export interface ServerEvent {
  at: number;
  kind: ServerEventKind;
  /** One line, already phrased for a human watching the panel. */
  text: string;
  /** Machine-readable detail: the tool name, the arguments, whether it worked. */
  detail?: Record<string, unknown>;
}

export interface McpServerOptions {
  onEvent?: (event: ServerEvent) => void;
}

export interface McpServerState {
  initialized: boolean;
  protocolVersion: string;
  clientName: string | null;
  clientVersion: string | null;
  logLevel: string;
  /** Resource uris this client asked to be told about. */
  subscriptions: string[];
  calls: number;
  errors: number;
  /** Rough output volume, so an agent (or a person) can see what its session cost. */
  bytesOut: number;
  tokensOut: number;
}

export interface McpServer {
  /** Route one already-parsed message. `null` means "notification: do not reply". */
  handle: (message: unknown) => Promise<JsonRpcResponse | null>;
  /** The same things `tools/list`, `resources/list` and `prompts/list` return. */
  tools: McpTool[];
  resources: McpResource[];
  prompts: { name: string; title: string; description: string; arguments: unknown[] }[];
  state: () => McpServerState;
}

/* ------------------------------------------------------------------ *
 * The catalogue, in wire form
 * ------------------------------------------------------------------ */

/**
 * Image mode exposes its own catalogue: the shared observe / import / selection /
 * history tools from the video editor, plus the image-specific composition and
 * export tools. `tools/list` and `tools/call` resolve against whichever one the
 * active editor mode names.
 */
const SHARED_IMAGE_NAMES = new Set([
  "import_media",
  "list_assets",
  "list_library",
  "get_editor_state",
  "get_selection",
  "select_clips",
  "edit_history",
]);

const IMAGE_CATALOGUE: ToolDefinition[] = [
  ...[...OBSERVE_TOOLS, ...CONTROL_TOOLS, ...IMPORT_TOOLS].filter((tool) => SHARED_IMAGE_NAMES.has(tool.name)),
  ...IMAGE_TOOLS,
];

/** The catalogue the active editor mode exposes. */
const activeCatalogue = (): ToolDefinition[] => (editor().ui.mode === "image" ? IMAGE_CATALOGUE : TOOLS);

/** `run` is ours, not the client's — the wire only ever sees the declaration. */
const toWireTool = (tool: ToolDefinition): McpTool => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: tool.annotations,
});

const activeToolList = (): McpTool[] => activeCatalogue().map(toWireTool);
const activeToolByName = (): Map<string, ToolDefinition> => new Map(activeCatalogue().map((tool) => [tool.name, tool]));

/**
 * Every uri this server can be read at, with the reader that answers it.
 *
 * A reader may return a promise: most resources are a pure function of live
 * store state and answer instantly, but the library lives in IndexedDB, so
 * `octo-cut://projects` cannot. The read path awaits either shape.
 */
const RESOURCE_DEFS: (McpResource & { read: () => unknown | Promise<unknown> })[] = [
  {
    uri: "octo-cut://playbook",
    name: "playbook",
    title: "How to edit",
    description:
      "The craft: the stages of an edit, what makes a cut work, when a transition earns its place, and what picture lock gates. Read this before a first pass.",
    mimeType: "text/markdown",
    read: () => EDITING_PLAYBOOK,
  },
  {
    uri: "octo-cut://project",
    name: "project",
    title: "The project document",
    description:
      "The saved document itself: settings, tracks, and every layer with its raw properties and source in-point. Read this to see what a save would contain; read octo-cut://timeline to see how it plays.",
    mimeType: "application/json",
    read: () => {
      const { project } = editor();
      return {
        settings: project.settings,
        trackIds: project.trackIds,
        tracks: project.trackIds.map((id) => project.tracks[id]),
        layerIds: project.layerIds,
        layers: project.layerIds.map((id) => project.layers[id]),
        assetIds: editor().assetIds,
      };
    },
  },
  {
    uri: "octo-cut://projects",
    name: "projects",
    title: "The saved library",
    description:
      "Every saved project: its id, name, status, clip count, duration, canvas, when it was last edited and which one is open now. This is what open_project, save_project and delete_project act on. For the starting points a project can be built from, use the list_templates tool — templates are not saved work.",
    mimeType: "application/json",
    read: () => buildProjects(editor()),
  },
  {
    uri: "octo-cut://timeline",
    name: "timeline",
    title: "The timeline",
    description:
      "Every row top to bottom with its clips — start, end, source in-point, transitions, keyframes — and every junction between touching clips. Junctions are derived from geometry, so this is the only place to read them as facts.",
    mimeType: "application/json",
    read: () => buildTimeline(editor()),
  },
  {
    uri: "octo-cut://editor",
    name: "editor",
    title: "The live session",
    description:
      "Everything that is not the document: the playhead, what is selected, playback and loop state, undo depth and the last action, the export queue and what panels the user has open.",
    mimeType: "application/json",
    read: () => buildEditorState(editor()),
  },
  {
    uri: "octo-cut://selection",
    name: "selection",
    title: "The current selection",
    description:
      "What the human is pointing at. Writes that name no clips act on this selection, so read it before an unscoped edit rather than assuming.",
    mimeType: "application/json",
    read: () => buildSelection(editor()),
  },
  {
    uri: "octo-cut://assets",
    name: "assets",
    title: "The media bin",
    description:
      "Every asset with its kind, duration, natural size and provenance, whether its waveform is decoded, and how many clips already use it. These are the asset ids the placing tools accept.",
    mimeType: "application/json",
    read: () => buildAssets(editor()),
  },
  {
    uri: "octo-cut://library",
    name: "library",
    title: "Every preset id",
    description:
      "Transitions (with their category and whether they run a real shader pass), looks, effects, backgrounds, shapes, text presets, sticker glyphs, fonts and blend modes. An id that is not here does not exist.",
    mimeType: "application/json",
    read: () => buildLibrary(),
  },
  {
    uri: "octo-cut://activity",
    name: "activity",
    title: "Activity and exports",
    description:
      "Where the undo stack stands, what the last change was called, and the state of every render job. Use the get_activity TOOL instead when you want the diff since your last look — a resource read is always current, so it cannot tell you what moved.",
    mimeType: "application/json",
    read: () => {
      const state = editor();
      const exports = buildExportStatus(state);
      return {
        history: {
          canUndo: state.history.past.length > 0,
          canRedo: state.history.future.length > 0,
          undoDepth: state.history.past.length,
          redoDepth: state.history.future.length,
          lastAction: state.lastAction,
        },
        playhead: { time: round(state.currentTime, 3), playing: state.isPlaying, looping: state.loop },
        exporting: state.ui.exporting,
        jobs: exports.jobs,
        usage: serverUsage(),
        note: "Read the get_activity tool for a diff against your previous call; this resource is always the present moment. `usage` is this session's output volume — tokensOut is a rough ~4 chars/token estimate.",
      };
    },
  },
];

const RESOURCE_LIST: McpResource[] = RESOURCE_DEFS.map(({ uri, name, title, description, mimeType }) => ({
  uri,
  name,
  title,
  description,
  mimeType,
}));

const RESOURCE_BY_URI = new Map(RESOURCE_DEFS.map((resource) => [resource.uri, resource]));

const PROMPT_LIST = PROMPT_TEMPLATES.map((prompt) => ({
  name: prompt.name,
  title: prompt.title,
  description: prompt.description,
  arguments: prompt.arguments,
}));

const PROMPT_BY_NAME = new Map(PROMPT_TEMPLATES.map((prompt) => [prompt.name, prompt]));

const METHODS = [
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  "logging/setLevel",
] as const;

/* ------------------------------------------------------------------ *
 * The server
 * ------------------------------------------------------------------ */

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** The first line of a tool result — the one-line report, for a log. */
const firstLine = (content: McpContent[] | undefined): string => {
  const text = content?.[0]?.type === "text" ? content[0].text : "";
  return text.split("\n")[0] ?? "";
};

/** Approximate JSON size of a payload, for the session's output-volume meter. */
const measureBytes = (value: unknown): number => {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
};

/** The live server's counters, readable without a cycle (see the activity resource). */
let liveState: McpServerState | null = null;

export function serverUsage(): { calls: number; errors: number; bytesOut: number; tokensOut: number } | null {
  const s = liveState;
  return s ? { calls: s.calls, errors: s.errors, bytesOut: s.bytesOut, tokensOut: s.tokensOut } : null;
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const state: McpServerState = {
    initialized: false,
    protocolVersion: MCP_PROTOCOL_VERSION,
    clientName: null,
    clientVersion: null,
    logLevel: "info",
    subscriptions: [],
    calls: 0,
    errors: 0,
    bytesOut: 0,
    tokensOut: 0,
  };
  liveState = state;

  const emit = (kind: ServerEventKind, text: string, detail?: Record<string, unknown>) =>
    options.onEvent?.({ at: Date.now(), kind, text, detail });

  /** Tool execution: a throw is the agent asking for something impossible. */
  const callTool = async (id: RpcId, params: Record<string, unknown>): Promise<JsonRpcResponse> => {
    const name = typeof params.name === "string" ? params.name : "";
    const tool = activeToolByName().get(name);
    if (!tool) {
      return rpcError(id, RPC_ERRORS.invalidParams, `There is no tool called "${name}".`, {
        availableTools: activeCatalogue().map((entry) => entry.name),
      });
    }

    const args = asRecord(params.arguments);
    const issues = validateArgs(args, tool.inputSchema);
    if (issues.length) {
      emit("error", `${name} — rejected: invalid arguments`, { name, issues });
      return rpcError(id, RPC_ERRORS.invalidParams, formatIssues(issues), { tool: name, issues });
    }

    const started = Date.now();
    state.calls += 1;
    try {
      const result = await tool.run(args);
      state.bytesOut += measureBytes(result);
      state.tokensOut = Math.ceil(state.bytesOut / 4);
      const line = firstLine(result.content);
      const failed = result.isError === true;
      if (failed) state.errors += 1;
      emit(failed ? "error" : "call", `${name} — ${line}`, {
        name,
        title: tool.title,
        ok: !failed,
        ms: Date.now() - started,
        args,
        text: line,
      });
      return rpcResult(id, result);
    } catch (error) {
      state.errors += 1;
      const message = error instanceof Error ? error.message : String(error);
      emit("error", `${name} — ${message}`, { name, ok: false, ms: Date.now() - started, args });
      // In-band: the tool understood the request and refused it. That is a
      // conversation, not a transport failure.
      return rpcResult(id, { content: [{ type: "text", text: message }], isError: true });
    }
  };

  const readResource = async (id: RpcId, params: Record<string, unknown>): Promise<JsonRpcResponse> => {
    const uri = typeof params.uri === "string" ? params.uri : "";
    const resource = RESOURCE_BY_URI.get(uri);
    if (!resource) {
      return rpcError(id, RPC_ERRORS.invalidParams, `There is no resource at "${uri}".`, {
        availableResources: RESOURCE_LIST.map((entry) => entry.uri),
      });
    }
    try {
      const payload = await resource.read();
      const text = typeof payload === "string" ? payload : jsonText(payload);
      emit("read", `read ${uri} — ${text.length} characters`, { uri, bytes: text.length });
      const result: McpResourceReadResult = {
        contents: [{ uri, mimeType: resource.mimeType ?? "application/json", text }],
      };
      state.bytesOut += measureBytes(result);
      state.tokensOut = Math.ceil(state.bytesOut / 4);
      return rpcResult(id, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit("error", `read ${uri} failed — ${message}`, { uri });
      return rpcError(id, RPC_ERRORS.internal, `Could not read ${uri}: ${message}`);
    }
  };

  const getPrompt = (id: RpcId, params: Record<string, unknown>): JsonRpcResponse => {
    const name = typeof params.name === "string" ? params.name : "";
    const prompt = PROMPT_BY_NAME.get(name);
    if (!prompt) {
      return rpcError(id, RPC_ERRORS.invalidParams, `There is no prompt called "${name}".`, {
        availablePrompts: PROMPT_TEMPLATES.map((entry) => entry.name),
      });
    }
    const raw = asRecord(params.arguments);
    const args: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) if (value != null) args[key] = String(value);

    const missing = prompt.arguments.filter((arg) => arg.required && !args[arg.name]);
    if (missing.length) {
      return rpcError(
        id,
        RPC_ERRORS.invalidParams,
        `"${name}" needs ${missing.map((arg) => `"${arg.name}"`).join(", ")}.`,
        { prompt: name, missing: missing.map((arg) => arg.name) },
      );
    }

    emit("prompt", `prompt "${name}"`, { name, args });
    const result: McpPromptResult = {
      description: prompt.description,
      messages: [{ role: "user", content: { type: "text", text: prompt.render(args) } }],
    };
    return rpcResult(id, result);
  };

  const handleRequest = async (request: { id: RpcId; method: string; params?: unknown }): Promise<JsonRpcResponse> => {
    const { id, method } = request;
    const params = asRecord(request.params);

    switch (method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        const supported = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked);
        state.protocolVersion = supported ? asked : MCP_PROTOCOL_VERSION;
        const client = asRecord(params.clientInfo);
        state.clientName = typeof client.name === "string" ? client.name : null;
        state.clientVersion = typeof client.version === "string" ? client.version : null;
        emit("request", `initialize — ${state.clientName ?? "anonymous client"} on protocol ${state.protocolVersion}`, {
          client: state.clientName,
          protocolVersion: state.protocolVersion,
        });
        return rpcResult(id, {
          protocolVersion: state.protocolVersion,
          capabilities: SERVER_CAPABILITIES,
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        });
      }

      case "ping":
        return rpcResult(id, {});

      case "tools/list":
        return rpcResult(id, { tools: activeToolList() });

      case "tools/call":
        return await callTool(id, params);

      case "resources/list":
        return rpcResult(id, { resources: RESOURCE_LIST });

      case "resources/templates/list":
        return rpcResult(id, { resourceTemplates: [] });

      case "resources/read":
        return await readResource(id, params);

      case "resources/subscribe": {
        const uri = typeof params.uri === "string" ? params.uri : "";
        if (!RESOURCE_BY_URI.has(uri)) {
          return rpcError(id, RPC_ERRORS.invalidParams, `There is no resource at "${uri}" to subscribe to.`, {
            availableResources: RESOURCE_LIST.map((entry) => entry.uri),
          });
        }
        if (!state.subscriptions.includes(uri)) state.subscriptions.push(uri);
        emit("subscribe", `subscribed to ${uri}`, { uri, subscriptions: state.subscriptions });
        return rpcResult(id, {});
      }

      case "resources/unsubscribe": {
        const uri = typeof params.uri === "string" ? params.uri : "";
        state.subscriptions = state.subscriptions.filter((entry) => entry !== uri);
        emit("subscribe", `unsubscribed from ${uri}`, { uri });
        return rpcResult(id, {});
      }

      case "prompts/list":
        return rpcResult(id, { prompts: PROMPT_LIST });

      case "prompts/get":
        return getPrompt(id, params);

      case "logging/setLevel": {
        const level = typeof params.level === "string" ? params.level : "info";
        state.logLevel = level;
        emit("log", `log level set to ${level}`, { level });
        return rpcResult(id, {});
      }

      default:
        return rpcError(id, RPC_ERRORS.methodNotFound, `This server does not implement "${method}".`, {
          availableMethods: METHODS,
        });
    }
  };

  return {
    handle: async (message: unknown) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return rpcError(0, RPC_ERRORS.invalidRequest, "Expected a single JSON-RPC message object.");
      }
      const incoming = message as JsonRpcMessage;
      const id = (incoming as { id?: RpcId }).id ?? 0;

      // Notifications carry no id and must never be answered.
      if (isNotification(incoming)) {
        if (incoming.method === "notifications/initialized") {
          state.initialized = true;
          emit("request", "client confirmed initialization", { protocolVersion: state.protocolVersion });
        } else if (incoming.method === "notifications/cancelled") {
          emit("log", "client cancelled a request", asRecord(incoming.params));
        }
        return null;
      }

      if (!isRequest(incoming)) {
        return rpcError(id, RPC_ERRORS.invalidRequest, "A request needs both an id and a method.");
      }

      try {
        return await handleRequest({ id: incoming.id, method: incoming.method, params: incoming.params });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emit("error", `${incoming.method} failed — ${message}`, { method: incoming.method });
        return rpcError(incoming.id, RPC_ERRORS.internal, message);
      }
    },
    get tools() {
      return activeToolList();
    },
    resources: RESOURCE_LIST,
    prompts: PROMPT_LIST,
    state: () => ({ ...state, subscriptions: [...state.subscriptions] }),
  };
}

/** The uris this server publishes, for a host or a panel to show. */
export const RESOURCE_URIS = RESOURCE_LIST.map((resource) => resource.uri);
