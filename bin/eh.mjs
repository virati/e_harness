#!/usr/bin/env node
// `eh` launcher.
//
// Drops you into YOUR real interactive zsh (identical prompt, completion,
// keybindings) with the e_harness '\' integration loaded, and makes sure the
// agent daemon is running. Nothing wraps your shell, so everything - clear,
// tab-complete, Ctrl-R, your prompt theme - behaves exactly as outside.
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sockPath, daemonScript } from "../src/paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const zshIntegration = path.join(root, "shell", "e_harness.zsh");
const bashIntegration = path.join(root, "shell", "e_harness.bash");

const arg = process.argv[2];

function ping() {
  return new Promise((resolve) => {
    const c = net.connect(sockPath());
    c.on("connect", () => {
      c.end();
      resolve(true);
    });
    c.on("error", () => resolve(false));
  });
}

async function ensureDaemon() {
  if (await ping()) return;
  const child = spawn(process.execPath, [daemonScript], { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (await ping()) return;
  }
  console.error("e_harness: daemon did not come up in time (continuing anyway).");
}

async function stopDaemon() {
  const c = net.connect(sockPath());
  let acked = false;
  c.on("connect", () => c.write(JSON.stringify({ type: "shutdown" }) + "\n"));
  c.on("data", () => {
    acked = true;
  });
  // exit only after the connection actually closes, so the write is flushed and
  // the daemon has had a chance to unlink its socket
  c.on("close", () => {
    console.log(acked ? "e_harness: daemon stopped." : "e_harness: daemon closed.");
    process.exit(0);
  });
  c.on("error", () => {
    console.log("e_harness: daemon not running.");
    process.exit(0);
  });
}

if (arg === "--stop") {
  await stopDaemon();
} else if (arg === "--help" || arg === "-h") {
  console.log(
    "eh            launch your shell (bash/zsh) with the '\\ ' agent integration\n" +
      "eh --stop     stop the background agent daemon\n\n" +
      "Inside the shell: type commands normally; start a line with '\\ ' (backslash+space) to ask the agent.\n" +
      "Or add to your rc file:\n" +
      "  bash:  source " + bashIntegration + "\n" +
      "  zsh:   source " + zshIntegration
  );
  process.exit(0);
} else {
  await ensureDaemon();

  // Launch YOUR shell so the prompt/completion/env are exactly what you always
  // see. We load your real rc verbatim, then our integration on top.
  const shell = process.env.SHELL || "/bin/bash";
  const isZsh = /zsh$/.test(shell);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eh-"));
  const baseEnv = { ...process.env, EH_NODE: process.execPath };

  let cmd, args, env;
  if (isZsh) {
    // zsh only honors a custom rc dir via ZDOTDIR; source real config, then
    // ours, then restore ZDOTDIR so your prompt/env are exactly normal.
    const realZdot = process.env.ZDOTDIR || os.homedir();
    fs.writeFileSync(
      path.join(tmp, ".zshenv"),
      `[[ -f "$EH_REAL_ZDOTDIR/.zshenv" ]] && source "$EH_REAL_ZDOTDIR/.zshenv"\n`
    );
    fs.writeFileSync(
      path.join(tmp, ".zshrc"),
      `[[ -f "$EH_REAL_ZDOTDIR/.zshrc" ]] && source "$EH_REAL_ZDOTDIR/.zshrc"\n` +
        `source "$EH_INTEGRATION"\n` +
        `export ZDOTDIR="$EH_REAL_ZDOTDIR"\n`
    );
    cmd = shell;
    args = ["-i"];
    env = { ...baseEnv, ZDOTDIR: tmp, EH_REAL_ZDOTDIR: realZdot, EH_INTEGRATION: zshIntegration };
  } else {
    // bash (and bash-compatible): use --rcfile to load your ~/.bashrc, then ours.
    const rc = path.join(tmp, "rc.bash");
    fs.writeFileSync(
      rc,
      `[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"\n` +
        `source "${bashIntegration}"\n`
    );
    cmd = shell;
    args = ["--rcfile", rc, "-i"];
    env = baseEnv;
  }

  const child = spawn(cmd, args, { stdio: "inherit", env });
  child.on("exit", (code) => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
    process.exit(code ?? 0);
  });
}
