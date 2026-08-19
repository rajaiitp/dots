#!/usr/bin/env bash
# ============================================================================
# fuzzel_theme.sh — switch fuzzel's active color theme
# ============================================================================
# Presets live in ~/.config/fuzzel/themes/*.ini (each a [colors] block).
# The active theme is themes/active.ini, which fuzzel.ini includes. Switching
# just copies the chosen preset onto active.ini (kept out of git).
#
# Usage:
#   fuzzel_theme.sh                 -> fuzzel menu of themes
#   fuzzel_theme.sh catppuccin-mocha-> set that theme directly
# ============================================================================

set -uo pipefail

THEMES="$HOME/.config/fuzzel/themes"
ACTIVE="$THEMES/active.ini"

apply() {
    local name="$1" src="$THEMES/$1.ini"
    [[ -f "$src" ]] || { notify-send -t 2000 "Fuzzel theme" "No such theme: $name"; return 1; }
    cp -f "$src" "$ACTIVE"
    printf '%s\n' "$name" > "$THEMES/.current"
    notify-send -t 1500 "󰉦 Fuzzel theme" "$name" 2>/dev/null || true
}

# List available theme names (basename without .ini, excluding active).
list() {
    find "$THEMES" -maxdepth 1 -name '*.ini' ! -name 'active.ini' -printf '%f\n' \
        | sed 's/\.ini$//' | sort
}

if [[ $# -ge 1 ]]; then
    apply "$1"; exit $?
fi

# Interactive: loop so the picker RE-OPENS in each theme you select, giving a
# live preview of the box. Pick "Done" (or press Esc) to keep the current one.
while true; do
    current=$(cat "$THEMES/.current" 2>/dev/null || echo "")
    count=$(( $(list | wc -l) + 1 ))
    choice=$( { printf '  ✔ Done (keep %s)\n' "${current:-current}"
                list | awk -v c="$current" '{ printf "%s%s\n", ($0==c?"● ":"  "), $0 }' ; } \
        | fuzzel --dmenu --prompt "Theme: " --lines "$count" --width 34 \
        | sed -E 's/^[●✔[:space:]]+//')

    # Esc / empty -> keep current and exit.
    [[ -z "$choice" ]] && exit 0
    case "$choice" in
        Done*) exit 0 ;;
    esac
    apply "$choice"
done
