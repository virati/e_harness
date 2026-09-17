# e_harness

A **shell-first** LLM harness. The inverse of Claude Code / pi: instead of
dropping you into a chat UI where the default is natural language and `!` escapes
to the shell, you **stay in your shell** and everything runs as a normal command —
until a line starts with `\`, which is sent to the agent.

The agent never takes over the screen. It answers **inline, in a colored box**,
right where you are in the terminal, so the whole transcript (including any
commands the agent ran) stays in your normal scrollback — selectable and
auditable exactly as if you had typed it.

```
~/projects/e_harness ❯ ls
bin  node_modules  package.json  src
~/projects/e_harness ❯ git status --short
 M src/index.mjs
~/projects/e_harness ❯ \ what changed in this repo and is it safe to commit?
  ⟳ git diff --stat
    src/index.mjs | 12 +++++---
╭─ ai ─────────────────────────────────────────────────────────╮
│ Only src/index.mjs changed (REPL loop tweaks). No secrets or  │
│ generated files are staged — safe to commit.                  │
╰───────────────────────────────────────────────────────────────╯
~/projects/e_harness ❯
```

## Design

| Concern              | Behaviour                                                            |
|----------------------|---------------------------------------------------------------------|
| Normal input         | Runs verbatim in a **persistent shell** (`cd`, `export`, vars persist) |
| `\ <prompt>`         | Sent to the agent; high-level answer printed in a colored box        |
| Agent shell commands | Printed inline as `⟳ <cmd>` (auditable, as if you typed them)         |
| Screen               | Never cleared / no alternate screen — pure inline scrollback         |
| `\exit` / Ctrl+D     | Quit                                                                  |
| Ctrl+C               | Abort the current agent turn (or interrupt the running command)      |

Reasoning/thinking is intentionally suppressed (`thinkingLevel: "off"`) so the
box shows a **high-level result**, not a reasoning dump.

## Layout

```
projects/e_harness/
├── bin/eh.mjs        # executable entry
├── src/
│   ├── index.mjs     # REPL: shell vs. '\' routing, inline rendering
│   ├── shell.mjs     # persistent shell (streamed output + exit codes)
│   ├── agent.mjs     # pi agent SDK glue (runs headless, streams events)
│   └── box.mjs       # ANSI colors + colored-box renderer
└── package.json
```

Built on the pi agent SDK (`@earendil-works/pi-coding-agent`) — it reuses your
existing pi models, auth, and tools, but with none of pi's interactive UI.

## Run

Requires Node ≥ 22 (uses ESM + top-level await; no build step).

```bash
cd projects/e_harness
npm link @earendil-works/pi-coding-agent   # reuse the globally-installed pi
node src/index.mjs                         # or: ./bin/eh.mjs
```

Model/API keys are resolved from your pi config (`~/.pi/agent/auth.json`,
env vars, etc.), same as pi itself.

## Notes & limitations

- The persistent shell is non-interactive, so full-screen TUIs launched *inside*
  a command (`vim`, `less`, `top`) won't render well. Run those in a normal shell.
- Aliases from your interactive rc files are not loaded (non-interactive shell).
- The agent's built-in `bash` tool has its own working directory fixed at
  startup; the current shell `cwd` is passed to the model as context so it can
  use absolute paths or `cd` as needed.
