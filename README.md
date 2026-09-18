# e_harness

A **shell-first** LLM harness. The inverse of Claude Code / pi: instead of
dropping you into a chat UI where the default is natural language and `!` escapes
to the shell, you **stay in your own shell** (bash or zsh) and everything runs as
a normal command — until a line starts with one of two triggers, which is sent to
the agent instead.

The agent never takes over the screen. It answers **inline, in a colored box**,
right where you are, so the whole transcript (including any commands the agent
ran) stays in your normal scrollback — selectable and auditable as if you typed
it.

```
~/projects/e_harness ❯ ls
bin  node_modules  package.json  README.md  shell  src
~/projects/e_harness ❯ \ what changed in this repo and is it safe to commit?
  ⟳ grep src/
╭─ ai ─────────────────────────────────────────────────────────╮
│ Only src/daemon.mjs changed. No secrets or generated files    │
│ are staged — safe to commit.                                  │
╰───────────────────────────────────────────────────────────────╯
~/projects/e_harness ❯
```

## The two triggers

| You type | Agent gets | Can it act? |
|---|---|---|
| `\ <question>` | read, grep, find, ls | **No.** It cannot run a command or touch a file. |
| `\! <request>` | the above **plus** bash, edit, write | Yes — but every single call stops and asks you `y/n` first. |

`\ ` is the one you want almost always: "what is this error", "what does this
script do", "what changed here". Because it is structurally read-only, a hostile
string inside a file it reads has nothing to reach for.

`\! ` is for when you actually want work done. Before every `bash`, `edit` or
`write` the agent proposes, the exact command — or the exact file path, byte
count and content preview — is printed in a box and nothing happens until you
answer:

```
~/repo ❯ \! drop the stray debug prints in src/
╭─ approve edit? ──────────────────────────────────────────────╮
│ path: /home/me/repo/src/daemon.mjs                            │
│ ---                                                           │
│ [1] -   console.log("HERE", buf);                             │
│     +                                                         │
╰───────────────────────────────────────────────────────────────╯
  run it? [y = yes, n = no, a = yes to everything in this turn]
```

`a` lasts until the end of that turn and no longer. A denial is reported to the
model as an error telling it to stop rather than route around you. The prompt is
read from `/dev/tty`, so it works regardless of what stdin is.

## Why this design

Earlier versions wrapped your input in a Node REPL. That broke everything that
makes a shell a shell: **tab-completion, `clear`, your prompt theme, Ctrl-R,
keybindings** — none of it worked, because you weren't actually in zsh.

So e_harness **gets out of the input path completely**. Your real shell runs
natively on your real TTY. The only addition is a single input hook (a zsh ZLE
`accept-line` widget, or a bash readline `bind`) that fires **just** on the two
triggers. Consequences:

- **Tab completion, `clear`, prompt, history, keybindings** — all 100% native,
  because nothing is intercepting them.
- **Your prompt is exactly your prompt.** The launcher runs *your* `$SHELL` and
  loads your real rc (bash: `~/.bashrc` via `--rcfile`; zsh: your `~/.zshrc` via
  a temp `ZDOTDIR` that restores `$ZDOTDIR`). The recommended install is one
  `source` line in your own config — byte-for-byte identical to normal.
- **`\ ` doesn't collide** with zsh's alias-bypass idiom: `\ls` and `\rm` still
  run the real command (alias expansion suppressed) exactly as before. Only
  backslash-*space* and backslash-*bang*-space are triggers.

## One terminal, one agent

Every terminal gets its own **conversation**, its own **autofill history** and
its own **log**, keyed by tty + shell pid (`EH_TERM_ID`, e.g. `pts-3-48211`).
Nothing crosses between terminals: a question in your work repo never lands in
the context of a question you ask somewhere else, a `Ctrl-C` here never aborts a
turn there, and two terminals can be mid-turn at the same time.

