// Thin wrapper around the pi agent SDK. Runs the agent headlessly (no pi TUI,
// no interactive chat takeover) and exposes runTurn() streaming high-level
// events back to the client for inline rendering.
//
// TWO SESSION KINDS, deliberately:
//
//   ask  ("\ ")  read-only: read, grep, find, ls. It cannot run a command,
//                write a file or edit one. Nothing to approve, so nothing can
//                go wrong if a file it reads contains hostile instructions.
//
//   act  ("\! ") the same plus bash, edit and write - but each of those three
//                is replaced by a gated wrapper that must get an explicit y/n
//                from the human at the terminal BEFORE it does anything.
//
// pi's createAgentSession() has no permission hook, so the gate is built by
// registering customTools whose names shadow the built-ins (a customTool with
// the same name overrides the built-in in the tool registry) and wrapping their
// execute(). Throwing from execute() is the supported failure path - the agent
// loop turns it into an isError tool result the model can read.
import {
  createAgentSession,
  SessionManager,
  ModelRuntime,
  ModelRegistry,
  createBashTool,
  createEditTool,
  createWriteTool,
  DefaultResourceLoader,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

// e_harness sessions load NO pi extensions. With any of the user's pi packages
// loaded (billion-context, pi-background-tasks, ...), every Anthropic request
// from this SDK process came back 429 "rate_limit_error: Error", while the same
// prompt with none loaded answered at once. e_harness only exposes its own
// tools anyway, so the extensions add nothing here. Skills, prompts and
// AGENTS.md context still load as in pi.
async function resourceLoaderFor(cwd) {
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true });
  await loader.reload();
  return loader;
}

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const GATED_TOOLS = ["bash", "edit", "write"];

// Small/fast model for describe-to-command (Alt-E). Resolved lazily and
// cached; falls back to the session default if unavailable for this account.
const FAST_MODEL = process.env.EH_FAST_MODEL || "claude-haiku-4-5";
let _fastModelPromise;
function fastModel() {
  if (!_fastModelPromise) {
    _fastModelPromise = (async () => {
      try {
        const registry = new ModelRegistry(await ModelRuntime.create());
        return registry.find("anthropic", FAST_MODEL) ?? null;
      } catch {
        return null;
      }
    })();
  }
  return _fastModelPromise;
}

// Local model a turn falls back to when the primary errors out with nothing to
// show (a 429, an outage). "provider/model-id" as registered in
// ~/.pi/agent/models.json; EH_FALLBACK_MODEL="" turns the fallback off.
const FALLBACK_MODEL = process.env.EH_FALLBACK_MODEL ?? "lmstudio/qwen/qwen3.8-27b";
let _fallbackModelPromise;
function fallbackModel() {
  if (!_fallbackModelPromise) {
    _fallbackModelPromise = (async () => {
      if (!FALLBACK_MODEL) return null;
      const i = FALLBACK_MODEL.indexOf("/");
      if (i < 0) return null;
      try {
        const registry = new ModelRegistry(await ModelRuntime.create());
        return registry.find(FALLBACK_MODEL.slice(0, i), FALLBACK_MODEL.slice(i + 1)) ?? null;
      } catch {
        return null;
      }
    })();
  }
  return _fallbackModelPromise;
}

// How long the primary gets to respond at all before the turn moves to the
// fallback. 0 disables the race (fallback then only follows a hard error).
const HANDSHAKE_MS = Number(process.env.EH_HANDSHAKE_MS ?? 5000);

// The turn ended in a provider error and said nothing. pi retries internally
// and then resolves normally with stopReason "error" - it does not throw.
function failedSilently(session) {
  const last = session.messages?.at(-1);
  if (last?.role !== "assistant" || last.stopReason !== "error") return null;
  const said = (last.content ?? []).some((c) => c.type === "text" && c.text.trim());
  return said ? null : last.errorMessage || "provider error";
}

const truncate = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + `… (+${t.length - n} chars)` : t;
};

// What the human is actually being asked to approve. `summary` is the one-line
// version; `detail` is what gets shown in the approval box.
export function describeAction(name, params) {
  if (name === "bash") {
    const cmd = String(params?.command ?? "");
    return { summary: cmd.split("\n")[0], detail: cmd };
  }
  if (name === "write") {
    const content = String(params?.content ?? "");
    const lines = content.split("\n");
    const head = lines.slice(0, 12).join("\n");
    return {
      summary: `overwrite ${params?.path ?? "?"} (${content.length} bytes)`,
      detail: `path: ${params?.path ?? "?"}\nbytes: ${content.length}, lines: ${lines.length}\n---\n` +
        truncate(head, 800) + (lines.length > 12 ? `\n… (+${lines.length - 12} more lines)` : ""),
    };
  }
  if (name === "edit") {
    const edits = Array.isArray(params?.edits) ? params.edits : [];
    const body = edits
      .map((e, i) => `[${i + 1}] - ${truncate(e?.oldText, 240)}\n    + ${truncate(e?.newText, 240)}`)
      .join("\n");
    return {
      summary: `edit ${params?.path ?? "?"} (${edits.length} change${edits.length === 1 ? "" : "s"})`,
      detail: `path: ${params?.path ?? "?"}\n---\n${body}`,
    };
  }
  return { summary: name, detail: truncate(JSON.stringify(params ?? {}), 800) };
}

