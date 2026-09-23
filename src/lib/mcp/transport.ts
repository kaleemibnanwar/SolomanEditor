/**
 * THE TRANSPORTS.
 *
 * The server is transport-agnostic by design, so this file holds the two ways
 * anything actually reaches it from a browser:
 *
 *   · LOOPBACK — an in-process client. It is how the panel drives the server
 *     (listing tools, reading a resource, running a call on demand) and how the
 *     surface is exercised without a network. Same code path the wire uses:
 *     a real JSON-RPC envelope in, a real envelope out.
 *   · WINDOW BRIDGE — `window.postMessage`. This is the honest form of "an
 *     agent connects to the editor" when the editor IS a page: a browser
 *     extension, an embedding harness, or a local agent driving a headless tab
 *     posts a JSON-RPC message on a known channel and gets the reply back. The
 *     bridge is origin-checked and echoes nothing it was not asked for.
 *
 * Both are thin. If a transport needs logic, the logic is wrong — it belongs in
 * `server.ts`.
 */
import type { JsonRpcMessage, JsonRpcResponse, McpPromptResult, McpResource, McpTool, McpToolResult } from "@/lib/mcp/protocol";
import type { McpServer, ServerEvent } from "@/lib/mcp/server";

/* ------------------------------------------------------------------ *
 * The client contract
 * ------------------------------------------------------------------ */

/** A protocol error returned by the server, as opposed to a tool that refused. */
export class McpClientError extends Error {
  code: number;
  data?: unknown;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "McpClientError";
    this.code = code;
    this.data = data;
  }
}

export interface McpClient {
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  /** The handshake response: protocol version, capabilities, instructions. */
  initialize: (clientName?: string) => Promise<{ protocolVersion: string; instructions?: string }>;
  listTools: () => Promise<McpTool[]>;
  callTool: (name: string, args?: Record<string, unknown>) => Promise<McpToolResult>;
  listResources: () => Promise<McpResource[]>;
  readResource: (uri: string) => Promise<{ uri: string; mimeType?: string; text?: string }>;
  getPrompt: (name: string, args?: Record<string, string>) => Promise<McpPromptResult>;
}

/* ------------------------------------------------------------------ *
 * Loopback — the server, driven from inside the page
 * ------------------------------------------------------------------ */

export function createLoopbackClient(server: McpServer): McpClient {
  let nextId = 1;

  const request = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    const id = nextId++;
    const response = await server.handle({ jsonrpc: "2.0", id, method, params } as JsonRpcMessage);
    if (!response) throw new McpClientError(`${method} is a notification, not a request`, -32600);
    if (response.error) throw new McpClientError(response.error.message, response.error.code, response.error.data);
    return response.result;
  };

  const readResource = async (uri: string) => {
    const result = (await request("resources/read", { uri })) as { contents: { uri: string; mimeType?: string; text?: string }[] };
    const first = result.contents[0];
    if (!first) throw new McpClientError(`No contents returned for ${uri}`, -32603);
    return first;
  };

  return {
    request,
    initialize: async (clientName = "octo-cut panel") => {
      const result = (await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: clientName, version: "1.0.0" },
      })) as { protocolVersion: string; instructions?: string };
      // The spec wants the initialized notification to follow the handshake.
      void server.handle({ jsonrpc: "2.0", method: "notifications/initialized" } as JsonRpcMessage);
      return result;
    },
    listTools: async () => ((await request("tools/list")) as { tools: McpTool[] }).tools,
    callTool: async (name, args = {}) => (await request("tools/call", { name, arguments: args })) as McpToolResult,
    listResources: async () => ((await request("resources/list")) as { resources: McpResource[] }).resources,
    readResource,
    getPrompt: async (name, args = {}) => (await request("prompts/get", { name, arguments: args })) as McpPromptResult,
  };
}

/* ------------------------------------------------------------------ *
 * Window bridge — `window.postMessage`
 * ------------------------------------------------------------------ */

/** The default channel. A host posts `{ type: CHANNEL, payload: <message> }`. */
export const BRIDGE_CHANNEL = "octo-cut:mcp";