```
~/.local/share/e_harness/terminals/<tty>-<pid>/
    events.jsonl      every event, appended the instant it happens
    ask.session.jsonl  conversation state for '\ '   (resumed across restarts)
    act.session.jsonl  conversation state for '\! '  (resumed across restarts)
```

`events.jsonl` is the record, and it is written in **real time**: each streamed
text delta, each tool call and its output, each approval request and your answer
is `writeSync`'d to an append-only fd as it occurs. Nothing waits for the turn to
finish, so a daemon killed mid-answer still leaves everything up to that instant
on disk. `eh --log` prints this terminal's path; `tail -f` it to watch a turn
live.

(The `*.session.jsonl` files are pi's own state, used to resume the conversation.
pi persists at message granularity and defers its first write, so it is not a
substitute for the event log — which is why both exist.)

## Architecture

```
your real zsh ──(ZLE widget on "\ " / "\! ")──> ask.mjs ──unix socket──> daemon
     │                        │                    │                       │
 native prompt/completion/    │            prints boxes, reads      per-terminal
 clear/… everything else      │            y/n from /dev/tty        pi sessions
 runs in zsh                  │                                            │
                              └── Ctrl-X Ctrl-G ──────────────────> stateless
                                  (insert a command, never run it)   fast model
```

- **`shell/e_harness.zsh`** — the zsh ZLE widget. Chains to the previous
  `accept-line` (so zsh-autosuggestions / syntax-highlighting keep working) and
  only rewrites the buffer when it starts with a trigger.
- **`shell/e_harness.bash`** — the bash equivalent: an `_eh_enter` readline
  function (bound via a macro on Enter).
- **`src/daemon.mjs`** — per-terminal pi sessions behind a unix socket. Never
  touches your terminal.
- **`src/agent.mjs`** — pi SDK glue: the read-only session, the acting session,
  and the approval gate.
- **`src/store.mjs`** — the real-time per-terminal event log.
- **`src/ask.mjs`** — the client the widget calls; streams events, renders boxes,
  asks you to approve. Auto-starts the daemon if it isn't running.
- **`src/box.mjs`** — the colored-box renderer.
- **`bin/eh.mjs`** — launcher.

### How the gate is built

