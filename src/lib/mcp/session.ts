/**
 * THE LIVE AGENT SESSION.
 *
 * One editor, one MCP server, one bridge — this module is where those become
 * singletons, because "the live editing session" only means anything if there is
 * exactly one of it per page.
 *
 * It also owns the part a host cannot see: the recent event log. The panel reads
 * it, and a message that arrived while nobody was watching is still there when
 * the panel opens.
 */
import { createMcpServer } from "@/lib/mcp/server";
import type { McpServer, ServerEvent } from "@/lib/mcp/server";
import { BRIDGE_CHANNEL, attachWindowBridge, createLoopbackClient } from "@/lib/mcp/transport";
import type { AgentDescriptor, BridgeStatus, McpClient, WindowBridge } from "@/lib/mcp/transport";

/** How much history to keep. Enough to survive a panel being opened late. */
const LOG_LIMIT = 250;

const listeners = new Set<(events: ServerEvent[]) => void>();
const log: ServerEvent[] = [];

function push(event: ServerEvent): void {
  log.unshift(event);
  if (log.length > LOG_LIMIT) log.length = LOG_LIMIT;
  for (const listener of listeners) listener(events());
}

export const agentServer: McpServer = createMcpServer({ onEvent: push });

/** An in-process client — the same wire protocol, no network hop. */
export const agentClient: McpClient = createLoopbackClient(agentServer);

/** The events so far, newest first. */
export const events = (): ServerEvent[] => [...log];

export function subscribeAgentEvents(listener: (events: ServerEvent[]) => void): () => void {
  listeners.add(listener);
  listener(events());
  return () => listeners.delete(listener);
}

/* ------------------------------------------------------------------ *
 * The window bridge
 * ------------------------------------------------------------------ */

let bridge: WindowBridge | null = null;

/**
 * Start listening for a host on the message channel. Idempotent, and called as
 * the editor boots rather than when the panel opens: an agent that has to wait
 * for a human to click a button is not connected to anything.
 */
export function ensureAgentBridge(): WindowBridge {
  if (bridge) return bridge;
  bridge = attachWindowBridge(agentServer, { onEvent: push, onStatus: () => pushStatus() });
  // The panel subscribes from an effect that runs before the editor's, so it
  // reads `listening: false` from a bridge that did not exist yet. Announcing
  // the attach is what makes that first read true.
  pushStatus();
  return bridge;
}

const statusListeners = new Set<(status: BridgeStatus) => void>();

function pushStatus(): void {
  const status = agentBridgeStatus();
  for (const listener of statusListeners) listener(status);
}

export const agentBridgeStatus = (): BridgeStatus =>
  bridge?.status() ?? {
    listening: false,
    channel: BRIDGE_CHANNEL,
    allow: [],
    handled: 0,
    lastOrigin: null,
    lastAt: null,
  };

export function subscribeBridgeStatus(listener: (status: BridgeStatus) => void): () => void {
  statusListeners.add(listener);
  listener(agentBridgeStatus());
  return () => statusListeners.delete(listener);
}

/** What a host is told when it says "hello" on the channel. */
export const agentDescriptor = (): AgentDescriptor => ({
  server: "octo-cut",
  protocolVersion: agentServer.state().protocolVersion,
  channel: BRIDGE_CHANNEL,
  tools: agentServer.tools.length,
  resources: agentServer.resources.map((resource) => resource.uri),
  prompts: agentServer.prompts.map((prompt) => prompt.name),
});

/* ------------------------------------------------------------------ *
 * Console access
 * ------------------------------------------------------------------ */

declare global {
  interface Window {
    /** The session, reachable from the devtools console (see the panel's Copy snippet). */
    octoCutMcp?: {
      server: McpServer;
      client: McpClient;
      descriptor: () => AgentDescriptor;
      status: () => BridgeStatus;
    };
  }
}

/**
 * Publish the session on `window` so a host script — or a person with the
 * console open — can drive the editor without any other wiring. The bridge is
 * started at the same time, since the two are the same offer.
 */
export function installAgentAccess(): WindowBridge {
  const started = ensureAgentBridge();
  if (typeof window !== "undefined") {
    window.octoCutMcp = {
      server: agentServer,
      client: agentClient,
      descriptor: agentDescriptor,
      status: agentBridgeStatus,
    };
  }
  return started;
}