// Wrap a built-in AgentTool as a ToolDefinition whose execute() asks first.
// `requestApproval({tool, summary, detail}) -> "allow" | "deny"`.
function gate(tool, requestApproval) {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
    constrainedSampling: tool.constrainedSampling,
    prepareArguments: tool.prepareArguments,
    // One at a time: two tools running in parallel would race for the single
    // terminal the approval prompt has to be read from.
    executionMode: "sequential",
    async execute(toolCallId, params, signal, onUpdate, _ctx) {
      const { summary, detail } = describeAction(tool.name, params);
      const verdict = await requestApproval({ tool: tool.name, summary, detail, params });
      if (verdict !== "allow") {
        throw new Error(
          `Denied by the human at the terminal (${tool.name}: ${summary}). ` +
            `Do not retry it and do not try to achieve the same effect another way. ` +
            `Stop and say what you were about to do.`
        );
      }
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}

function sessionManagerFor(sessionFile, cwd) {
  // A fixed file per (terminal, mode). open() on a path that does not exist yet
  // starts a fresh session there; on a path that does, it resumes it - so a
  // terminal keeps its own conversation across daemon restarts, and never sees
  // another terminal's.
  return SessionManager.open(sessionFile, undefined, cwd);
}

// Read-only session: "\ ".
export async function createAskSession({ cwd, sessionFile }) {
  const { session } = await createAgentSession({
    cwd,
    resourceLoader: await resourceLoaderFor(cwd),
    tools: READ_ONLY_TOOLS,
    thinkingLevel: "off", // keep responses high-level, not a reasoning dump
    sessionManager: sessionManagerFor(sessionFile, cwd),
  });
  return session;
}

// Acting session: "\! ". Everything read-only can do, plus bash/edit/write
// behind the approval gate.
export async function createActSession({ cwd, sessionFile, requestApproval }) {
  const { session } = await createAgentSession({
    cwd,
    resourceLoader: await resourceLoaderFor(cwd),
    tools: [...READ_ONLY_TOOLS, ...GATED_TOOLS],
    customTools: [
      gate(createBashTool(cwd), requestApproval),
      gate(createEditTool(cwd), requestApproval),
      gate(createWriteTool(cwd), requestApproval),
    ],
    thinkingLevel: "off",
    sessionManager: sessionManagerFor(sessionFile, cwd),
  });
  return session;
}

// Creating the first session in a process is slow (~1.8s cold, ~0.5s once the
// SDK is warm), so the daemon calls this at boot to pay that cost before anyone
// is waiting on it.
export async function warmup(cwd) {
  const { session } = await createAgentSession({
    cwd,
    resourceLoader: await resourceLoaderFor(cwd),
    tools: [],
    thinkingLevel: "off",
    sessionManager: SessionManager.inMemory(),
  });
  session.dispose?.();
}

// A separate, tool-less session used only to translate a natural language
// description into a single shell command. One per terminal, kept in memory:
// each generation is stateless, and the terminal's autofill *history* is the
// event log, not this session.
export async function createCommandSession({ cwd }) {
  const model = await fastModel();
  const { session } = await createAgentSession({
    cwd,
    resourceLoader: await resourceLoaderFor(cwd),
    ...(model ? { model } : {}),
    tools: [], // no tools: this is pure text generation, and it must be fast
    thinkingLevel: "off",
    sessionManager: SessionManager.inMemory(),
  });
  return session;
}

// Translate `desc` into one shell command line. History is cleared first so a
// previous description never leaks into the result. AgentSession exposes no
// public reset, and building a fresh session costs ~0.5s per keystroke, so this
// reaches into agent state directly - the one internal we depend on.
export async function generateCommand(session, cwd, shell, desc) {
  if (Array.isArray(session.agent?.state?.messages)) {
    session.agent.state.messages = [];
  }
  let out = "";
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      out += event.assistantMessageEvent.delta;
    }
  });
  try {
    await session.prompt(
      `Translate the request below into a single ${shell} command line.\n` +
        `Output ONLY the command: no explanation, no markdown, no backticks, no leading "$".\n` +
        `Target OS: ${process.platform}. Current directory: ${cwd}.\n\n` +
        `Request: ${desc}`
    );
  } finally {
    unsubscribe();
  }
  return cleanCommand(out);
}

