#!/usr/bin/env bash
set -euo pipefail

herdr_bin=${HERDR_BIN_PATH:-herdr}
notes_dir=${TODO_DIR:-$HOME/notes}
todo_file=${TODO_FILE:-$notes_dir/todo.txt}
workspace_label=todo

workspace_id=$(
  "$herdr_bin" workspace list |
    jq -r --arg label "$workspace_label" '.result.workspaces[] | select(.label == $label) | .workspace_id' |
    head -n 1
)

if [[ -z $workspace_id ]]; then
  created=$("$herdr_bin" workspace create --cwd "$notes_dir" --label "$workspace_label" --focus)
  workspace_id=$(jq -r '.result.workspace.workspace_id' <<<"$created")
  pane_id=$(jq -r '.result.root_pane.pane_id' <<<"$created")
else
  "$herdr_bin" workspace focus "$workspace_id" >/dev/null
  pane_id=$(
    "$herdr_bin" pane list |
      jq -r --arg workspace_id "$workspace_id" '.result.panes[] | select(.workspace_id == $workspace_id) | .pane_id' |
      head -n 1
  )
fi

[[ -n $pane_id && $pane_id != null ]] || exit 1

if ! "$herdr_bin" pane process-info --pane "$pane_id" |
  jq -e '.result.process_info.foreground_processes[]? | select((.name | ascii_downcase) == "tuxedo")' >/dev/null; then
  "$herdr_bin" pane run "$pane_id" env \
    TODO_DIR="$notes_dir" \
    TODO_FILE="$todo_file" \
    tuxedo >/dev/null
fi
