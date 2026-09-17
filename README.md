# e_harness

A **shell-first** LLM harness. The inverse of Claude Code / pi: instead of
dropping you into a chat UI where the default is natural language and `!` escapes
to the shell, you **stay in your own shell** (bash or zsh) and everything runs as
a normal command — until a line starts with `\ ` (backslash + space), which is
sent to the agent instead.

The agent never takes over the screen. It answers **inline, in a colored box**,
right where you are, so the whole transcript (including any commands the agent
ran) stays in your normal scrollback — selectable and auditable as if you typed
it.

```
~/projects/e_harness ❯ ls
bin  node_modules  package.json  README.md  shell  src
~/projects/e_harness ❯ \ what changed in this repo and is it safe to commit?
  ⟳ git diff --stat
    src/daemon.mjs | 12 +++++---
╭─ ai ─────────────────────────────────────────────────────────╮
│ Only src/daemon.mjs changed. No secrets or generated files    │
│ are staged — safe to commit.                                  │
╰───────────────────────────────────────────────────────────────╯
~/projects/e_harness ❯
```

## Why this design

Earlier versions wrapped your input in a Node REPL. That broke everything that
makes a shell a shell: **tab-completion, `clear`, your prompt theme, Ctrl-R,
keybindings** — none of it worked, because you weren't actually in zsh.

So e_harness **gets out of the input path completely**. Your real shell runs
natively on your real TTY. The only addition is a single input hook (a zsh ZLE
`accept-line` widget, or a bash readline `bind`) that fires **just** on
`\ `-prefixed lines. Consequences:

- **Tab completion, `clear`, prompt, history, keybindings** — all 100% native,
  because nothing is intercepting them.
- **Your prompt is exactly your prompt.** The launcher runs *your* `$SHELL` and
  loads your real rc (bash: `~/.bashrc` via `--rcfile`; zsh: your `~/.zshrc` via
  a temp `ZDOTDIR` that restores `$ZDOTDIR`). The recommended install is one
  `source` line in your own config — byte-for-byte identical to normal.
- **`\ ` doesn't collide** with zsh's alias-bypass idiom: `\ls` and `\rm` still
  run the real command (alias expansion suppressed) exactly as before. Only
  backslash-*space* is the AI trigger.

## Architecture

```
your real zsh ──(ZLE widget on "\ ")──> eh-ask (client) ──unix socket──> daemon
     │                                        │                             │
 native prompt/completion/clear/…      prints colored box            one long-lived
 everything else runs in zsh           to your terminal              pi agent session
```

- **`shell/e_harness.zsh`** — the zsh ZLE widget. Chains to the previous
  `accept-line` (so zsh-autosuggestions / syntax-highlighting keep working) and
  only rewrites the buffer when it starts with `\ `.
- **`shell/e_harness.bash`** — the bash equivalent: an `_eh_enter` readline
  function (bound via a macro on Enter) that rewrites the line only when it
  starts with `\ `.
- **`src/daemon.mjs`** — one persistent pi agent session behind a unix socket,
  so conversation state persists across queries. Never touches your terminal.
- **`src/ask.mjs`** — tiny client the widget calls; streams events and renders
  the box. Auto-starts the daemon if it isn't running.
- **`src/agent.mjs` / `src/box.mjs`** — pi SDK glue and the colored-box renderer.
- **`bin/eh.mjs`** — launcher: ensures the daemon is up and execs your real zsh
  with the integration loaded.

## Install / run

Requires Node ≥ 22 and zsh.

```bash
cd projects/e_harness
npm link @earendil-works/pi-coding-agent   # reuse the globally-installed pi
```

**Option A — one line in your own rc (guaranteed-identical shell):**

```bash
# ~/.bashrc  (bash)
source /abs/path/to/projects/e_harness/shell/e_harness.bash
```
```zsh
# ~/.zshrc   (zsh, add after other plugins)
source /abs/path/to/projects/e_harness/shell/e_harness.zsh
```

Now `\ <prompt>` works in every shell you open. The daemon auto-starts on first use.

**Option B — launch a ready-made subshell (no config edit):**

```bash
node bin/eh.mjs        # or ./bin/eh.mjs, or `npm start`
```

Drops you into your real `$SHELL` (bash or zsh) with the integration loaded and
your exact prompt; `exit` to leave.

Stop the background agent: `node bin/eh.mjs --stop` (or `npm run stop`).

Model/API keys come from your pi config (`~/.pi/agent/auth.json`, env vars, …).

## Usage

| You type                                  | What happens                                        |
|-------------------------------------------|-----------------------------------------------------|
| `git status`                              | runs in your real shell (completion, prompt, native) |
| `\ls`                                     | native alias-bypass — **not** the AI                |
| `\ explain this error`                    | sent to the agent; answer in a colored box          |
| *description* + **Ctrl-X Ctrl-G**         | rewrites the line into a shell command, **not run** |
| Ctrl-C during a `\ ` turn                 | aborts the agent turn                               |
| `exit`                                    | leaves the `eh` subshell (Option B)                 |

### Describe-to-command (Ctrl-X Ctrl-G)

Type a plain-English description on the command line and press **Ctrl-X Ctrl-G**.
It is translated into a single shell command and dropped into your editor
**without pressing Enter** — review or edit it, then run it yourself.

```
❯ list every png changed in the last day        # type this, press Ctrl-X Ctrl-G
❯ find . -name '*.png' -type f -mtime -1         # line is replaced; not executed
```

Generation uses a separate tool-less, stateless model call, so it is fast and
never runs anything on its own.

## Notes & limitations

- The agent's own `bash` tool (when it runs commands for you) executes in the
  daemon with a fixed working directory; your live `cwd` is passed as context so
  it uses absolute paths / `cd` as needed.
- Only interactive `~/.zshenv` and `~/.zshrc` are loaded by the `eh` launcher
  (non-login). Option A is unaffected — it's your real shell.
