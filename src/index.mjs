#!/usr/bin/env node
// e_harness: a shell-first LLM harness.
//
// You stay in your shell. Lines run as normal commands. Any line that starts
// with '\' is sent to the agent instead, and its high-level answer is printed
// inline in a colored box - you are never dropped into a separate chat UI.
import readline from "node:readline";
import os from "node:os";
import { PersistentShell } from "./shell.mjs";
import { createHarness, runTurn } from "./agent.mjs";
import { box, color, wrapText, visibleWidth } from "./box.mjs";

const HOME = os.homedir();
const shortCwd = (p) => (p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p);
const termWidth = () => process.stdout.columns || 80;

const shell = new PersistentShell(process.cwd());

console.log(
  color.dim("e_harness — shell-first agent. ") +
    color.cyan("\\") +
    color.dim(" = ask the agent, ") +
    color.cyan("\\exit") +
    color.dim(" or Ctrl+D to quit.")
);

let session;
try {
  ({ session } = await createHarness(process.cwd()));
} catch (err) {
  console.error(color.red("Failed to start agent session: ") + (err?.message ?? err));
  console.error(color.dim("Shell commands still work; '\\' prompts are disabled."));
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  historySize: 1000,
});

let busy = false; // a command or agent turn is in flight
let abortAgent = null; // set while the agent is streaming

// Ctrl+C: abort the agent turn if one is running; otherwise let the terminal
// deliver SIGINT to the foreground shell command as usual.
rl.on("SIGINT", () => {
  if (abortAgent) {
    abortAgent();
    return;
  }
  // fresh line, redraw prompt
  process.stdout.write("\n");
  prompt();
});

function promptString() {
  return `${color.dim(shortCwd(shell.cwd))} ${color.cyan("❯")} `;
}

function prompt() {
  rl.setPrompt(promptString());
  rl.prompt();
}

async function handleShell(cmd) {
  await shell.run(cmd, (chunk) => process.stdout.write(chunk));
  await shell.refreshCwd();
}

async function handleAgent(text) {
  if (!session) {
    console.log(color.red("Agent unavailable (no session).") + "\n");
    return;
  }
  if (!text.trim()) return;

  let answer = "";
  let sawTool = false;
  const audit = (s) => console.log(s);

  const controller = { aborted: false };
  abortAgent = () => {
    controller.aborted = true;
    session.abort();
  };

  try {
    await runTurn(session, shell.cwd, text, {
      onCommand: (cmd) => {
        sawTool = true;
        audit(color.dim("  ⟳ ") + color.cyan(cmd));
      },
      onTool: (name, summary) => {
        sawTool = true;
        audit(color.dim(`  ⟳ ${name}${summary ? " " + summary : ""}`));
      },
      onToolResult: (name, ok, summary) => {
        if (!summary) return;
        const head = summary.split("\n").slice(0, 6);
        for (const line of head) audit(color.gray("    " + line));
        const extra = summary.split("\n").length - head.length;
        if (extra > 0) audit(color.gray(`    … (${extra} more lines)`));
      },
      onText: (delta) => {
        answer += delta;
      },
    });
  } catch (err) {
    if (!controller.aborted) {
      console.log(color.red("agent error: ") + (err?.message ?? err));
    }
  } finally {
    abortAgent = null;
  }

  if (sawTool) process.stdout.write("\n");
  const title = controller.aborted ? "ai (aborted)" : "ai";
  const body = answer.trim() || color.dim("(no textual answer)");
  console.log(box(title, body, color.cyan, termWidth()));
}

rl.on("line", async (raw) => {
  const line = raw.trimEnd();
  if (busy) return; // ignore input while a turn is running

  if (line.trim() === "") {
    prompt();
    return;
  }

  if (line.startsWith("\\")) {
    const rest = line.slice(1).trim();
    if (rest === "exit" || rest === "quit") {
      cleanup();
      return;
    }
    busy = true;
    rl.pause();
    await handleAgent(rest);
    busy = false;
    rl.resume();
    prompt();
    return;
  }

  // normal shell command
  busy = true;
  rl.pause();
  try {
    await handleShell(line);
  } catch (err) {
    console.error(color.red(String(err?.message ?? err)));
  }
  busy = false;
  rl.resume();
  prompt();
});

rl.on("close", () => cleanup());

function cleanup() {
  try {
    session?.dispose?.();
  } catch {}
  shell.dispose();
  console.log(color.dim("\nbye."));
  process.exit(0);
}

prompt();
