// Shared locations for the daemon socket and scripts.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const uid = typeof process.getuid === "function" ? process.getuid() : "u";

export function sockPath() {
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(base, `e_harness-${uid}.sock`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const daemonScript = path.join(here, "daemon.mjs");
export const askScript = path.join(here, "ask.mjs");
export const projectRoot = path.resolve(here, "..");
