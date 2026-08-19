#!/usr/bin/env bash
# ============================================================================
# display_menu.sh — combined display picker (two-step submenu)
# ============================================================================
# Level 1: choose a category — Mode or Resolution.
# Level 2: the existing picker for that category.
#   * Mode        -> display_mode.sh  (Auto / Laptop / HDMI / Both)
#   * Resolution  -> resolution.sh    (per-output resolution)
# ============================================================================

set -uo pipefail
DIR="$HOME/.config/hypr/scripts"

choice=$(printf '%s\n' \
    "󰍹  Mode  (Auto / Laptop / HDMI / Both)" \
    "󰺵  Resolution" \
    | fuzzel --dmenu --prompt "Display: " --lines 2 --width 40)

case "$choice" in
    *Mode*)       exec "$DIR/display_mode.sh" ;;
    *Resolution*) exec "$DIR/resolution.sh" ;;
esac
