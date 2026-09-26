# e_harness async + floating-box renderer (zsh only).
#
# Sourced by shell/e_harness.zsh. Two jobs:
#
#   1. Make '\ ' non-blocking. The query runs in a detached background job and
#      you get your prompt back immediately. zsh watches the job's pipe with
#      `zle -F`, so the answer is picked up whenever the line editor is next
#      active - no polling, no subshell blocking your terminal.
#
#   2. Draw the answer in a box that does not disturb what you are typing.
#
# '\! ' stays synchronous ON PURPOSE: it has to ask you y/n before every command
# it runs, and an approval prompt appearing while you are mid-way through typing
# something else is how people approve things they did not read.
#
# EH_FLOAT picks the renderer:
#   margin  (default outside tmux) top-right overlay, drawn with absolute cursor
#           positioning between a save/restore, so the line editor never sees it
#   tmux    (default inside tmux)  a real right-hand pane; focus stays with you
#   above   print above the prompt and redraw the prompt; no artifacts ever
#   off     no box; answers go to scrollback as before
# EH_ASYNC=0 turns async off entirely and restores the old blocking behaviour.

emulate -L zsh
autoload -Uz add-zsh-hook

typeset -gA _EH_ASYNC_JOBS
typeset -ga _EH_FLOAT_LINES
typeset -g  _EH_FLOAT_W=0
typeset -g  _EH_ASYNC_DIR=""
typeset -g  _EH_TMUX_PANE=""

: ${EH_ASYNC:=1}
: ${EH_FLOAT:=auto}

_eh_float_mode() {
  local m=$EH_FLOAT
  if [[ $m == auto ]]; then
    [[ -n $TMUX ]] && m=tmux || m=margin
  fi
  print -r -- $m
}

# Box width: half the terminal, clamped to something readable.
_eh_float_width() {
  local w=$(( ${COLUMNS:-80} / 2 ))
  (( w > 56 )) && w=56
  (( w < 30 )) && w=30
  (( w > ${COLUMNS:-80} - 2 )) && w=$(( ${COLUMNS:-80} - 2 ))
  print -r -- $w
}

# --- the margin renderer ----------------------------------------------------
# Draws each line at an absolute (row, col) between ESC7 / ESC8 (save/restore
# cursor). ZLE's idea of where the cursor is never changes, so typing, history
# and completion are untouched while the box is on screen.

