// Client invoked by the shell integration. Two modes:
//
//   (default)        ask the agent; stream events and print a colored box.
//   --mode command   translate a description into a single shell command and
//                    print ONLY that command to stdout (for the editor to
//                    capture and insert - it is never executed here).
//
// If the daemon is not running, it is started and the request retried.
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { box, color } from "./box.mjs";
import { sockPath, daemonScript } from "./paths.mjs";

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
const width = () => process.stdout.columns || 80;

const request =
  mode === "command"
    ? { type: "command", cwd, shell: shellName, text }
    : { type: "prompt", cwd, text };

let aborted = false;
let sawTool = false;

function onMsg(m, conn) {
  switch (m.type) {
    case "command":
      sawTool = true;
      console.log(color.dim("  ⟳ ") + color.cyan(m.cmd));
      break;
    case "tool":
      sawTool = true;
      console.log(color.dim(`  ⟳ ${m.name}${m.summary ? " " + m.summary : ""}`));
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
      const title = aborted ? "ai (aborted)" : "ai";
      const body = (m.answer || "").trim() || color.dim("(no answer)");
      console.log(box(title, body, m.error ? color.red : color.cyan, width()));
      conn.end();
      process.exit(0);
    }
  }
}

function connect() {
  const conn = net.connect(sockPath());
  conn.on("connect", () => conn.write(JSON.stringify(request) + "\n"));

  let buf = "";
  conn.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onMsg(JSON.parse(line), conn);
    }
  });

  if (mode !== "command") {
    process.on("SIGINT", () => {
      aborted = true;
      try {
        conn.write(JSON.stringify({ type: "abort" }) + "\n");
      } catch {}
    });
  }

  conn.on("error", (e) => onError(e));
}

let started = false;
function onError(e) {
  if ((e.code === "ENOENT" || e.code === "ECONNREFUSED") && !started) {
    started = true;
    const child = spawn(process.execPath, [daemonScript], { detached: true, stdio: "ignore" });
    child.unref();
    setTimeout(connect, 600);
  } else if (started && (e.code === "ENOENT" || e.code === "ECONNREFUSED")) {
    setTimeout(connect, 400);
  } else {
    process.stderr.write(color.red("e_harness: ") + (e?.message ?? e) + "\n");
    process.exit(1);
  }
}

connect();
