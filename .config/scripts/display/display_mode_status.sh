#!/usr/bin/env bash
# Emit waybar JSON showing the current display output mode.
mode=$(cat /tmp/display-mode 2>/dev/null || echo auto)

case "$mode" in
    laptop) icon="\uf109"; text="Laptop only" ;;   # fa-laptop
    hdmi)   icon="\uf108"; text="HDMI only" ;;      # fa-desktop (monitor)
    both)   icon="\uf24d"; text="Both" ;;           # fa-clone (two screens)
    *)      icon="\uf021"; text="Auto" ;;           # fa-refresh (follow hotplug)
esac

printf '{"text":"%b","tooltip":"Display: %s"}\n' "$icon" "$text"
