#!/usr/bin/env bash
set -euo pipefail

herdr_bin=${HERDR_BIN_PATH:-${HOME}/.local/bin/herdr}
state_dir="${XDG_STATE_HOME:-${HOME}/.local/state}/herdr"
lock_file="$state_dir/tuxedo-toggle.lock"
mkdir -p "$state_dir"

# Serialize rapid Ctrl-N presses so two invocations cannot create two Tuxedo tabs.
exec 9>"$lock_file"
flock -x 9

workspace_json=$($herdr_bin workspace list)
workspace_id=$(python3 -c '
import json, sys
payload = json.load(sys.stdin)
for workspace in payload["result"]["workspaces"]:
    if workspace.get("focused"):
        print(workspace["workspace_id"])
        break
' <<<"$workspace_json")

if [[ -z $workspace_id ]]; then
    exit 0
fi

state_file="$state_dir/tuxedo-tab-${workspace_id//[^A-Za-z0-9_.-]/_}"
tabs_json=$($herdr_bin tab list --workspace "$workspace_id")
readarray -t tab_info < <(python3 -c '
import json, sys
payload = json.load(sys.stdin)
for tab in payload["result"]["tabs"]:
    print("\t".join([
        tab["tab_id"],
        tab.get("label", ""),
        "1" if tab.get("focused") else "0",
    ]))
' <<<"$tabs_json")

tuxedo_tab=""
current_tab=""
for row in "${tab_info[@]}"; do
    IFS=$'\t' read -r tab_id label focused <<<"$row"
    [[ $label == tuxedo ]] && tuxedo_tab=$tab_id
    [[ $focused == 1 ]] && current_tab=$tab_id
done

if [[ -z $tuxedo_tab ]]; then
    notes_dir="${TODO_DIR:-$HOME/notes}"
    create_json=$($herdr_bin tab create \
        --workspace "$workspace_id" \
        --cwd "$notes_dir" \
        --label tuxedo \
        --env "TODO_DIR=$notes_dir" \
        --env "TODO_FILE=$notes_dir/todo.txt" \
        --focus)
    read -r tuxedo_tab tuxedo_pane < <(python3 -c '
import json, sys
result = json.load(sys.stdin)["result"]
print(result["tab"]["tab_id"], result["root_pane"]["pane_id"])
' <<<"$create_json")
    $herdr_bin pane run "$tuxedo_pane" tuxedo >/dev/null
    [[ -n $current_tab && $current_tab != "$tuxedo_tab" ]] && printf '%s\n' "$current_tab" >"$state_file"
    exit 0
fi

if [[ $current_tab == "$tuxedo_tab" ]]; then
    previous_tab=$(cat "$state_file" 2>/dev/null || true)
    if [[ -z $previous_tab || $previous_tab == "$tuxedo_tab" ]]; then
        previous_tab=$(python3 -c '
import json, sys
for tab in json.load(sys.stdin)["result"]["tabs"]:
    if tab["tab_id"] != sys.argv[1]:
        print(tab["tab_id"])
        break
' "$tuxedo_tab" <<<"$tabs_json")
    fi
    [[ -n $previous_tab ]] && $herdr_bin tab focus "$previous_tab" >/dev/null
    rm -f "$state_file"
else
    [[ -n $current_tab ]] && printf '%s\n' "$current_tab" >"$state_file"
    $herdr_bin tab focus "$tuxedo_tab" >/dev/null
fi
