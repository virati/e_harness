# e_harness bash integration.
#
# Source this from your ~/.bashrc (ideally near the end):
#
#     source /path/to/e_harness/shell/e_harness.bash
#
# It leaves your shell completely untouched - same prompt, same completion,
# same keybindings - and only adds two triggers on Enter:
#
#     \ <question>    ask the READ-ONLY agent (read/grep/find/ls only)
#     \! <request>    ask the ACTING agent (can run commands and change files,
#                     but asks you y/n before each one)
#
# The trigger is backslash-SPACE, not a bare backslash, so it does NOT collide
# with bash's alias-bypass idiom (`\ls`, `\rm` still run the real command).
#
# NOTE: this remaps Enter (\C-m) to a macro. If you also load fzf, atuin or
# ble.sh, whichever is sourced LAST wins - source this one after them.

# Only meaningful in an interactive shell with readline.
if [[ $- == *i* ]]; then
  : "${EH_NODE:=node}"
  _eh_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  export EH_NODE
  export EH_ASK_SCRIPT="${_eh_dir%/shell}/src/ask.mjs"
  unset _eh_dir

  # Identity of THIS terminal: its tty plus this shell's pid. Conversation,
  # autofill history and the event log are all filed under it and are invisible
  # to every other terminal. Recomputed on every source, never inherited.
  _eh_tty="$(tty 2>/dev/null)"
  _eh_tty="${_eh_tty#/dev/}"
  _eh_tty="${_eh_tty//\//-}"
  [[ -z $_eh_tty || $_eh_tty == *"not a tty"* ]] && _eh_tty="notty"
  export EH_TERM_ID="${_eh_tty}-$$"
  unset _eh_tty

  # The client calls, kept as functions so history stays clean and shows which
  # mode a past line used.
  eh-ask() { "$EH_NODE" "$EH_ASK_SCRIPT" --mode ask -- "$@"; }
  eh-do() { "$EH_NODE" "$EH_ASK_SCRIPT" --mode act -- "$@"; }

  # Runs on Enter (via the macro below). Rewrites the line only when it starts
  # with one of the triggers; otherwise leaves it completely untouched.
  _eh_enter() {
    local fn q
    if [[ $READLINE_LINE == '\! '* ]]; then
      fn=eh-do; q=${READLINE_LINE#'\! '}
    elif [[ $READLINE_LINE == '\ '* ]]; then
      fn=eh-ask; q=${READLINE_LINE#'\ '}
    else
      return
    fi
    q=${q#"${q%%[![:space:]]*}"} # trim leading whitespace
    if [[ -n $q ]]; then
      # %q escapes '!' as '\!', which also protects it from history expansion.
      printf -v READLINE_LINE '%s %q' "$fn" "$q"
      READLINE_POINT=${#READLINE_LINE}
    fi
  }

  # Bind our function to a private key sequence, then remap Enter (\C-m) to a
  # macro that: runs the function (may rewrite the line), then accepts the line
  # with \C-j (newline == accept-line). \C-j is not remapped, so no recursion.
  bind -x '"\C-x\C-z": _eh_enter' 2>/dev/null
  bind '"\C-m": "\C-x\C-z\C-j"' 2>/dev/null

  # Ctrl-X Ctrl-G: translate the current line (a plain-English description) into
  # a shell command and put it in the editor - WITHOUT running it. Review/edit,
  # then press Enter yourself.
  _eh_gencmd() {
    local desc=$READLINE_LINE
    desc=${desc#'\!'}                        # tolerate either trigger prefix
    desc=${desc#'\'}
    desc=${desc#"${desc%%[![:space:]]*}"}
    [[ -z $desc ]] && return
    local cmd err
    err=$(mktemp)
    cmd=$("$EH_NODE" "$EH_ASK_SCRIPT" --mode command -- "$desc" 2>"$err")
    if [[ -n $cmd ]]; then
      history -s -- "$desc"   # keep the description recallable with Up
      READLINE_LINE=$cmd
      READLINE_POINT=${#READLINE_LINE}
    else
      printf '\ne_harness: %s\n' "$(<"$err")" >&2
    fi
    command rm -f "$err"
  }
  bind -x '"\C-x\C-g": _eh_gencmd' 2>/dev/null
fi
