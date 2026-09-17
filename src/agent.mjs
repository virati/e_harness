// Thin wrapper around the pi agent SDK. Runs the agent headlessly (no pi TUI,
// no interactive chat takeover) and exposes a single runTurn() that streams
// high-level events back to the REPL for inline rendering.
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

export async function createHarness(cwd) {
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd,
    tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
    thinkingLevel: "off", // keep responses high-level, not a reasoning dump
    sessionManager: SessionManager.create(cwd),
  });
  return { session, modelFallbackMessage };
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

  // Give the model just enough context about where "here" is.
  const contextual = `[cwd: ${cwd}]\n${promptText}`;
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