function cleanCommand(s) {
  let t = (s || "").trim();
  // strip a fenced code block
  t = t.replace(/^```[a-zA-Z0-9]*\s*/, "").replace(/\s*```$/, "").trim();
  // strip surrounding single backticks
  if (t.startsWith("`") && t.endsWith("`")) t = t.slice(1, -1).trim();
  // strip a leading shell prompt marker
  t = t.replace(/^\$\s+/, "");
  // collapse to the command only if the model added trailing prose lines:
  // keep everything if it looks like a single logical command (incl. pipes,
  // && and line continuations), else take the first non-empty line.
  const lines = t.split("\n").filter((l) => l.trim() !== "");
  if (lines.length > 1) {
    const continues = /(\\|\||&&|\|\||;)\s*$/;
    const joined = [];
    for (const l of lines) {
      joined.push(l);
      if (!continues.test(l)) break;
    }
    t = joined.join("\n");
  }
  return t.trim();
}

// Run one prompt turn. `handlers` receives high-level, already-summarized events:
//   onText(delta)        - streamed assistant answer text
//   onCommand(cmd)       - a shell command the agent ran (after approval)
//   onTool(name, summary)- any other tool action (read/edit/write/...)
//   onToolResult(name, ok, summary)
export async function runTurn(session, cwd, promptText, mode, handlers) {
  // "Handshake" = the provider's first successful response. pi pushes "start"
  // only after the HTTP call returns OK, so a 429 being retried never counts.
  let shook = false;
  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type !== "error") shook = true;
        if (e.type === "text_delta") handlers.onText?.(e.delta);
        break;
      }
      case "tool_execution_start": {
        if (event.toolName === "bash") {
          handlers.onCommand?.(event.args?.command ?? "");
        } else {
          handlers.onTool?.(event.toolName, summarizeArgs(event.toolName, event.args));
        }
        break;
      }
      case "tool_execution_end": {
        handlers.onToolResult?.(
          event.toolName,
          !event.isError,
          summarizeResult(event.result)
        );
        break;
      }
    }
  });

  // Context about where "here" is, plus the default brevity rule: at most 5
  // lines unless the user explicitly asks for more.
  const capability =
    mode === "act"
      ? `You may run commands and change files, but bash, edit and write each ` +
        `require the human at this terminal to approve them one at a time. ` +
        `Propose the smallest action that answers the request. If one is denied, stop.\n`
      : `You are READ-ONLY this turn: you have read, grep, find and ls only. ` +
        `You cannot run commands or change files. If the request needs that, say so ` +
        `in one line and tell the user to re-ask with '\\! ' instead of '\\ '.\n`;
  const contextual =
    `[e_harness context]\n` +
    `cwd: ${cwd}\n` +
    `Your file tools resolve relative paths against the session root, NOT against ` +
    `cwd above. Always use absolute paths.\n` +
    capability +
    `Answer in at most 5 lines. Be terse and high-level; skip preamble and ` +
    `caveats. Only exceed 5 lines if the user's request explicitly asks for ` +
    `more detail (e.g. "in detail", "long", "step by step", a specific line/word count).\n` +
    `---\n${promptText}`;
  try {
    // No handshake within HANDSHAKE_MS: abort (this also cancels pi's own
    // backoff-and-retry of a 429) and go to the local model right away.
    let timedOut = false;
    const local = await fallbackModel();
    const timer =
      local && HANDSHAKE_MS > 0
        ? setTimeout(() => {
            if (shook) return;
            timedOut = true;
            session.abort().catch(() => {});
          }, HANDSHAKE_MS)
        : null;
    try {
      await session.prompt(contextual);
    } finally {
      clearTimeout(timer);
    }
    const error = timedOut ? `no handshake within ${HANDSHAKE_MS / 1000}s` : failedSilently(session);
    if (!error) return { fallback: null };
    // Primary failed with nothing to show: rerun this turn once on the local
    // model, then put the primary back so the next turn tries it first.
    const primary = session.model;
    if (!local || !primary || local === primary) throw new Error(error);
    handlers.onFallback?.(`${primary.id}: ${truncate(error, 80)}; using ${local.id}`);
    await session.setModel(local);
    try {
      // Drop the empty error/aborted replies so the prompt is the last message
      // again and continue() answers it without adding a duplicate (same state
      // internal generateCommand relies on).
      const msgs = [...session.agent.state.messages];
      while (msgs.length && msgs.at(-1).role === "assistant" && ["error", "aborted"].includes(msgs.at(-1).stopReason)) {
        msgs.pop();
      }
      session.agent.state.messages = msgs;
      await session.agent.continue();
    } finally {
      await session.setModel(primary).catch(() => {});
    }
    const again = failedSilently(session);
    if (again) throw new Error(`${error}; fallback ${local.id}: ${again}`);
    return { fallback: local.id };
  } finally {
    unsubscribe();
  }
}

function summarizeArgs(name, args) {
  if (!args) return "";
  if (args.path) return args.path;
  if (args.pattern) return args.pattern;
  if (args.file_path) return args.file_path;
  return "";
}

function summarizeResult(result) {
  try {
    const content = result?.content;
    if (Array.isArray(content)) {
      return content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    }
  } catch {}
  return "";
}
