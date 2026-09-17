# e_harness bash integration.
#
# Source this from your ~/.bashrc (ideally near the end):
#
#     source /path/to/e_harness/shell/e_harness.bash
#
# It leaves your shell completely untouched - same prompt, same completion,
# same keybindings - and only adds one behavior: when you press Enter on a
# line that starts with '\ ' (backslash + space), that line is sent to the
# agent instead of the shell, and the answer prints inline in a colored box.
#
# The trigger is backslash-SPACE, not a bare backslash, so it does NOT collide
# with bash's alias-bypass idiom (`\ls`, `\rm` still run the real command).

# Only meaningful in an interactive shell with readline.
if [[ $- == *i* ]]; then
  : "${EH_NODE:=node}"
  _eh_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  export EH_NODE
  export EH_ASK_SCRIPT="${_eh_dir%/shell}/src/ask.mjs"
  unset _eh_dir

  # The client call, kept as a function so history stays clean.
  eh-ask() { "$EH_NODE" "$EH_ASK_SCRIPT" -- "$@"; }

  # Runs on Enter (via the macro below). If the current line starts with '\ ',
  # rewrite it into an eh-ask call; otherwise leave it untouched.
  _eh_enter() {
    if [[ $READLINE_LINE == '\ '* ]]; then
      local q=${READLINE_LINE#'\ '}
      q=${q#"${q%%[![:space:]]*}"} # trim leading whitespace
      if [[ -n $q ]]; then
        printf -v READLINE_LINE 'eh-ask %q' "$q"
        READLINE_POINT=${#READLINE_LINE}
      fi
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
    [[ $desc == '\'* ]] && desc=${desc#'\'} # tolerate a leading backslash
    desc=${desc#"${desc%%[![:space:]]*}"}  # trim leading whitespace
    [[ -z $desc ]] && return
    local cmd
    cmd=$("$EH_NODE" "$EH_ASK_SCRIPT" --mode command -- "$desc" 2>/dev/null)
    if [[ -n $cmd ]]; then
      READLINE_LINE=$cmd
      READLINE_POINT=${#READLINE_LINE}
    fi
  }
  bind -x '"\C-x\C-g": _eh_gencmd' 2>/dev/null
fi
