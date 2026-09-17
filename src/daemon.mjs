// Background agent daemon. Holds ONE long-lived pi agent session (so the
// conversation persists across '\' queries) and serves requests over a unix
// socket. It never touches your terminal or your shell - the client renders
// output. This is what lets your real zsh keep 100% of its native behavior.
import net from "node:net";
import fs from "node:fs";
import { createHarness, runTurn } from "./agent.mjs";
import { sockPath } from "./paths.mjs";

const path = sockPath();
try {
  fs.unlinkSync(path);
} catch {}

let session = null;
const ready = createHarness(process.cwd())
  .then((r) => (session = r.session))
  .catch((e) => {
    console.error("[e_harness] agent init failed:", e?.message ?? e);
  });

let busy = false;

const server = net.createServer((conn) => {
  let buf = "";
  conn.on("data", (d) => {
    buf += d.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) handle(JSON.parse(line), conn);
    }
  });
  conn.on("error", () => {});
});

function send(conn, obj) {
  try {
    conn.write(JSON.stringify(obj) + "\n");
  } catch {}
}

async function handle(msg, conn) {
  if (msg.type === "ping") return send(conn, { type: "pong" });
  if (msg.type === "abort") return void session?.abort();
  if (msg.type === "shutdown") {
    send(conn, { type: "bye" });
    return shutdown();
  }
  if (msg.type !== "prompt") return;

  await ready;
  if (!session) {
    send(conn, { type: "done", answer: "agent unavailable", error: true });
    return conn.end();
  }
  if (busy) {
    send(conn, { type: "done", answer: "agent is busy with another request", error: true });
    return conn.end();
  }

  busy = true;
  let answer = "";
  try {
    await runTurn(session, msg.cwd || process.cwd(), msg.text, {
      onCommand: (cmd) => send(conn, { type: "command", cmd }),
      onTool: (name, summary) => send(conn, { type: "tool", name, summary }),
      onToolResult: (name, ok, summary) => send(conn, { type: "tool_result", name, ok, summary }),
      onText: (delta) => (answer += delta),
    });
    send(conn, { type: "done", answer });
  } catch (e) {
    send(conn, { type: "done", answer: answer || `error: ${e?.message ?? e}`, error: true });
  } finally {
    busy = false;
    conn.end();
  }
}

function shutdown() {
  try {
    fs.unlinkSync(path);
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(path, () => {
  console.error(`[e_harness] daemon listening on ${path}`);
  if (process.send) process.send("ready");
});
