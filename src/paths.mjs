// Shared locations for the daemon socket, per-terminal state, and scripts.
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const uid = typeof process.getuid === "function" ? process.getuid() : "u";

// Directory that holds the daemon socket. The socket carries an unauthenticated
// control channel for an agent that can run commands as you, so it MUST live in
// a directory only you can enter. $XDG_RUNTIME_DIR is already 0700; the tmpdir
// fallback is world-writable, so we make our own 0700 subdirectory there.
export function sockDir() {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg && isPrivateOwnedDir(xdg)) return xdg;
  const dir = path.join(os.tmpdir(), `e_harness-${uid}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700); // in case it already existed with looser bits
  if (!isPrivateOwnedDir(dir)) {
    throw new Error(`refusing to use ${dir}: not a private directory owned by uid ${uid}`);
  }
  return dir;
}

function isPrivateOwnedDir(dir) {
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) return false;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return false;
    return (st.mode & 0o077) === 0; // no group/other access
  } catch {
    return false;
  }
}

export function sockPath() {
  return path.join(sockDir(), `e_harness-${uid}.sock`);
}

// Per-terminal persistent state: one directory per terminal, holding the
// real-time event log plus the pi session files for each mode.
export function stateDir() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "e_harness");
}

export function safeTermId(id) {
  const s = String(id ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  return s || "unknown";
}

export function termDir(termId) {
  return path.join(stateDir(), "terminals", safeTermId(termId));
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const daemonScript = path.join(here, "daemon.mjs");
export const askScript = path.join(here, "ask.mjs");
export const projectRoot = path.resolve(here, "..");
