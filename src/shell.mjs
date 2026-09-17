// A persistent shell session. Commands run in one long-lived shell process so
// that `cd`, `export`, and shell variables persist across invocations - exactly
// like a normal terminal. Output is streamed back via an onChunk callback and
// each command's exit code is recovered with a unique sentinel marker.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

export class PersistentShell {
  constructor(cwd = process.cwd(), shellPath = process.env.SHELL || "/bin/bash") {
    this.marker = "__EH_" + randomBytes(6).toString("hex") + "__";
    this.cwd = cwd;
    this.queue = [];
    this.current = null;
    this.buf = "";
    this.doneRe = new RegExp(`\\n?${this.marker} (-?\\d+)\\r?\\n`);

    this.proc = spawn(shellPath, [], {
      cwd,
      env: { ...process.env, PS1: "", TERM: "dumb", PAGER: "cat", GIT_PAGER: "cat" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (d) => this._onData(d.toString("utf8")));
    // merge stderr into the same stream so output ordering is roughly preserved
    this.proc.stderr.on("data", (d) => this.current?.onChunk?.(d.toString("utf8")));
    this.proc.on("exit", () => {
      if (this.current) {
        this.current.resolve({ code: 130 });
        this.current = null;
      }
    });
  }

  // Run `cmd`, streaming output to onChunk. Resolves with { code } on completion.
  run(cmd, onChunk) {
    return new Promise((resolve) => {
      this.queue.push({ cmd, onChunk, resolve });
      this._next();
    });
  }

  // Run `cmd` silently and return { code, output } once complete.
  async capture(cmd) {
    let out = "";
    const { code } = await this.run(cmd, (c) => (out += c));
    return { code, output: out };
  }

  async refreshCwd() {
    const { output } = await this.capture("pwd");
    this.cwd = output.trim() || this.cwd;
    return this.cwd;
  }

  _next() {
    if (this.current || this.queue.length === 0) return;
    this.current = this.queue.shift();
    this.buf = "";
    this.proc.stdin.write(this.current.cmd + "\n");
    // print the sentinel on its own line together with the exit status
    this.proc.stdin.write(`printf '\\n${this.marker} %d\\n' "$?"\n`);
  }

  _onData(text) {
    if (!this.current) return;
    this.buf += text;
    const m = this.buf.match(this.doneRe);
    if (m) {
      const before = this.buf.slice(0, m.index);
      if (before) this.current.onChunk?.(before);
      const cur = this.current;
      this.current = null;
      this.buf = "";
      cur.resolve({ code: parseInt(m[1], 10) });
      this._next();
      return;
    }
    // Emit everything except a tail that might contain a split sentinel.
    const keep = this.marker.length + 16;
    if (this.buf.length > keep) {
      const emit = this.buf.slice(0, this.buf.length - keep);
      this.buf = this.buf.slice(this.buf.length - keep);
      this.current.onChunk?.(emit);
    }
  }

  dispose() {
    try {
      this.proc.stdin.end();
      this.proc.kill();
    } catch {}
  }
}
