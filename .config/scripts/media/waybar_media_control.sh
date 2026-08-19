#!/usr/bin/env bash
# Waybar play/pause control for the active local MPRIS player.

set -u

refresh_waybar() {
    pkill -RTMIN+10 waybar 2>/dev/null || true
}

print_status() {
    local state title icon class tooltip

    if ! state=$(playerctl status 2>/dev/null); then
        jq -cn '{text:"󰐊", tooltip:"No active media player", class:"inactive"}'
        return
    fi

    title=$(playerctl metadata --format '{{artist}} — {{title}}' 2>/dev/null | tr '\n' ' ' || true)
    title="${title# }"
    title="${title% }"
    [[ -z "$title" ]] && title="Active media player"

    case "$state" in
        Playing)
            icon="󰏤"
            class="playing"
            tooltip="Pause · $title"
            ;;
        Paused)
            icon="󰐊"
            class="paused"
            tooltip="Play · $title"
            ;;
        *)
            icon="󰐊"
            class="stopped"
            tooltip="Play · $title"
            ;;
    esac

    jq -cn --arg text "$icon" --arg tooltip "$tooltip" --arg class "$class" \
        '{text:$text, tooltip:$tooltip, class:$class}'
}

case "${1:-status}" in
    status)
        print_status
        ;;
    toggle)
        playerctl play-pause >/dev/null 2>&1 || true
        refresh_waybar
        ;;
    *)
        printf 'Usage: %s {status|toggle}\n' "$0" >&2
        exit 2
        ;;
esac
