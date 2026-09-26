// Per-terminal, append-only, REAL-TIME event log.
//
// Every event is written with fs.writeSync to an O_APPEND fd the moment it
// happens - including each streamed text delta, each tool call, and each
// approval decision. Nothing is buffered in userspace and nothing waits for the
// turn to finish, so if the daemon is killed mid-answer the log still contains
// everything up to the instant it died.
//
// This is deliberately separate from pi's own SessionManager: pi persists at
// message granularity and defers the first write until an assistant message
// arrives, so a turn interrupted mid-stream leaves no trace there. pi's files
// are the conversation state (used to resume); this file is the record.
import fs from "node:fs";
import path from "node:path";
import { termDir } from "./paths.mjs";

export class Store {
  constructor(termId) {
    this.termId = termId;
    this.dir = termDir(termId);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.file = path.join(this.dir, "events.jsonl");
    this.fd = fs.openSync(this.file, "a", 0o600);
    this.run = `${Date.now().toString(36)}-${process.pid}`;
    this.seq = 0;
    this.append("open", { pid: process.pid });
  }

  // Path of the pi session file for a given mode ("ask" | "act" | "cmd").
  sessionFile(mode) {
    return path.join(this.dir, `${mode}.session.jsonl`);
  }

  append(kind, data = {}) {
    const rec = { run: this.run, seq: ++this.seq, t: new Date().toISOString(), kind, ...data };
    try {
      fs.writeSync(this.fd, JSON.stringify(rec) + "\n");
    } catch {
      // A failed log write must never take down a turn.
    }
    return rec;
  }

  close() {
    try {
      this.append("close", {});
      fs.closeSync(this.fd);
    } catch {}
  }
}
