#!/usr/bin/env bash
# Workaround for hyprpaper 0.8.4 not auto-loading hyprpaper.conf.
# Waits for hyprpaper's IPC to come up, then applies wallpaper to all monitors.
#
# The wallpaper path is read from ~/.config/hypr/hyprpaper.conf so the file
# still serves as the source of truth — you just edit the path there.

set -euo pipefail

CONF="${XDG_CONFIG_HOME:-$HOME/.config}/hypr/hyprpaper.conf"
WALL="$(awk -F= '/^[[:space:]]*preload[[:space:]]*=/ {sub(/^[[:space:]]+/,"",$2); print $2; exit}' "$CONF")"

if [[ -z "$WALL" || ! -f "$WALL" ]]; then
    echo "set-wallpaper: no valid preload path in $CONF" >&2
    exit 1
fi

# Wait up to ~5s for hyprpaper IPC socket to be ready.
# `listactive` is a valid request even when no wallpaper is set.
for _ in {1..25}; do
    if hyprctl hyprpaper listactive &>/dev/null; then
        break
    fi
    sleep 0.2
done

# Apply to every connected monitor.
# Prefer jq; fall back to a stricter awk that only matches the top-level name.
if command -v jq &>/dev/null; then
    mons=$(hyprctl monitors -j | jq -r '.[].name')
else
    mons=$(hyprctl monitors | awk '/^Monitor / {print $2}')
fi

while IFS= read -r mon; do
    [[ -n "$mon" ]] || continue
    hyprctl hyprpaper wallpaper "$mon,$WALL" >/dev/null
done <<<"$mons"
