/**
 * THE AGENT PANEL.
 *
 * The editor is one half of an MCP session and this panel is the other half's
 * window into it: what the server publishes, what a host has been doing, and a
 * way to call anything by hand.
 *
 * It is a real client. Every button here goes through the same JSON-RPC path a
 * foreign host uses — `agentClient` in, envelopes out — so if the panel can read
 * a resource, an agent can, and if a call fails here it will fail the same way
 * there. That is the point: the panel is not a simulation of the integration,
 * it is the integration, made visible.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, Copy, Globe, Play, Plug, Radio, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FLOWS } from "@/lib/mcp/flows";
import {
  PREFERRED_MCP_PORT,
  httpHostAvailable,
  httpHostStatus,
  startHttpServer,
  stopHttpServer,
  subscribeHttpHostStatus,
} from "@/lib/mcp/host";
import type { HttpHostStatus } from "@/lib/mcp/host";
import { PROMPT_TEMPLATES } from "@/lib/mcp/playbook";
import type { McpTool } from "@/lib/mcp/protocol";
import type { ServerEvent } from "@/lib/mcp/server";
import {
  agentBridgeStatus,
  agentClient,
  agentDescriptor,
  agentServer,
  events,
  subscribeAgentEvents,
  subscribeBridgeStatus,
} from "@/lib/mcp/session";
import { BROADCAST_TOOLS, CONTROL_TOOLS, CONTENT_TOOLS, IMPORT_TOOLS, MACRO_TOOLS, MANIFEST_TOOLS, OBSERVE_TOOLS, PROJECT_TOOLS } from "@/lib/mcp/tools";
import { cn } from "@/lib/utils";

const GROUPS = [
  { id: "observe", label: "Observe", hint: "Read the session — nothing changes", tools: OBSERVE_TOOLS },
  { id: "control", label: "Control", hint: "One operation per call, one undo step", tools: CONTROL_TOOLS },
  { id: "import", label: "Import", hint: "Load media the agent already has", tools: IMPORT_TOOLS },
  { id: "projects", label: "Projects", hint: "Whole documents — start, open, save, delete", tools: PROJECT_TOOLS },
  { id: "content", label: "Content", hint: "Brand templates, rules and export", tools: CONTENT_TOOLS },
  { id: "flows", label: "Flows", hint: "A whole editorial pass in a single call", tools: FLOWS },
  { id: "macros", label: "Macros", hint: "Save and replay a reusable recipe", tools: MACRO_TOOLS },
  { id: "manifest", label: "Manifest", hint: "Compose a whole piece from JSON", tools: MANIFEST_TOOLS },
  { id: "broadcast", label: "Broadcast", hint: "Stream configs + live push to RTMP/SRT", tools: BROADCAST_TOOLS },
];

type Tab = "surface" | "log" | "prompts" | "call";

const KINDS: Record<ServerEvent["kind"], string> = {
  request: "text-km-dim",
  call: "text-emerald-400",
  read: "text-sky-400",
  prompt: "text-violet-400",
  subscribe: "text-amber-400",
  log: "text-km-faint",
  error: "text-red-400",
};

const clock = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });

export default function AgentPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [tab, setTab] = useState<Tab>("surface");
  const [status, setStatus] = useState(agentBridgeStatus);
  const [log, setLog] = useState<ServerEvent[]>(events);
  const [handshake, setHandshake] = useState<{ protocolVersion: string; instructions?: string } | null>(null);
  const [toolName, setToolName] = useState("get_editor_state");
  const [argsText, setArgsText] = useState("{}");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [promptName, setPromptName] = useState(PROMPT_TEMPLATES[0]?.name ?? "");
  const [promptArgs, setPromptArgs] = useState<Record<string, string>>({});
  const [promptText, setPromptText] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [remote, setRemote] = useState<HttpHostStatus>(httpHostStatus);
  const [remoteBusy, setRemoteBusy] = useState(false);

  useEffect(() => subscribeBridgeStatus(setStatus), []);
  useEffect(() => subscribeAgentEvents(setLog), []);
  useEffect(() => subscribeHttpHostStatus(setRemote), []);

  /** Introduce ourselves once, so the panel sees what a host is actually told. */
  useEffect(() => {
    void agentClient.initialize("octo-cut panel").then(setHandshake).catch(() => setHandshake(null));
  }, []);

  const tool = useMemo(() => agentServer.tools.find((entry) => entry.name === toolName), [toolName]);
  const prompt = useMemo(() => PROMPT_TEMPLATES.find((entry) => entry.name === promptName), [promptName]);
  const descriptor = useMemo(() => agentDescriptor(), []);

  /**
   * The drawer stays mounted when closed so its state survives, which would
   * otherwise leave every control in it reachable by Tab while off-screen.
   */
  const asideRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = asideRef.current;
    if (node) node.inert = !open;
  }, [open]);

  const copy = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied((current) => (current === tag ? null : current)), 1400);
    } catch {
      setCopied(null);
    }
  };

  /* ------------------------------ actions ------------------------------ */

  const runTool = async () => {
    let args: Record<string, unknown> = {};
    if (argsText.trim()) {
      try {
        const parsed: unknown = JSON.parse(argsText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          setResult({ ok: false, text: "Arguments must be a JSON object, e.g. { \"clipId\": \"layer_3\" }" });
          return;
        }
        args = parsed as Record<string, unknown>;
      } catch (error) {
        setResult({ ok: false, text: `Arguments are not valid JSON: ${error instanceof Error ? error.message : "parse failed"}` });
        return;
      }
    }

    setBusy(true);
    try {
      const response = await agentClient.callTool(toolName, args);
      setResult({
        ok: !response.isError,
        text: response.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n"),
      });
    } catch (error) {
      setResult({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const readResource = async (uri: string) => {
    setBusy(true);
    try {
      const contents = await agentClient.readResource(uri);
      setResult({ ok: true, text: contents.text ?? "(empty)" });
    } catch (error) {
      setResult({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const renderPrompt = async () => {
    try {
      const rendered = await agentClient.getPrompt(promptName, promptArgs);
      setPromptText(rendered.messages.map((message) => message.content.text).join("\n\n"));
    } catch (error) {
      setPromptText(error instanceof Error ? error.message : String(error));
    }
  };

  useEffect(() => {
    if (tab === "prompts") void renderPrompt();
    // Re-render whenever the chosen prompt or its arguments change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, promptName, promptArgs]);

  const pickTool = (name: string) => {
    setToolName(name);
    setArgsText("{}");
    setResult(null);
    setTab("call");
  };

  /** Start or stop the HTTP listener. The state comes back over IPC, not locally. */
  const toggleRemote = async () => {
    setRemoteBusy(true);
    try {
      if (remote.running) await stopHttpServer();
      else await startHttpServer();
    } finally {
      setRemoteBusy(false);
    }
  };

  const snippet = `// The editor is an MCP server. Reach it from a console:
await window.octoCutMcp.client.callTool("get_timeline")

${
  remote.url
    ? `// Or point any MCP client at the URL below — streamable HTTP, no auth on loopback:
//   ${remote.url}`
    : `// Start the HTTP listener above to get a URL an AI tool can connect to.`
}

// Or from another window (extension, iframe host, agent harness):
target.postMessage({ type: "${descriptor.channel}", payload: {
  jsonrpc: "2.0", id: 1, method: "tools/call",
  params: { name: "flow_assembly_cut", arguments: { clips: [...] } }
} }, origin)`;

  /* ------------------------------ view ------------------------------ */

  return (
    <aside
      ref={asideRef}
      aria-hidden={!open}
      className={cn(
        "fixed right-0 top-0 z-40 flex h-full w-[404px] flex-col border-l border-km-border bg-km-panel transition-transform duration-200",
        open ? "translate-x-0" : "translate-x-full",
      )}
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-km-border px-3">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-km-raised text-km-accent">
          <Bot className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold tracking-tight text-km-text">Agent access</p>
          <p className="truncate font-mono text-[10.5px] text-km-faint">
            {remote.running && remote.url
              ? remote.url
              : status.listening
                ? "Serving MCP from this page"
                : "Bridge stopped"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="grid h-7 w-7 place-items-center rounded-md text-km-dim transition hover:bg-km-raised hover:text-km-text"
          aria-label="Close the agent panel"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <RemoteBar
        available={httpHostAvailable()}
        status={remote}
        busy={remoteBusy}
        copied={copied === "url"}
        onCopy={() => void copy(remote.url ?? "", "url")}
        onToggle={() => void toggleRemote()}
      />

      <nav className="flex shrink-0 gap-1 border-b border-km-border px-2 py-1.5">
        {(["surface", "log", "prompts", "call"] as Tab[]).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "rounded px-2.5 py-1 text-[11.5px] capitalize transition",
              tab === id ? "bg-km-raised text-km-text" : "text-km-dim hover:text-km-text",
            )}
          >
            {id}
            {id === "log" && log.length ? <span className="ml-1 text-[10px] text-km-faint">{log.length}</span> : null}
          </button>
        ))}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:thin]">
        {tab === "surface" && (
          <SurfaceTab
            descriptor={descriptor}
            status={status}
            handshake={handshake}
            snippet={snippet}
            copied={copied}
            onCopy={copy}
            onPickTool={pickTool}
            onReadResource={readResource}
          />
        )}

        {tab === "log" && (
          <div className="flex flex-col">
            <div className="flex items-center justify-between px-3 py-2">
              <p className="text-[10.5px] text-km-faint">Newest first. Every routed message lands here.</p>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setLog([])}
                className="h-6 gap-1 px-1.5 text-[10.5px] text-km-dim hover:bg-km-raised hover:text-km-text"
              >
                <Trash2 className="h-3 w-3" />
                Clear view
              </Button>
            </div>
            {log.length === 0 ? (
              <p className="px-3 pb-4 text-[11px] text-km-faint">
                Nothing yet. Call a tool from the Call tab, or let a host connect.
              </p>
            ) : (
              <ul className="pb-3">
                {log.map((event, index) => (
                  <li key={`${event.at}-${index}`} className="border-b border-km-border/50 px-3 py-2 last:border-b-0">
                    <div className="flex items-baseline gap-2">
                      <span className="font-mono text-[10px] text-km-faint">{clock(event.at)}</span>
                      <span className={cn("text-[10px] uppercase tracking-wide", KINDS[event.kind])}>{event.kind}</span>
                      {typeof event.detail?.ms === "number" ? (
                        <span className="ml-auto font-mono text-[10px] text-km-faint">{event.detail.ms}ms</span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 break-words font-mono text-[11px] leading-relaxed text-km-text">{event.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === "prompts" && (
          <div className="flex flex-col gap-3 p-3">
            <p className="text-[11px] leading-relaxed text-km-faint">
              Staged workflows the server publishes. A client can request one by name with{" "}
              <code className="text-km-dim">prompts/get</code> — the arguments are filled in and the whole brief is returned.
            </p>
            <select
              value={promptName}
              onChange={(e) => {
                setPromptName(e.target.value);
                setPromptArgs({});
              }}
              className="h-8 rounded border border-km-border bg-km-track px-2 text-[12px] text-km-text outline-none focus:ring-1 focus:ring-km-accent"
            >
              {PROMPT_TEMPLATES.map((entry) => (
                <option key={entry.name} value={entry.name} className="bg-km-panel2">
                  {entry.title}
                </option>
              ))}
            </select>

            {prompt ? (
              <>
                <p className="text-[11px] leading-relaxed text-km-dim">{prompt.description}</p>
                {prompt.arguments.map((argument) => (
                  <label key={argument.name} className="flex flex-col gap-1">
                    <span className="font-mono text-[10.5px] text-km-faint">
                      {argument.name}
                      {argument.required ? <span className="text-km-accent"> *</span> : null}
                    </span>
                    <Input
                      value={promptArgs[argument.name] ?? ""}
                      placeholder={argument.description}
                      onChange={(e) => setPromptArgs((current) => ({ ...current, [argument.name]: e.target.value }))}
                      className="h-7 border-km-border bg-km-track text-[11.5px] text-km-text focus-visible:ring-1 focus-visible:ring-km-accent"
                    />
                  </label>
                ))}

                <div className="flex items-center justify-between">
                  <span className="text-[10.5px] text-km-faint">Rendered brief</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void copy(promptText, "prompt")}
                    disabled={!promptText}
                    className="h-6 gap-1 px-1.5 text-[10.5px] text-km-dim hover:bg-km-raised hover:text-km-text"
                  >
                    {copied === "prompt" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    Copy
                  </Button>
                </div>
                <pre className="max-h-[46vh] overflow-auto whitespace-pre-wrap rounded border border-km-border bg-km-track p-2.5 font-mono text-[10.5px] leading-relaxed text-km-dim [scrollbar-width:thin]">
                  {promptText || "…"}
                </pre>
              </>
            ) : null}
          </div>
        )}

        {tab === "call" && (
          <div className="flex flex-col gap-3 p-3">
            <p className="text-[11px] leading-relaxed text-km-faint">
              Runs through the same JSON-RPC path a host uses. A tool that refuses comes back in-band; bad arguments are a
              protocol error.
            </p>

            <select
              value={toolName}
              onChange={(e) => {
                setToolName(e.target.value);
                setResult(null);
              }}
              className="h-8 rounded border border-km-border bg-km-track px-2 font-mono text-[11.5px] text-km-text outline-none focus:ring-1 focus:ring-km-accent"
            >
              {GROUPS.map((group) => (
                <optgroup key={group.id} label={group.label}>
                  {group.tools.map((entry) => (
                    <option key={entry.name} value={entry.name} className="bg-km-panel2">
                      {entry.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            <textarea
              value={argsText}
              onChange={(e) => setArgsText(e.target.value)}
              spellCheck={false}
              rows={4}
              className="w-full resize-y rounded border border-km-border bg-km-track p-2 font-mono text-[11px] text-km-text outline-none focus:ring-1 focus:ring-km-accent"
            />
            {tool ? <SchemaHint tool={tool} /> : null}

            <Button
              size="sm"
              onClick={() => void runTool()}
              disabled={busy}
              className="h-7 gap-1.5 bg-km-accent text-[11.5px] text-white hover:bg-km-accent2"
            >
              <Play className="h-3 w-3" />
              {busy ? "Running…" : "Run call"}
            </Button>

            <div className="flex flex-wrap gap-1 border-t border-km-border pt-2">
              {agentServer.resources.map((resource) => (
                <button
                  key={resource.uri}
                  type="button"
                  onClick={() => void readResource(resource.uri)}
                  title={resource.description}
                  className="rounded border border-km-border px-1.5 py-0.5 font-mono text-[10px] text-km-dim transition hover:bg-km-raised hover:text-km-text"
                >
                  {resource.uri.replace("octo-cut://", "")}
                </button>
              ))}
            </div>

            {result ? (
              <pre
                className={cn(
                  "max-h-[42vh] overflow-auto whitespace-pre-wrap rounded border p-2.5 font-mono text-[10.5px] leading-relaxed [scrollbar-width:thin]",
                  result.ok ? "border-km-border bg-km-track text-km-dim" : "border-red-500/40 bg-red-500/5 text-red-300",
                )}
              >
                {result.text}
              </pre>
            ) : null}
          </div>
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ *
 * The remote endpoint
 * ------------------------------------------------------------------ */

/**
 * The one thing here that reaches outside the page: a real HTTP listener, so an
 * AI tool that only understands a URL can drive the editor. It sits above the
 * tabs rather than inside one because it is the control a person comes back to —
 * to read the URL, to copy it, or to stop serving.
 */
function RemoteBar({
  available,
  status,
  busy,
  copied,
  onCopy,
  onToggle,
}: {
  available: boolean;
  status: HttpHostStatus;
  busy: boolean;
  copied: boolean;
  onCopy: () => void;
  onToggle: () => void;
}) {
  const live = available && status.running;

  /** Which piece of software is holding the socket, said plainly. */
  const backing = status.backing === "desktop" ? "desktop app" : status.backing === "dev-server" ? "dev server" : "";

  const detail = !available
    ? "Nothing to attach to — this build is static files. The dev server and the desktop app each serve an endpoint."
    : status.error
      ? status.error
      : status.running
        ? `${status.requests} message${status.requests === 1 ? "" : "s"}${status.streams ? ` · ${status.streams} stream(s)` : ""}`
        : status.backing === "desktop"
          ? `Off. Starts on port ${PREFERRED_MCP_PORT}.`
          : "Off. Start it to get a URL an AI tool can point at.";

  return (
    <section className="shrink-0 border-b border-km-border bg-km-track px-3 py-2">
      <div className="flex items-center gap-2">
        <Globe className={cn("h-3.5 w-3.5 shrink-0", live ? "text-emerald-400" : "text-km-faint")} />
        <span className="text-[11.5px] font-medium text-km-text">HTTP endpoint</span>
        {backing ? (
          <span className="rounded bg-km-panel2 px-1 py-px text-[9.5px] uppercase tracking-wide text-km-faint">{backing}</span>
        ) : null}
        <span className="ml-auto text-[10px] text-km-faint">{live ? "live" : "idle"}</span>
      </div>

      {live && status.url ? (
        <div className="mt-1.5 flex items-center gap-1.5">
          <code className="min-w-0 flex-1 truncate rounded border border-km-border bg-km-panel px-2 py-1 font-mono text-[11px] text-sky-300">
            {status.url}
          </code>
          <Button
            size="sm"
            variant="ghost"
            onClick={onCopy}
            title="Copy the URL for an AI tool's MCP settings"
            className="h-7 shrink-0 gap-1 px-1.5 text-[10.5px] text-km-dim hover:bg-km-raised hover:text-km-text"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            Copy
          </Button>
        </div>
      ) : null}

      <div className="mt-1.5 flex items-center gap-2">
        <p className="min-w-0 flex-1 text-[10px] leading-snug text-km-faint">{detail}</p>
        <Button
          size="sm"
          onClick={onToggle}
          disabled={!available || busy}
          className={cn(
            "h-6 shrink-0 gap-1 px-2 text-[10.5px]",
            status.running
              ? "bg-km-raised text-km-text hover:bg-km-panel2"
              : "bg-km-accent text-white hover:bg-km-accent2",
          )}
        >
          <Plug className="h-3 w-3" />
          {busy ? "…" : status.running ? "Stop" : "Start"}
        </Button>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Surface
 * ------------------------------------------------------------------ */

function SurfaceTab({
  descriptor,
  status,
  handshake,
  snippet,
  copied,
  onCopy,
  onPickTool,
  onReadResource,
}: {
  descriptor: ReturnType<typeof agentDescriptor>;
  status: ReturnType<typeof agentBridgeStatus>;
  handshake: { protocolVersion: string; instructions?: string } | null;
  snippet: string;
  copied: string | null;
  onCopy: (text: string, tag: string) => void;
  onPickTool: (name: string) => void;
  onReadResource: (uri: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 p-3">
      <section className="rounded border border-km-border bg-km-track p-2.5">
        <div className="flex items-center gap-2">
          <Radio className={cn("h-3.5 w-3.5", status.listening ? "text-emerald-400" : "text-km-faint")} />
          <span className="text-[11.5px] font-medium text-km-text">
            {status.listening ? "Listening for a host" : "Bridge not running"}
          </span>
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[10.5px]">
          <dt className="text-km-faint">Channel</dt>
          <dd className="font-mono text-km-dim">{status.channel}</dd>
          <dt className="text-km-faint">Protocol</dt>
          <dd className="font-mono text-km-dim">{handshake?.protocolVersion ?? "not negotiated yet"}</dd>
          <dt className="text-km-faint">Accepts from</dt>
          <dd className="font-mono text-km-dim">{status.allow.join(", ") || "this origin only"}</dd>
          <dt className="text-km-faint">Published</dt>
          <dd className="text-km-dim">
            {descriptor.tools} tools · {descriptor.resources.length} resources · {descriptor.prompts.length} prompts
          </dd>
          <dt className="text-km-faint">Session</dt>
          <dd className="text-km-dim">
            {agentServer.state().calls} calls · {agentServer.state().errors} errors · ~
            {agentServer.state().tokensOut.toLocaleString()} tok out
          </dd>
        </dl>
        {status.lastOrigin ? (
          <p className="mt-1.5 text-[10.5px] text-km-faint">
            Last message from {status.lastOrigin}
            {status.lastAt ? ` ${clock(status.lastAt)}` : ""}
          </p>
        ) : null}
      </section>

      <section className="rounded border border-km-border bg-km-track p-2.5">
        <div className="flex items-center justify-between">
          <span className="text-[11.5px] font-medium text-km-text">Connect to it</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onCopy(snippet, "snippet")}
            className="h-6 gap-1 px-1.5 text-[10.5px] text-km-dim hover:bg-km-raised hover:text-km-text"
          >
            {copied === "snippet" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            Copy
          </Button>
        </div>
        <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-km-dim [scrollbar-width:thin]">
          {snippet}
        </pre>
      </section>

      {handshake?.instructions ? (
        <section className="rounded border border-km-border bg-km-track p-2.5">
          <p className="text-[11.5px] font-medium text-km-text">What every client is told at initialize</p>
          <p className="mt-1.5 whitespace-pre-wrap text-[10.5px] leading-relaxed text-km-dim">{handshake.instructions}</p>
        </section>
      ) : null}

      {GROUPS.map((group) => (
        <section key={group.id}>
          <div className="mb-1 flex items-baseline gap-2">
            <h3 className="text-[11.5px] font-medium text-km-text">{group.label}</h3>
            <span className="text-[10px] text-km-faint">
              {group.tools.length} · {group.hint}
            </span>
          </div>
          <ul className="rounded border border-km-border">
            {group.tools.map((entry) => (
              <li key={entry.name} className="border-b border-km-border/60 last:border-b-0">
                <button
                  type="button"
                  onClick={() => onPickTool(entry.name)}
                  className="flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left transition hover:bg-km-raised"
                >
                  <span className="font-mono text-[11px] text-km-accent">{entry.name}</span>
                  <span className="text-[10px] leading-snug text-km-faint">{entry.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section>
        <div className="mb-1 flex items-baseline gap-2">
          <h3 className="text-[11.5px] font-medium text-km-text">Resources</h3>
          <span className="text-[10px] text-km-faint">{agentServer.resources.length} · read them live</span>
        </div>
        <ul className="rounded border border-km-border">
          {agentServer.resources.map((resource) => (
            <li key={resource.uri} className="border-b border-km-border/60 last:border-b-0">
              <button
                type="button"
                onClick={() => onReadResource(resource.uri)}
                className="flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left transition hover:bg-km-raised"
              >
                <span className="font-mono text-[11px] text-km-accent">{resource.uri}</span>
                <span className="text-[10px] leading-snug text-km-faint">{resource.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** The arguments a tool takes, so a hand-typed call is possible without guessing. */
function SchemaHint({ tool }: { tool: McpTool }) {
  const properties = tool.inputSchema.properties ?? {};
  const required = new Set(tool.inputSchema.required ?? []);
  const entries = Object.entries(properties);
  if (!entries.length) return <p className="text-[10.5px] text-km-faint">Takes no arguments.</p>;

  return (
    <div className="flex flex-col gap-1">
      {entries.map(([name, schema]) => (
        <div key={name} className="flex gap-2 text-[10.5px]">
          <span className={cn("font-mono", required.has(name) ? "text-km-text" : "text-km-faint")}>
            {name}
            {required.has(name) ? "*" : ""}
          </span>
          <span className="min-w-0 flex-1 leading-snug text-km-faint">{schema.description}</span>
        </div>
      ))}
    </div>
  );
}
