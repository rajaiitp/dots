# Zsh interactive configuration. Plugin declarations live in ~/.zimrc.

# GUI-specific mux sockets are ephemeral. The launchd-managed persistent mux is
# the canonical target for CLI commands from restored terminal sessions.
if [[ ${WEZTERM_UNIX_SOCKET:-} == */gui-sock-* ]]; then
  unset WEZTERM_UNIX_SOCKET
fi

# SSH agent (reuse a live agent; discard stale inherited sockets).
if [[ -o interactive && -t 0 ]]; then
  if [[ -n ${SSH_AUTH_SOCK:-} ]] && ! ssh-add -l >/dev/null 2>&1; then
    unset SSH_AUTH_SOCK SSH_AGENT_PID
  fi
  if [[ -z ${SSH_AUTH_SOCK:-} ]]; then
    eval "$(ssh-agent -s)" >/dev/null 2>&1
  fi
  if ! ssh-add -l >/dev/null 2>&1; then
    ssh-add ~/.ssh/id_ed25519 >/dev/null 2>&1
    ssh-add ~/.ssh/id_rsa >/dev/null 2>&1
  fi
fi

# Prompt: status, abbreviated directory, and Git branch.
short_pwd() {
  local path="$PWD"
  local rendered
  local relative
  local -a components
  local index

  if [[ "$path" == "$HOME" ]]; then
    print -n -- "~"
    return
  fi
  if [[ "$path" == "/" ]]; then
    print -n -- "/"
    return
  fi

  if [[ "$path" == "$HOME/"* ]]; then
    relative="${path#$HOME/}"
    rendered="~"
  else
    relative="${path#/}"
    rendered=""
  fi

  components=("${(@s:/:)relative}")
  for (( index = 1; index < ${#components[@]}; index++ )); do
    rendered+="/${components[index][1]}"
  done
  rendered+="/${components[-1]}"
  print -n -- "$rendered"
}

git_prompt_info() {
  local branch
  branch=$(command git branch --show-current 2>/dev/null) || return
  [[ -n $branch ]] && print -n -- " %F{yellow}($branch)%f"
}
setopt prompt_subst
PROMPT='%(?..%F{red}[%?] %f)%F{cyan}$(short_pwd)%f$(git_prompt_info) '

# Homebrew (Linux).
if [[ -x /home/linuxbrew/.linuxbrew/bin/brew ]]; then
  eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)"
fi

export EDITOR=nvim
export FZF_DEFAULT_OPTS='--layout=reverse'

# Let Pi's tuiMode setting control inline versus alternate-screen mode.
pi() {
  command pi "$@"
}
export BLINKA_FT232H=1
path=(
  "$HOME/go/bin"
  "$HOME/.bun/bin"
  "$HOME/.local/bin"
  "$HOME/.npm-global/bin"
  "$HOME/bin"
  $path
)
typeset -U path PATH

[[ -r "$HOME/.config/zsh/config.zsh" ]] && source "$HOME/.config/zsh/config.zsh"

if [[ -o interactive && -t 0 ]] && (( $+commands[fzf] )); then
  source <(fzf --zsh)
fi

HISTSIZE=10000
SAVEHIST=10000
HISTFILE="${ZDOTDIR:-$HOME}/.zsh_history"

# Herdr app-tab commands are passed through a pane's environment.
if [[ -n ${HERDR_APP_TAB_COMMAND:-} ]]; then
  herdr_app_tab_command=$HERDR_APP_TAB_COMMAND
  unset HERDR_APP_TAB_COMMAND
  eval "$herdr_app_tab_command"
fi

# Zimfw initializes Zsh completion. Load it before SDKMAN so SDKMAN reuses the
# existing completion system instead of calling compinit a second time.
# Guard against re-sourcing ~/.zshrc: zim's completion module warns (and calls
# compinit twice) if completion was already initialized in this shell. Use
# `exec zsh` to fully reload; this guard keeps `source ~/.zshrc` quiet too.
ZIM_HOME=${ZIM_HOME:-${ZDOTDIR:-$HOME}/.zim}
if [[ -z ${_zim_initialized:-} && -r ${ZIM_HOME}/zimfw.zsh ]]; then
  if [[ ! -r ${ZIM_HOME}/init.zsh || ${ZDOTDIR:-$HOME}/.zimrc -nt ${ZIM_HOME}/init.zsh ]]; then
    source "${ZIM_HOME}/zimfw.zsh" init -q
  fi
  [[ -r ${ZIM_HOME}/init.zsh ]] && source "${ZIM_HOME}/init.zsh" && typeset -g _zim_initialized=1
fi

export SDKMAN_DIR="$HOME/.sdkman"
[[ -s "$HOME/.sdkman/bin/sdkman-init.sh" ]] && source "$HOME/.sdkman/bin/sdkman-init.sh"

if command -v wt >/dev/null 2>&1; then eval "$(command wt config shell init zsh)"; fi
