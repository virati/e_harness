// Background agent daemon.
//
// Holds ONE set of sessions PER TERMINAL (keyed by EH_TERM_ID), so two
// terminals never share a conversation, an autofill history, or an abort. It
// serves requests over a unix socket and never touches your terminal - the
// client renders everything. That is what lets your real shell keep 100% of its
// native behavior.
//
// Everything that happens is appended to that terminal's event log the instant
// it happens (see store.mjs).
import net from "node:net";
import fs from "node:fs";
import {
  createAskSession,
  createActSession,
  createCommandSession,
  generateCommand,
  runTurn,
  warmup,
} from "./agent.mjs";
import { sockPath, safeTermId } from "./paths.mjs";
import { Store } from "./store.mjs";

const MAX_LINE = 1 << 20; // 1 MiB: a client line longer than this is malformed
const APPROVAL_TIMEOUT_MS = Number(process.env.EH_APPROVAL_TIMEOUT_MS || 120000);

const sock = sockPath();

// Refuse to start if another daemon already owns the socket. Two terminals can
// race to spawn one; without this the second would unlink the first's socket
// and strand it.
async function socketIsLive() {
  return new Promise((resolve) => {
    const c = net.connect(sock);
    const done = (v) => {
      try { c.destroy(); } catch {}
      resolve(v);
    };
    c.on("connect", () => done(true));
    c.on("error", () => done(false));
    setTimeout(() => done(false), 1000);
  });
}

if (await socketIsLive()) {
  console.error("[e_harness] another daemon is already listening; exiting.");
  process.exit(0);
}
try {
  fs.unlinkSync(sock);
} catch {}

// --- per-terminal state ------------------------------------------------------

/** termId -> { store, ask, act, cmd, busy, conn, pending, allowAll, approvalSeq } */
const terms = new Map();

function termEntry(termId) {
  const id = safeTermId(termId);
  let e = terms.get(id);
  if (!e) {
    e = {
      id,
      store: new Store(id),
      ask: null,
      act: null,
      cmd: null,
      busy: false,
      conn: null,
      pending: new Map(),
      allowAll: false,
      approvalSeq: 0,
    };
    terms.set(id, e);
  }
  return e;
}

// Ask the human at that terminal. Resolves "allow" or "deny". Denies rather
// than hangs if the client is gone, and denies on timeout.
function makeApprover(entry) {
  return (req) =>
    new Promise((resolve) => {
      if (entry.allowAll) {
        entry.store.append("approval_auto", { tool: req.tool, summary: req.summary, verdict: "allow" });
        return resolve("allow");
      }
      const conn = entry.conn;
      if (!conn || conn.destroyed) {
        entry.store.append("approval_denied_no_client", { tool: req.tool, summary: req.summary });
        return resolve("deny");
      }
      const id = ++entry.approvalSeq;
      entry.store.append("approval_request", { id, tool: req.tool, summary: req.summary, detail: req.detail });
      const timer = setTimeout(() => {
        if (entry.pending.delete(id)) {
          entry.store.append("approval_result", { id, verdict: "deny", reason: "timeout" });
          resolve("deny");
        }
      }, APPROVAL_TIMEOUT_MS);
      entry.pending.set(id, (verdict) => {
        clearTimeout(timer);
        if (verdict === "allow_all") entry.allowAll = true;
        const v = verdict === "deny" ? "deny" : "allow";
        entry.store.append("approval_result", { id, verdict: v, allowAll: verdict === "allow_all" });
        resolve(v);
      });
      send(conn, { type: "approve", id, tool: req.tool, summary: req.summary, detail: req.detail });
    });
}

const GATED = new Set(["bash", "edit", "write"]);
// True when this tool call is about to raise an approval box on the client.
function willAsk(entry, mode, toolName) {
  return mode === "act" && GATED.has(toolName) && !entry.allowAll;
}

function denyAllPending(entry, reason) {
  for (const [id, resolve] of entry.pending) {
    entry.store.append("approval_result", { id, verdict: "deny", reason });
    resolve("deny");
  }
  entry.pending.clear();
}

async function sessionFor(entry, mode, cwd) {
  if (mode === "act") {
    if (!entry.act) {
      entry.act = await createActSession({
        cwd,
        sessionFile: entry.store.sessionFile("act"),
        requestApproval: makeApprover(entry),
      });
    }
    return entry.act;
  }
  if (!entry.ask) {
    entry.ask = await createAskSession({ cwd, sessionFile: entry.store.sessionFile("ask") });
  }
  return entry.ask;
}

// --- socket ------------------------------------------------------------------

const server = net.createServer((conn) => {
  let buf = "";
  let boundEntry = null;
  conn.on("data", (d) => {
    buf += d.toString("utf8");
    if (buf.length > MAX_LINE) {
      buf = "";
      return conn.destroy();
    }
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a malformed line must never take the daemon down
      }
      if (msg && msg.term) boundEntry = termEntry(msg.term);
      handle(msg, conn).catch((e) => {
        try {
          send(conn, { type: "done", answer: `error: ${e?.message ?? e}`, error: true });
          conn.end();
        } catch {}
      });
    }
  });
  const cleanup = () => {
    if (boundEntry && boundEntry.conn === conn) {
      denyAllPending(boundEntry, "client_disconnected");
      boundEntry.conn = null;
    }
  };
  conn.on("close", cleanup);
  conn.on("error", cleanup);
});

