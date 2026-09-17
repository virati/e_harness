// Tiny client invoked by the zsh widget for a '\' line. Connects to the daemon,
// streams the high-level events, and prints the colored box to the terminal.
// If the daemon is not running, it starts one and retries - so the integration
// works even when sourced directly into your own ~/.zshrc.
import net from "node:net";
import { spawn } from "node:child_process";
import { box, color } from "./box.mjs";
import { sockPath, daemonScript } from "./paths.mjs";

// argv: ["--", "the prompt text ..."]  (everything after -- is the query)
const argv = process.argv.slice(2);
const sepIdx = argv.indexOf("--");
const text = (sepIdx >= 0 ? argv.slice(sepIdx + 1) : argv).join(" ").trim();

if (!text) process.exit(0);

const cwd = process.cwd();
const width = () => process.stdout.columns || 80;

function render(events) {
  let answer = "";
  let aborted = false;
  let sawTool = false;

  const conn = net.connect(sockPath());
  conn.on("connect", () => conn.write(JSON.stringify({ type: "prompt", cwd, text }) + "\n"));

  let buf = "";
  conn.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onMsg(JSON.parse(line));
    }
  });
  conn.on("error", (e) => events.onError(e));

  process.on("SIGINT", () => {
    aborted = true;
    try {
      conn.write(JSON.stringify({ type: "abort" }) + "\n");
    } catch {}
  });

  function onMsg(m) {
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
      case "done": {
        // Reset SGR before drawing the box so no earlier stream state lingers.
        process.stdout.write(color.reset);
        if (sawTool) process.stdout.write("\n");
        const title = aborted ? "ai (aborted)" : "ai";
        const body = (m.answer || "").trim() || color.dim("(no answer)");
        console.log(box(title, body, m.error ? color.red : color.cyan, width()));
        conn.end();
        process.exit(0);
      }
    }
  }
}

let started = false;
function connectWithAutostart() {
  render({
    onError: (e) => {
      if ((e.code === "ENOENT" || e.code === "ECONNREFUSED") && !started) {
        started = true;
        // start the daemon detached, then retry shortly
        const child = spawn(process.execPath, [daemonScript], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        setTimeout(connectWithAutostart, 600);
      } else if (started && (e.code === "ENOENT" || e.code === "ECONNREFUSED")) {
        // still coming up; keep polling briefly
        setTimeout(connectWithAutostart, 400);
      } else {
        console.error(color.red("e_harness: ") + (e?.message ?? e));
        process.exit(1);
      }
    },
  });
}

connectWithAutostart();
