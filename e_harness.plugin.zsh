# e_harness.plugin.zsh - entry point for zsh plugin managers.
#
# Every manager (oh-my-zsh, zinit, antidote, zplug, zgenom, sheldon, antigen)
# looks for a file named <repo>.plugin.zsh at the repo root and sources it, so
# this is all that is needed to make the repo loadable by any of them:
#
#     zinit light virati/e_harness
#     antidote bundle virati/e_harness
#     plugins=(... e_harness)          # oh-my-zsh, cloned into $ZSH_CUSTOM/plugins
#
# All it does is resolve its own directory and hand off to the real integration.

# Standard idiom for "the file currently being sourced", robust across managers
# that source this from an arbitrary cwd with an arbitrary $0.
0="${${ZERO:-${0:#$ZSH_ARGZERO}}:-${(%):-%N}}"
EH_PLUGIN_DIR="${0:A:h}"

# Nothing here makes sense in a non-interactive shell (scripts, `zsh -c`), and
# defining ZLE widgets there is an error.
[[ -o interactive ]] || return 0

if [[ ! -r "$EH_PLUGIN_DIR/shell/e_harness.zsh" ]]; then
  print -u2 "e_harness: plugin loaded from $EH_PLUGIN_DIR but shell/e_harness.zsh is missing"
  return 1
fi

source "$EH_PLUGIN_DIR/shell/e_harness.zsh"

# A plugin manager clones the repo but does not install its node dependency, so
# the first '\ ' would otherwise fail in a confusing way. This is the check.
eh-doctor() { "${EH_NODE:-node}" "$EH_PLUGIN_DIR/bin/eh.mjs" --doctor "$@" }
