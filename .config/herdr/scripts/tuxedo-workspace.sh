#!/usr/bin/env bash
set -euo pipefail

herdr_bin=${HERDR_BIN_PATH:-herdr}
notes_dir=${TODO_DIR:-$HOME/notes}
todo_file=${TODO_FILE:-$notes_dir/todo.txt}
workspace_label=todo
background=false
lock_attempts=200
lock_delay_seconds=0.05

case $# in
0) ;;
1)
  [[ $1 == --background ]] || {
    printf 'usage: %s [--background]\n' "${0##*/}" >&2
    exit 2
  }
  background=true
  ;;
*)
  printf 'usage: %s [--background]\n' "${0##*/}" >&2
  exit 2
  ;;
esac

lock_root=${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}
lock_dir=$lock_root/herdr-todo-workspace-$(id -u).lock
lock_owner=$lock_dir/owner
lock_acquired=false

release_lock() {
  if [[ $lock_acquired == true && -f $lock_owner ]] &&
    [[ $(<"$lock_owner") == $$ ]]; then
    rm -rf -- "$lock_dir"
  fi
}
trap release_lock EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

for ((attempt = 0; attempt < lock_attempts; attempt++)); do
  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" >"$lock_owner"
    lock_acquired=true
    break
  fi
  owner=
  if [[ -f $lock_owner ]]; then
    IFS= read -r owner <"$lock_owner" || true
  fi
  if [[ $owner =~ ^[0-9]+$ ]] && ! kill -0 "$owner" 2>/dev/null; then
    rm -rf -- "$lock_dir"
    continue
  fi
  sleep "$lock_delay_seconds"
done

[[ $lock_acquired == true ]] || {
  printf 'timed out waiting for Todo workspace startup lock: %s\n' "$lock_dir" >&2
  exit 1
}

workspace_ids=()
while IFS= read -r workspace_id; do
  [[ -n $workspace_id ]] && workspace_ids+=("$workspace_id")
done < <(
  "$herdr_bin" workspace list |
    jq -r --arg label "$workspace_label" \
      '.result.workspaces[] | select(.label == $label) | .workspace_id'
)

if ((${#workspace_ids[@]} > 1)); then
  printf 'multiple Herdr workspaces are labeled %q; refusing an ambiguous target\n' \
    "$workspace_label" >&2
  exit 1
fi

if ((${#workspace_ids[@]} == 0)); then
  focus_flag=--focus
  [[ $background == true ]] && focus_flag=--no-focus
  created=$(
    "$herdr_bin" workspace create \
      --cwd "$notes_dir" \
      --label "$workspace_label" \
      "$focus_flag"
  )
  workspace_id=$(jq -er '.result.workspace.workspace_id' <<<"$created")
  pane_id=$(jq -er '.result.root_pane.pane_id' <<<"$created")
else
  workspace_id=${workspace_ids[0]}
  if [[ $background == false ]]; then
    "$herdr_bin" workspace focus "$workspace_id" >/dev/null
  fi
  pane_ids=()
  while IFS= read -r pane_id; do
    [[ -n $pane_id ]] && pane_ids+=("$pane_id")
  done < <(
    "$herdr_bin" pane list |
      jq -er --arg workspace_id "$workspace_id" \
        '.result.panes[] | select(.workspace_id == $workspace_id) | .pane_id'
  )
  ((${#pane_ids[@]} > 0)) || exit 1
  pane_id=${pane_ids[0]}
fi

[[ -n $pane_id && $pane_id != null ]] || exit 1

if ! "$herdr_bin" pane process-info --pane "$pane_id" |
  jq -e '.result.process_info.foreground_processes[]? | select((.name | ascii_downcase) == "tuxedo")' >/dev/null; then
  "$herdr_bin" pane run "$pane_id" env \
    TODO_DIR="$notes_dir" \
    TODO_FILE="$todo_file" \
    tuxedo >/dev/null
fi