function send(conn, obj) {
  try {
    conn.write(JSON.stringify(obj) + "\n");
  } catch {}
}

async function handle(msg, conn) {
  if (msg.type === "ping") return send(conn, { type: "pong" });
  if (msg.type === "shutdown") {
    send(conn, { type: "bye" });
    return shutdown();
  }

  const entry = termEntry(msg.term);

  if (msg.type === "approve_result") {
    const resolve = entry.pending.get(msg.id);
    if (resolve) {
      entry.pending.delete(msg.id);
      resolve(msg.verdict);
    }
    return;
  }

  if (msg.type === "abort") {
    // Only this terminal's turn. Another terminal's turn is untouched.
    entry.store.append("abort", {});
    denyAllPending(entry, "aborted");
    await entry.ask?.abort?.();
    await entry.act?.abort?.();
    return;
  }

  if (msg.type === "command") {
    // description -> single shell command. Tool-less and stateless, and it can
    // run while a normal turn is streaming in the same terminal.
    entry.store.append("autofill_request", { cwd: msg.cwd, shell: msg.shell, text: msg.text });
    try {
      if (!entry.cmd) entry.cmd = await createCommandSession({ cwd: msg.cwd || process.cwd() });
      const command = await generateCommand(
        entry.cmd,
        msg.cwd || process.cwd(),
        msg.shell || "bash",
        msg.text
      );
      entry.store.append("autofill_result", { command });
      send(conn, { type: "command_result", command });
    } catch (e) {
      const error = String(e?.message ?? e);
      entry.store.append("autofill_error", { error });
      send(conn, { type: "command_result", command: "", error });
    }
    return void conn.end();
  }

  if (msg.type !== "prompt") return;

  const mode = msg.mode === "act" ? "act" : "ask";

  if (entry.busy) {
    send(conn, { type: "done", answer: "this terminal is already mid-turn", error: true });
    return void conn.end();
  }

  entry.busy = true;
  entry.conn = conn;
  entry.allowAll = false; // "allow all" never outlives the turn that granted it
  const turn = entry.store.append("turn_start", { mode, cwd: msg.cwd });
  entry.store.append("prompt", { turn: turn.seq, mode, text: msg.text });

  let answer = "";
  try {
    const session = await sessionFor(entry, mode, msg.cwd || process.cwd());
    await runTurn(session, msg.cwd || process.cwd(), msg.text, mode, {
      // `gated` tells the client an approval box is about to follow for this
      // call, so it should not first print a line that reads as if it already
      // ran. When "allow all" is on no box follows, so the line is printed.
      onCommand: (cmd) => {
        entry.store.append("tool_start", { turn: turn.seq, tool: "bash", command: cmd });
        send(conn, { type: "command", cmd, gated: willAsk(entry, mode, "bash") });
      },
      onTool: (name, summary) => {
        entry.store.append("tool_start", { turn: turn.seq, tool: name, summary });
        send(conn, { type: "tool", name, summary, gated: willAsk(entry, mode, name) });
      },
      onToolResult: (name, ok, summary) => {
        entry.store.append("tool_end", { turn: turn.seq, tool: name, ok, output: summary });
        send(conn, { type: "tool_result", name, ok, summary });
      },
      onText: (delta) => {
        answer += delta;
        // Every delta, the moment it arrives: if this process dies mid-answer
        // the log still holds what had been said.
        entry.store.append("delta", { turn: turn.seq, d: delta });
      },
    });
    entry.store.append("answer", { turn: turn.seq, text: answer });
    send(conn, { type: "done", answer });
  } catch (e) {
    const error = String(e?.message ?? e);
    entry.store.append("turn_error", { turn: turn.seq, error, partial: answer });
    send(conn, { type: "done", answer: answer || `error: ${error}`, error: true });
  } finally {
    entry.store.append("turn_end", { turn: turn.seq });
    entry.busy = false;
    entry.allowAll = false;
    denyAllPending(entry, "turn_ended");
    if (entry.conn === conn) entry.conn = null;
    conn.end();
  }
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const e of terms.values()) e.store.close();
  try {
    fs.unlinkSync(sock);
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("uncaughtException", (e) => {
  console.error("[e_harness] uncaught:", e?.stack ?? e);
});

server.listen(sock, () => {
  // The socket is an unauthenticated channel to an agent that can act as you.
  // Node creates it 0755; the directory is already private, and this makes the
  // socket itself private too.
  try {
    fs.chmodSync(sock, 0o600);
  } catch {}
  console.error(`[e_harness] daemon listening on ${sock}`);
  if (process.send) process.send("ready");
  // Pay the expensive first-session cost now, not on the user's first query.
  warmup(process.cwd()).catch(() => {});
});
