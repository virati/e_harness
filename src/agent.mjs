// Thin wrapper around the pi agent SDK. Runs the agent headlessly (no pi TUI,
// no interactive chat takeover) and exposes a single runTurn() that streams
// high-level events back to the REPL for inline rendering.
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";

// Small/fast model for describe-to-command (Ctrl-X Ctrl-G). Resolved lazily and
// cached; falls back to the session default if unavailable for this account.
let _fastModel;
function fastModel() {
  if (_fastModel !== undefined) return _fastModel;
  try {
    const registry = ModelRegistry.create(AuthStorage.create());
    _fastModel = registry.find("anthropic", "claude-haiku-4-5") ?? null;
  } catch {
    _fastModel = null;
  }
  return _fastModel;
}

export async function createHarness(cwd) {
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd,
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    thinkingLevel: "off", // keep responses high-level, not a reasoning dump
    sessionManager: SessionManager.create(cwd),
  });
  return { session, modelFallbackMessage };
}

// A separate, tool-less, stateless session used only to translate a natural
// language description into a single shell command.
export async function createCommandSession(cwd) {
  const model = fastModel();
  const { session } = await createAgentSession({
    cwd,
    ...(model ? { model } : {}),
    tools: [], // no tools: this is pure text generation, and it must be fast
    thinkingLevel: "off",
    sessionManager: SessionManager.inMemory(),
  });
  return session;
}

// Translate `desc` into one shell command line. Stateless (history is reset
// each call) so previous queries never leak into the result.
export async function generateCommand(session, cwd, shell, desc) {
  session.agent.state.messages = [];
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
//   onCommand(cmd)       - a shell command the agent decided to run (auditable)
//   onTool(name, summary)- any other tool action (read/edit/write/...)
//   onToolResult(name, ok, summary)
export async function runTurn(session, cwd, promptText, handlers) {
  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "message_update": {
        const e = event.assistantMessageEvent;
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

  // Give the model context about where "here" is, plus the default brevity
  // rule: at most 5 lines unless the user explicitly asks for more.
  const contextual =
    `[e_harness context]\n` +
    `cwd: ${cwd}\n` +
    `Answer in at most 5 lines. Be terse and high-level; skip preamble and ` +
    `caveats. Only exceed 5 lines if the user's request explicitly asks for ` +
    `more detail (e.g. "in detail", "long", "step by step", a specific line/word count).\n` +
    `---\n${promptText}`;
  try {
    await session.prompt(contextual);
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
      const text = content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      return text;
    }
  } catch {}
  return "";
}