pi's `createAgentSession()` has no permission callback, so the gate is not a
setting — it is constructed. `bash`, `edit` and `write` are registered as
`customTools` whose names shadow the built-ins (a custom tool of the same name
wins in pi's tool registry) and whose `execute()` awaits a verdict from your
terminal before delegating to the real tool. A denial throws, which pi's agent
loop turns into an `isError` tool result the model reads. They are marked
`executionMode: "sequential"` so two tools can never race for the one terminal
you answer at.

## Install / run

Requires Node ≥ 22.

```bash
cd projects/e_harness
npm link @earendil-works/pi-coding-agent   # reuse the globally-installed pi
```

**Option A — as a zsh plugin (recommended for zsh).** The repo root has an
`e_harness.plugin.zsh`, which is the file every manager looks for:

```zsh
zinit light virati/e_harness                  # zinit
antidote bundle virati/e_harness              # antidote
zgenom load virati/e_harness                  # zgenom
antigen bundle virati/e_harness               # antigen
```
```zsh
# oh-my-zsh: clone into $ZSH_CUSTOM/plugins, then add it to plugins=()
git clone https://github.com/virati/e_harness "${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/plugins/e_harness"
plugins=(... e_harness)
```
```toml
# sheldon (~/.config/sheldon/plugins.toml)
[plugins.e_harness]
github = "virati/e_harness"
```

Load it **after** zsh-autosuggestions and zsh-syntax-highlighting, so the
`accept-line` chain ends up in the right order.

A plugin manager clones the repo but does **not** install its node dependency,
so do that once after the first load and check it:

```zsh
cd <the cloned dir>; npm link @earendil-works/pi-coding-agent   # or: npm install
eh-doctor        # node, SDK, daemon, and whether this shell has the integration
```

`eh-doctor` is defined by the plugin and prints the exact fix for whatever is
missing.

**Option B — one line in your own rc (guaranteed-identical shell):**

```bash
# ~/.bashrc  (bash) — source AFTER fzf/atuin/ble.sh; see the caveat below
source /abs/path/to/projects/e_harness/shell/e_harness.bash
```
```zsh
# ~/.zshrc   (zsh, add after other plugins)
source /abs/path/to/projects/e_harness/shell/e_harness.zsh
```

Now both triggers work in every shell you open. The daemon auto-starts on first
use.

**Option C — launch a ready-made subshell (no config edit):**

```bash
node bin/eh.mjs        # or ./bin/eh.mjs, or `npm start`
```

Drops you into your real `$SHELL` with the integration loaded and your exact
prompt; `exit` to leave.

| Command | |
|---|---|
| `node bin/eh.mjs --stop` | stop the background agent |
| `node bin/eh.mjs --log` | path to this terminal's event log |
| `node bin/eh.mjs --doctor` | check node, the pi SDK, the daemon and this shell |

Model/API keys come from your pi config (`~/.pi/agent/auth.json`, env vars, …).

## Usage

| You type | What happens |
|---|---|
| `git status` | runs in your real shell (completion, prompt, native) |
| `\ls` | native alias-bypass — **not** the AI |
| `\ explain this error` | read-only agent; answer in a colored box |
| `\! fix the failing test` | acting agent; each bash/edit/write asks you first |
| *description* + **Ctrl-X Ctrl-G** | rewrites the line into a shell command, **not run** |
| Ctrl-C during a turn | aborts this terminal's turn only |

### Describe-to-command (Ctrl-X Ctrl-G)

Type a plain-English description on the command line and press **Ctrl-X Ctrl-G**.
It is translated into a single shell command and dropped into your editor
**without pressing Enter** — review or edit it, then run it yourself.

```
❯ list every png changed in the last day        # type this, press Ctrl-X Ctrl-G
❯ find . -name '*.png' -type f -mtime -1         # line is replaced; not executed
```

Generation uses a separate tool-less, stateless model call (Haiku by default —
override with `EH_FAST_MODEL`), so it is fast and never runs anything on its own.
Your original description is pushed into shell history, so **Up** gets it back if
you don't like the result.

## Security notes

- **The socket is the front door.** It is an unauthenticated channel to an agent
  that acts as you, so it lives in `$XDG_RUNTIME_DIR` (already `0700`) or, if
  that is unset, in a `0700` directory e_harness creates under the tmpdir — and
  the socket itself is `chmod 0600`. e_harness refuses to use a directory that
  isn't private and owned by you.
- **Read-only by default.** `\ ` is the ergonomic path and cannot act at all.
  Reaching the tools that can act takes a different, deliberate prefix and then a
  keystroke per call.
- **Approval is per call, not per turn**, and `a` ("yes to everything") is scoped
  to the turn that granted it. If the client disconnects, or you don't answer
  within `EH_APPROVAL_TIMEOUT_MS` (default 120s), the call is denied.
- **Model output is sanitized** before it reaches your terminal: all escape and
  control sequences are stripped, so nothing in an answer can move your cursor or
  leak a color into your next prompt.

## Notes & limitations

- The agent's file tools resolve relative paths against the session root (the
  directory the terminal's session was created in), not your live `cwd`. Your cwd
  is passed as context each turn and the agent is told to use absolute paths —
  and in `\! ` mode the approval box shows the resolved path, so a write aimed at
  the wrong directory is visible before it happens.
- **bash + Enter:** the bash integration remaps `\C-m`. fzf, atuin and ble.sh
  also bind `\C-m`; whichever is sourced last wins, so source this one after
  them. The zsh integration has no such problem — it chains to whatever
  `accept-line` already was.
- The daemon has no idle timeout: it stays resident with your credentials and one
  session per terminal it has seen until `--stop`. Long-lived terminals grow
  their conversation until pi compacts it.
- `events.jsonl` grows without bound and is never rotated. It contains your
  prompts, the agent's answers and the output of the commands it ran — treat it
  like shell history.
