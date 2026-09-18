// Client invoked by the shell integration. Three modes:
//
//   --mode ask      read-only agent ("\ ");  streams events, prints a box.
//   --mode act      acting agent ("\! ");    same, plus it prompts you on
//                   /dev/tty before every bash / edit / write.
//   --mode command  translate a description into a single shell command and
//                   print ONLY that command to stdout (for the editor to
//                   capture and insert - it is never executed here).
//
// If the daemon is not running, it is started and the request retried.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { box, color } from "./box.mjs";
import { sockPath, daemonScript } from "./paths.mjs";

const MAX_CONNECT_ATTEMPTS = 25; // ~10s, then give up instead of hanging Enter

const argv = process.argv.slice(2);
let mode = "ask";
let rest = argv;
if (rest[0] === "--mode") {
  mode = rest[1];
  rest = rest.slice(2);
}
const sep = rest.indexOf("--");
const text = (sep >= 0 ? rest.slice(sep + 1) : rest).join(" ").trim();
if (!text) process.exit(0);

const cwd = process.cwd();
const shellName = path.basename(process.env.SHELL || "bash");
// Identifies THIS terminal. The shell integration sets it; without it every
// terminal would land in one shared bucket, so fall back to something unique
// rather than something shared.
const term = process.env.EH_TERM_ID || `nosh-${process.ppid}`;
const width = () => process.stdout.columns || 80;

const request =
  mode === "command"
    ? { type: "command", term, cwd, shell: shellName, text }
    : { type: "prompt", term, mode, cwd, text };

let aborted = false;
let sawTool = false;

// Read one line from the controlling terminal. stdin may be anything, so go to
// /dev/tty directly. Blocking is correct here: we are waiting on a human, and
// the daemon runs gated tools one at a time so nothing else is in flight.
function askTty(promptText) {
  let fd;
  try {
    fd = fs.openSync("/dev/tty", "r+");
  } catch {
    return null; // no terminal to ask -> caller denies
  }
  try {
    fs.writeSync(fd, promptText);
    const b = Buffer.alloc(1);
    let line = "";
    for (;;) {
      let n;
      try {
        n = fs.readSync(fd, b, 0, 1, null);
      } catch (e) {
        if (e.code === "EAGAIN") continue;
        break;
      }
      if (n === 0) break;
      const ch = b.toString("utf8");
      if (ch === "\n" || ch === "\r") break;
      line += ch;
    }
    return line.trim().toLowerCase();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

function onApprove(m, conn) {
  const label = `approve ${m.tool}?`;
  console.log(box(label, m.detail || m.summary || m.tool, color.yellow, width()));
  const answer = askTty(
    color.yellow("  run it? ") + color.dim("[y = yes, n = no, a = yes to everything in this turn] ")
  );
  let verdict = "deny";
  if (answer === "y" || answer === "yes") verdict = "allow";
  else if (answer === "a" || answer === "all") verdict = "allow_all";
  console.log(
    verdict === "deny" ? color.red("  ✗ denied") : color.green(verdict === "allow_all" ? "  ✓ allowed (rest of turn)" : "  ✓ allowed")
  );
  send(conn, { type: "approve_result", term, id: m.id, verdict });
}

function send(conn, obj) {
  try {
    conn.write(JSON.stringify(obj) + "\n");
  } catch {}
}

function onMsg(m, conn) {
  switch (m.type) {
    case "approve":
      onApprove(m, conn);
      break;
    case "command":
      sawTool = true;
      // A gated call is about to show its own approval box; printing it here
      // too would read as if it had already run.
      if (!m.gated) console.log(color.dim("  ⟳ ") + color.cyan(m.cmd));
      break;
    case "tool":
      sawTool = true;
      if (!m.gated) console.log(color.dim(`  ⟳ ${m.name}${m.summary ? " " + m.summary : ""}`));
      break;
    case "tool_result":
      if (m.summary) {
        const head = m.summary.split("\n").slice(0, 6);
        for (const l of head) console.log(color.gray("    " + l));
        const extra = m.summary.split("\n").length - head.length;
        if (extra > 0) console.log(color.gray(`    … (${extra} more lines)`));
      }
      break;
    case "command_result":
      // print the bare command to stdout for the shell to capture
      if (m.error) {
        process.stderr.write("e_harness: " + m.error + "\n");
        process.exitCode = 1;
      } else if (m.command) {
        process.stdout.write(m.command.replace(/\n+$/, "") + "\n");
      }
      conn.end();
      process.exit(process.exitCode || 0);
      break;
    case "done": {
      if (sawTool) process.stdout.write("\n");
      const title = aborted ? "ai (aborted)" : mode === "act" ? "ai (act)" : "ai";
      const body = (m.answer || "").trim() || color.dim("(no answer)");
      console.log(box(title, body, m.error ? color.red : color.cyan, width()));
      conn.end();
      process.exit(0);
    }
  }
}

function connect() {
  const conn = net.connect(sockPath());
  conn.on("connect", () => send(conn, request));

  let buf = "";
  conn.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      onMsg(m, conn);
    }
  });

  if (mode !== "command") {
    process.on("SIGINT", () => {
      aborted = true;
      send(conn, { type: "abort", term });
    });
  }

  conn.on("error", (e) => onError(e));
}

let started = false;
let attempts = 0;
function onError(e) {
  const missing = e.code === "ENOENT" || e.code === "ECONNREFUSED";
  if (!missing) {
    process.stderr.write(color.red("e_harness: ") + (e?.message ?? e) + "\n");
    process.exit(1);
  }
  if (!started) {
    started = true;
    const child = spawn(process.execPath, [daemonScript], { detached: true, stdio: "ignore" });
    child.unref();
    setTimeout(connect, 600);
    return;
  }
  if (++attempts >= MAX_CONNECT_ATTEMPTS) {
    process.stderr.write(
      color.red("e_harness: ") + `daemon did not come up (${attempts} attempts). ` +
        `Try: node ${daemonScript}\n`
    );
    process.exit(1);
  }
  setTimeout(connect, 400);
}

connect();
