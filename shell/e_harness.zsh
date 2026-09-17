# e_harness zsh integration.
#
# Source this from your ~/.zshrc (ideally AFTER other plugins like
# zsh-autosuggestions / zsh-syntax-highlighting):
#
#     source /path/to/e_harness/shell/e_harness.zsh
#
# It leaves your shell completely untouched - same prompt, same completion,
# same keybindings - and only adds one behavior: when you press Enter on a
# line that starts with '\ ' (backslash + space), that line is sent to the
# agent instead of the shell, and the answer is printed inline in a colored box.
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

# The actual client call. Kept as a function so history shows a clean line.
eh-ask() { "$EH_NODE" "$EH_ASK_SCRIPT" -- "$@" }

# Preserve whatever accept-line currently is (builtin or a plugin's wrapper)
# so we chain to it instead of clobbering it.
if [[ ${widgets[accept-line]} != user:_eh_accept_line ]]; then
  zle -A accept-line _eh_orig_accept_line 2>/dev/null || \
    zle -N _eh_orig_accept_line .accept-line
fi

_eh_accept_line() {
  # Trigger only on backslash followed by whitespace, so `\ls` / `\rm` (zsh
  # alias-bypass) keep working untouched.
  if [[ $BUFFER == '\'[[:space:]]* ]]; then
    local q=${BUFFER#'\'}
    q=${q##[[:space:]]}
    if [[ -n $q ]]; then
      BUFFER="eh-ask ${(qq)q}"
    fi
  fi
  zle _eh_orig_accept_line
}
zle -N accept-line _eh_accept_line
