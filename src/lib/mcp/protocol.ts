/**
 * THE MCP WIRE PROTOCOL (spec revision 2025-06-18).
 *
 * Only the wire format lives here: JSON-RPC envelopes, the message shapes MCP
 * defines, and the result builders. Nothing in this file knows about the video
 * editor, so the same module describes the contract to an agent, to the server
 * core and to the transports.
 *
 * Scope: the server features an editing agent actually needs — tools,
 * resources (with subscriptions) and prompts — plus `ping` and
 * `logging/setLevel`. Sampling/roots/elicitation are client features and are
 * not requested, so a client never has to implement them.
 */

/** The revision this server implements, newest first. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Versions we can speak. A client asking for one of these is answered in kind. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const SERVER_INFO = { name: "octo-cut", version: "1.0.0", title: "Octo Cut editor" } as const;

/* ------------------------------------------------------------------ *
 * JSON-RPC 2.0
 * ------------------------------------------------------------------ */

export type RpcId = string | number;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: RpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/** The subset of JSON-RPC error codes MCP assigns meanings to. */
export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export const rpcResult = (id: RpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

export const rpcError = (id: RpcId, code: number, message: string, data?: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

export const rpcNotification = (method: string, params?: Record<string, unknown>): JsonRpcNotification =>
  params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };

/** Is this an incoming request (has an id and a method), as opposed to a response? */
export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return typeof (message as JsonRpcRequest).method === "string" && (message as JsonRpcRequest).id !== undefined;
}

/** Is this a notification — a method with no id, which must never be answered? */
export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  const incoming = message as { method?: unknown; id?: unknown };
  return typeof incoming.method === "string" && incoming.id === undefined;
}

/* ------------------------------------------------------------------ *
 * JSON Schema (the subset the tool catalogue uses)
 * ------------------------------------------------------------------ */

/**
 * Deliberately small: enough to describe and *validate* tool arguments without
 * shipping a schema library. `validate` in `schema.ts` is the only consumer, so
 * the two must stay in step — every keyword declared here is enforced there.
 */
export interface JsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  description?: string;
  /** object */
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  /** array */
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  /** string */
  enum?: unknown[];
  minLength?: number;
  /** number */
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

/**
 * Behavioural hints for a client's UI. Advisory only — the spec tells clients to
 * treat these as untrusted unless they come from a trusted server — but they are
 * what lets a host auto-approve `get_timeline` while still confirming a delete.
 */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
}

/** `content` is the human/LLM-readable channel; `structuredContent` the typed one. */
export interface McpToolResult {
  content: McpTextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpTextContent {
  type: "text";
  text: string;
}

export interface McpResourceLink {
  type: "resource_link";
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export type McpContent = McpTextContent | McpResourceLink;

/** Every tool result carries a text mirror of its structured payload. */
export function textResult(text: string, structured?: Record<string, unknown>): McpToolResult {
  return structured === undefined ? { content: [{ type: "text", text }] } : { content: [{ type: "text", text }], structuredContent: structured };
}

/** A tool that ran but could not do its job. Reported in-band, not as a protocol error. */
export function toolError(message: string, data?: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: "text", text: message }],
    ...(data ? { structuredContent: data } : {}),
    isError: true,
  };
}

export const jsonText = (value: unknown): string => JSON.stringify(value, null, 2);

/** A readable text block plus its structured twin, from one payload. */
export const payloadResult = (payload: Record<string, unknown> | unknown[]): McpToolResult =>
  textResult(jsonText(payload), Array.isArray(payload) ? { items: payload } : payload);

/* ------------------------------------------------------------------ *
 * Resources
 * ------------------------------------------------------------------ */

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
}

export interface McpResourceReadResult {
  contents: McpResourceContents[];
}

/* ------------------------------------------------------------------ *
 * Prompts
 * ------------------------------------------------------------------ */

export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: McpPromptArgument[];
}

export interface McpPromptMessage {
  role: "user" | "assistant";
  content: McpTextContent;
}

export interface McpPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

/** Shorthand for the single-message prompts this server exposes. */
export const promptResult = (description: string, text: string): McpPromptResult => ({
  description,
  messages: [{ role: "user", content: { type: "text", text } }],
});

/* ------------------------------------------------------------------ *
 * Capabilities
 * ------------------------------------------------------------------ */

/**
 * What we advertise at initialize. `subscribe` is the important one: it lets an
 * agent watch the project and be *pushed* the edit the moment a human makes it,
 * rather than polling and guessing what changed.
 */
export const SERVER_CAPABILITIES = {
  tools: { listChanged: false },
  resources: { subscribe: true, listChanged: false },
  prompts: { listChanged: false },
  logging: {},
} as const;
