# Custom Zsh functions and integrations.

# Tuxedo should always use the shared notes file, regardless of the shell's cwd.
export TODO_DIR="$HOME/notes"
export TODO_FILE="$TODO_DIR/todo.txt"

# Load Rust's environment when available.
[[ -r "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"

tablet() {
  local dispatcher=/data/data/com.termux/files/home/bin/tablet-playback
  if [[ $1 == sync ]]; then
    shift
    ~/.config/scripts/android/install-tablet-stack.sh --apps "$@"
    return
  fi
  (( $# )) || set -- help
  print -rl -- "$@" | ssh xiaomi "su -c $dispatcher"
}

# Publish each Herdr shell command's completion and exit status out-of-band.
# pi-herdr's run_wait watches this file, so no protocol marker is printed in panes.
if [[ ${HERDR_ENV:-} == 1 && -n ${HERDR_PANE_ID:-} ]]; then
  typeset -g _pi_herdr_status_dir="${XDG_RUNTIME_DIR:-/tmp}/pi-herdr-status"
  typeset -g _pi_herdr_status_file="$_pi_herdr_status_dir/${HERDR_PANE_ID//\//_}.status"
  typeset -gi _pi_herdr_status_seq=0
  mkdir -p "$_pi_herdr_status_dir" 2>/dev/null
  _pi_herdr_status_precmd() {
    local command_status=$?
    (( ++_pi_herdr_status_seq ))
    print -r -- "${_pi_herdr_status_seq}:${command_status}" >| "$_pi_herdr_status_file"
  }
  precmd_functions=(_pi_herdr_status_precmd ${precmd_functions:#_pi_herdr_status_precmd})
fi

# Name Herdr tabs after a running command, without overriding a manual label.
if [[ ${HERDR_ENV:-} == 1 && -n ${HERDR_TAB_ID:-} && -n ${HERDR_SOCKET_PATH:-} ]]; then
  typeset -g _herdr_state_dir="${XDG_RUNTIME_DIR:-/tmp}/herdr-tabnames"
  typeset -g _herdr_last_file="$_herdr_state_dir/$HERDR_TAB_ID"
  mkdir -p "$_herdr_state_dir" 2>/dev/null
  _herdr_tab_field() { herdr tab list 2>/dev/null | HERDR_FIELD=$1 python3 -c 'import json,sys,os
try:
 tab=os.environ["HERDR_TAB_ID"]; field=os.environ["HERDR_FIELD"]
 for item in json.load(sys.stdin)["result"]["tabs"]:
  if item["tab_id"] == tab: print(item[field]); break
except Exception: pass'; }
  _herdr_set_label() { herdr tab rename "$HERDR_TAB_ID" "$1" >/dev/null 2>&1; print -n -- "$1" >| "$_herdr_last_file" 2>/dev/null; }
  _herdr_may_manage() {
    [[ ! -e "$_herdr_last_file.manual" ]] || return 1
    local current=$(_herdr_tab_field label) ours=''
    [[ -e $_herdr_last_file ]] && ours=$(<"$_herdr_last_file")
    if [[ -z $ours ]]; then [[ $current == <-> ]] || { touch "$_herdr_last_file.manual"; return 1; }
    elif [[ $current != $ours ]]; then touch "$_herdr_last_file.manual"; return 1; fi
  }
  _herdr_preexec() { _herdr_may_manage || return; local name=${${${1##[[:space:]]#}%%[[:space:]]*}##*/}; [[ -n $name ]] && _herdr_set_label "$name"; }
  _herdr_precmd() { _herdr_may_manage || return; local number=$(_herdr_tab_field number); [[ -n $number ]] && _herdr_set_label "$number"; }
  preexec_functions+=(_herdr_preexec)
  precmd_functions+=(_herdr_precmd)
fi