_eh_float_paint() {
  local -a lines=("$@")
  (( ${#lines} )) || return 0
  local w=$_EH_FLOAT_W
  (( ${COLUMNS:-80} >= w + 2 )) || return 0   # too narrow to place it
  local col=$(( ${COLUMNS:-80} - w + 1 ))
  local ESC=$'\e' buf i
  buf="${ESC}7"
  for (( i = 1; i <= ${#lines}; i++ )); do
    buf+="${ESC}[${i};${col}H${lines[i]}"
  done
  buf+="${ESC}8"
  print -rn -- "$buf"
}

_eh_float_clear() {
  (( ${#_EH_FLOAT_LINES} )) || return 0
  local -a blanks
  local i pad="${(l:$_EH_FLOAT_W:: :)}"
  for (( i = 1; i <= ${#_EH_FLOAT_LINES}; i++ )); do blanks+=("$pad"); done
  _eh_float_paint "${blanks[@]}"
  _EH_FLOAT_LINES=()
  return 0
}

# Redrawn before every prompt so the box survives scrolling. It is deliberately
# not redrawn while a command is running - output would race with it.
_eh_float_precmd() { (( ${#_EH_FLOAT_LINES} )) && _eh_float_paint "${_EH_FLOAT_LINES[@]}" }
add-zsh-hook precmd _eh_float_precmd

# --- the tmux renderer ------------------------------------------------------
# A real pane, created with -d so focus stays where you are. Reused across
# queries: the same pane is respawned rather than stacking up new ones.

_eh_float_tmux() {
  local text=$1 w=$(_eh_float_width)
  local cmd="printf '%s\n' ${(q)text}; read -r _"
  if [[ -n $_EH_TMUX_PANE ]] && tmux list-panes -F '#{pane_id}' 2>/dev/null | grep -qx -- "$_EH_TMUX_PANE"; then
    tmux respawn-pane -k -t "$_EH_TMUX_PANE" "$SHELL" -c "$cmd" 2>/dev/null && return 0
  fi
  _EH_TMUX_PANE=$(tmux split-window -h -d -l $w -P -F '#{pane_id}' "$SHELL" -c "$cmd" 2>/dev/null)
}

# --- showing an answer ------------------------------------------------------

_eh_float_show() {
  local text=$1
  local -a lines=( ${(f)text} )
  case $(_eh_float_mode) in
    off)    print -r -- "$text" ;;
    tmux)   _eh_float_tmux "$text" ;;
    above)  _eh_float_clear
            print -r -- "$text"
            zle && zle reset-prompt ;;
    *)      _eh_float_clear
            _EH_FLOAT_LINES=( "${lines[@]}" )
            _eh_float_paint "${lines[@]}" ;;
  esac
  return 0
}

# A small self-drawn box for the "working on it" state, so you can see the
# query was accepted without waiting for the model.
_eh_pending_box() {
  local w=$_EH_FLOAT_W q=$1
  local C=$'\e[2m' R=$'\e[0m'
  local inner=$(( w - 4 ))
  local title=" ai … "
  local dash="${(l:$(( inner - ${#title} + 1 ))::─:)}"
  (( ${#q} > inner )) && q="${q[1,$(( inner - 1 ))]}…"
  print -r -- "${C}╭─${title}${dash}╮${R}"
  print -r -- "${C}│ ${(r:$inner:: :)q} │${R}"
  print -r -- "${C}╰${(l:$(( inner + 2 ))::─:)}╯${R}"
}

# --- the async job ----------------------------------------------------------

_eh_async_dir() {
  if [[ -z $_EH_ASYNC_DIR || ! -d $_EH_ASYNC_DIR ]]; then
    _EH_ASYNC_DIR=${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/e_harness-async-$$
    command mkdir -p -m 700 $_EH_ASYNC_DIR
  fi
  print -r -- $_EH_ASYNC_DIR
}

_eh_async_start() {
  local mode=$1 q=$2
  local dir=$(_eh_async_dir)
  local id=${EPOCHSECONDS:-0}-$RANDOM
  local out=$dir/$id.out fifo=$dir/$id.fifo
  command mkfifo -m 600 $fifo 2>/dev/null || return 1

  _EH_FLOAT_W=$(_eh_float_width)
  _eh_float_clear
  _EH_FLOAT_LINES=( ${(f)"$(_eh_pending_box "$q")"} )
  _eh_float_paint "${_EH_FLOAT_LINES[@]}"

  # &! detaches: no job-control message, and it outlives this widget.
  ( "$EH_NODE" "$EH_ASK_SCRIPT" --mode $mode --quiet --width $_EH_FLOAT_W -- "$q" >| $out 2>&1
    print -n x >| $fifo ) &!

  local fd
  exec {fd}<>$fifo
  _EH_ASYNC_JOBS[$fd]="$out $fifo"
  zle -F $fd _eh_async_done
}

_eh_async_done() {
  local fd=$1
  local meta=${_EH_ASYNC_JOBS[$fd]}
  zle -F $fd                       # unregister first, whatever happens next
  exec {fd}>&-
  unset "_EH_ASYNC_JOBS[$fd]"
  local out=${meta%% *} fifo=${meta##* }
  command rm -f $fifo
  local text
  [[ -r $out ]] && text=$(<$out)
  command rm -f $out
  [[ -z $text ]] && text="(no answer)"
  _EH_LAST_ANSWER=$text
  _eh_float_show "$text"
}

# Reprint the last answer inline, in the scrollback, where you can select it.
eh-last() {
  [[ -n $_EH_LAST_ANSWER ]] && print -r -- "$_EH_LAST_ANSWER" || print -u2 "e_harness: no answer yet"
}

_eh_dismiss() { _eh_float_clear; zle -R }
zle -N eh-dismiss _eh_dismiss
bindkey '^X^D' eh-dismiss

_eh_async_cleanup() {
  [[ -n $_EH_ASYNC_DIR && -d $_EH_ASYNC_DIR ]] && command rm -rf -- $_EH_ASYNC_DIR
}
add-zsh-hook zshexit _eh_async_cleanup