/** What a host gets back when it announces itself on the channel. */
export interface AgentDescriptor {
  server: string;
  protocolVersion: string;
  channel: string;
  tools: number;
  resources: string[];
  prompts: string[];
}

export interface BridgeStatus {
  listening: boolean;
  channel: string;
  /** The origin policy, phrased for a human. */
  allow: string[];
  /** How many messages have been routed. */
  handled: number;
  lastOrigin: string | null;
  lastAt: number | null;
}

export interface WindowBridgeOptions {
  /** Defaults to {@link BRIDGE_CHANNEL}. */
  channel?: string;
  /**
   * Origins allowed to talk to the editor. Defaults to this page's own origin
   * only, which is what an iframe host or a same-origin harness needs. Pass
   * `"*"` only when a foreign page genuinely must drive the timeline.
   */
  origins?: string[] | "*";
  onEvent?: (event: ServerEvent) => void;
  onStatus?: (status: BridgeStatus) => void;
}

export interface WindowBridge {
  detach: () => void;
  status: () => BridgeStatus;
}

export function attachWindowBridge(server: McpServer, options: WindowBridgeOptions = {}): WindowBridge {
  const channel = options.channel ?? BRIDGE_CHANNEL;
  const allow = options.origins ?? (typeof window === "undefined" ? [] : [window.location.origin]);

  const status: BridgeStatus = {
    listening: true,
    channel,
    allow: allow === "*" ? ["* (any origin — use with care)"] : allow,
    handled: 0,
    lastOrigin: null,
    lastAt: null,
  };

  const emit = (kind: ServerEvent["kind"], text: string, detail?: Record<string, unknown>) =>
    options.onEvent?.({ at: Date.now(), kind, text, detail });

  const descriptor = (): AgentDescriptor => ({
    server: "octo-cut",
    protocolVersion: server.state().protocolVersion,
    channel,
    tools: server.tools.length,
    resources: server.resources.map((resource) => resource.uri),
    prompts: server.prompts.map((prompt) => prompt.name),
  });

  /** Is this origin permitted? Opaque ("null") origins only pass when wildcarded. */
  const permitted = (origin: string): boolean => {
    if (allow === "*") return true;
    if (!origin || origin === "null") return false;
    return allow.includes(origin);
  };

  const onMessage = async (event: MessageEvent) => {
    const data = event.data as { type?: unknown; payload?: unknown } | null;
    if (!data || typeof data !== "object" || data.type !== channel) return;
    if (!permitted(event.origin)) {
      emit("error", `refused a message from ${event.origin || "an opaque origin"} — not in the allow list`, {
        origin: event.origin,
      });
      return;
    }

    const reply = (payload: unknown) => {
      // `event.source` is the window that spoke — reply only to it.
      try {
        (event.source as Window | null)?.postMessage({ type: `${channel}:reply`, payload }, { targetOrigin: event.origin || "*" });
      } catch {
        // A source that has gone away is not our problem.
      }
    };

    // A host introducing itself gets the descriptor and can then call anything.
    if (data.payload === "hello" || (data.payload as { method?: string } | undefined)?.method === "hello") {
      status.handled += 1;
      status.lastOrigin = event.origin;
      status.lastAt = Date.now();
      emit("request", `host on ${event.origin || "an opaque origin"} asked for the descriptor`, { origin: event.origin });
      reply(descriptor());
      options.onStatus?.({ ...status });
      return;
    }

    const response = await server.handle(data.payload);
    status.handled += 1;
    status.lastOrigin = event.origin;
    status.lastAt = Date.now();
    options.onStatus?.({ ...status });

    // A notification legitimately has no reply; answering one would be a bug.
    if (!response) return;

    const method = (data.payload as { method?: string }).method ?? "unknown";
    const failed = "error" in response;
    emit(failed ? "error" : "request", `${method} over the window bridge — ${failed ? "error" : "ok"}`, {
      method,
      origin: event.origin,
      ok: !failed,
    });
    reply(response as JsonRpcResponse);
  };

  window.addEventListener("message", onMessage);

  return {
    detach: () => {
      window.removeEventListener("message", onMessage);
      status.listening = false;
      options.onStatus?.({ ...status });
    },
    status: () => ({ ...status, allow: [...status.allow] }),
  };
}
