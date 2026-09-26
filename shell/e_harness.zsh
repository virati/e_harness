# e_harness zsh integration.
#
# Source this from your ~/.zshrc (ideally AFTER other plugins like
# zsh-autosuggestions / zsh-syntax-highlighting):
#
#     source /path/to/e_harness/shell/e_harness.zsh
#
# It leaves your shell completely untouched - same prompt, same completion,
# same keybindings - and only adds two triggers on Enter:
#
#     \ <question>    ask the READ-ONLY agent (read/grep/find/ls only)
#     \! <request>    ask the ACTING agent (can run commands and change files,
#                     but asks you y/n before each one)
#
# The trigger is backslash-SPACE, not a bare backslash, specifically so it does
# NOT collide with zsh's alias-bypass idiom (e.g. `\ls`, `\rm` still run the
# real command with alias expansion suppressed, exactly as before).

# Resolve paths relative to this file so it works wherever it lives.
() {
  local self=${${(%):-%x}:A}
  local root=${self:h:h}
  : ${EH_NODE:=node}
  export EH_NODE
  export EH_ASK_SCRIPT="$root/src/ask.mjs"
}

# Identity of THIS terminal: its tty plus this shell's pid. Everything the
# agent does here - conversation, autofill history, the event log - is filed
# under this id and is invisible to every other terminal.
#
# Recomputed on every source, never inherited: a terminal launched from another
# shell must not adopt its parent's id. A subshell does not re-source this file,
# so it keeps the exported value - which is right, it IS the same terminal.
export EH_TERM_ID="${${${TTY#/dev/}//\//-}:-notty}-$$"

# The client calls. Kept as functions so history shows a clean line, and so you
# can see at a glance which mode a past line used.
eh-ask() { "$EH_NODE" "$EH_ASK_SCRIPT" --mode ask -- "$@" }
eh-do()  { "$EH_NODE" "$EH_ASK_SCRIPT" --mode act -- "$@" }

# Async '\ ' and the floating answer box. Optional: without it everything below
# still works, just blocking and inline.
if [[ -r ${${(%):-%x}:A:h}/e_harness-async.zsh ]]; then
  source ${${(%):-%x}:A:h}/e_harness-async.zsh
fi

# Preserve whatever accept-line currently is (builtin or a plugin's wrapper)
# so we chain to it instead of clobbering it.
if [[ ${widgets[accept-line]} != user:_eh_accept_line ]]; then
  zle -A accept-line _eh_orig_accept_line 2>/dev/null || \
    zle -N _eh_orig_accept_line .accept-line
fi

_eh_accept_line() {
  # extendedglob is what makes `[[:space:]]#` mean "zero or more spaces";
  # localoptions confines it to this function so your own options are untouched.
  setopt localoptions extendedglob
  # Trigger only on backslash followed by whitespace, so `\ls` / `\rm` (zsh
  # alias-bypass) keep working untouched. `\!` is checked first because `\ `
  # would otherwise not match it anyway - they are distinct prefixes.
  local fn mode q
  if [[ $BUFFER == '\!'[[:space:]]* ]]; then
    fn=eh-do; mode=act; q=${BUFFER#'\!'}
  elif [[ $BUFFER == '\'[[:space:]]* ]]; then
    fn=eh-ask; mode=ask; q=${BUFFER#'\'}
  fi
  if [[ -n $fn ]]; then
    q=${${q##[[:space:]]#}%%[[:space:]]#}
    if [[ -n $q ]]; then
      # '\ ' goes to the background and the prompt comes straight back. '\! '
      # does not: it has to ask y/n before each command it runs, and those
      # questions have to arrive while you are still thinking about the request.
      if [[ $mode == ask && $EH_ASYNC != 0 ]] && (( $+functions[_eh_async_start] )); then
        print -rs -- "$BUFFER"         # -r: without it print eats the leading backslash
        _eh_async_start ask "$q"
        BUFFER=""
      else
        # (qq) single-quotes: single quotes also suppress zsh history expansion,
        # so a '!' anywhere in the question stays literal.
        BUFFER="$fn ${(qq)q}"
      fi
    fi
  fi
  zle _eh_orig_accept_line
}
zle -N accept-line _eh_accept_line

# Ctrl-X Ctrl-G: translate the current line (a plain-English description) into a
# shell command and put it in the editor - WITHOUT running it. Review/edit, then
# press Enter yourself.
_eh_gencmd() {
  setopt localoptions extendedglob
  local desc=$BUFFER
  desc=${desc#'\!'}                          # tolerate either trigger prefix
  desc=${desc#'\'}
  desc=${${desc##[[:space:]]#}%%[[:space:]]#}
  [[ -z ${desc//[[:space:]]/} ]] && return
  local cmd err
  err=$(mktemp)
  cmd=$("$EH_NODE" "$EH_ASK_SCRIPT" --mode command -- "$desc" 2>"$err")
  if [[ -n $cmd ]]; then
    # Keep the description recallable: it goes into history, so Up gets it back.
    print -rs -- "$desc"
    BUFFER=$cmd
    CURSOR=${#BUFFER}
  else
    zle -M "e_harness: $(<"$err")"
  fi
  command rm -f "$err"
  zle redisplay
}
zle -N eh-gencmd _eh_gencmd
bindkey '^X^G' eh-gencmd
