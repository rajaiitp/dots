#!/usr/bin/env bash
# Hybrid Waybar controls for a Google Home speaker.
# Main widget: click play/pause, right-click mute, scroll volume.
# Menu widget: playback, seeking, volume, mute, and stop controls.

set -uo pipefail

DEVICE="${GOOGLE_HOME_DEVICE:-Bedroom speaker}"
CATT="${CATT_BIN:-$HOME/.local/bin/catt}"

[[ -x "$CATT" ]] || CATT="$(command -v catt 2>/dev/null || true)"

refresh_waybar() {
    pkill -RTMIN+9 waybar 2>/dev/null || true
}

run_catt() {
    [[ -n "$CATT" ]] || return 127
    timeout 6 "$CATT" -d "$DEVICE" "$@" >/dev/null 2>&1
}

get_status() {
    [[ -n "$CATT" ]] || return 127
    timeout 6 "$CATT" -d "$DEVICE" status 2>/dev/null
}

status() {
    local output state volume muted class icon text tooltip

    if ! output=$(get_status); then
        jq -cn --arg text "󰑉" --arg tooltip "$DEVICE · unavailable" \
            '{text:$text, tooltip:$tooltip, class:"offline"}'
        return
    fi

    state=$(awk -F': ' '/^State:/ {print $2; exit}' <<<"$output")
    volume=$(awk -F': ' '/^Volume:/ {print $2; exit}' <<<"$output")
    muted=$(awk -F': ' '/^Volume muted:/ {print $2; exit}' <<<"$output")
    volume=${volume:-0}

    case "$state" in
        PLAYING) class="playing"; icon="󰏤" ;;
        PAUSED)  class="paused";  icon="󰐊" ;;
        *)       class="idle";    icon="󰑈" ;;
    esac
    [[ "$muted" == "True" ]] && icon="󰝟"

    text="$icon ${volume}%"
    tooltip="$DEVICE · ${state:-idle} · volume ${volume}%"
    [[ "$muted" == "True" ]] && tooltip+=" · muted"
    jq -cn --arg text "$text" --arg tooltip "$tooltip" --arg class "$class" \
        '{text:$text, tooltip:$tooltip, class:$class}'
}

mute_toggle() {
    local current
    current=$(get_status | awk -F': ' '/^Volume muted:/ {print $2; exit}')
    [[ "$current" == "True" ]] && run_catt volumemute false || run_catt volumemute true
}

seek_prompt() {
    local target
    target=$(printf '00:30\n01:00\n05:00\n10:00\n30:00\n' \
        | fuzzel --dmenu --prompt "Seek to: " --lines 5 --width 28)
    [[ -z "$target" ]] && return
    if [[ "$target" =~ ^([0-9]+:)?[0-5]?[0-9]:[0-5][0-9]$ || "$target" =~ ^[0-9]+$ ]]; then
        run_catt seek "$target"
    else
        notify-send -t 2000 "Google Home" "Use seconds, MM:SS, or HH:MM:SS" 2>/dev/null || true
    fi
}

menu() {
    local output state volume muted toggle_label mute_label choice

    if ! output=$(get_status); then
        notify-send -t 2000 "Google Home" "$DEVICE is unavailable" 2>/dev/null || true
        return
    fi
    state=$(awk -F': ' '/^State:/ {print $2; exit}' <<<"$output")
    volume=$(awk -F': ' '/^Volume:/ {print $2; exit}' <<<"$output")
    muted=$(awk -F': ' '/^Volume muted:/ {print $2; exit}' <<<"$output")
    toggle_label="󰏤  Pause"
    [[ "$state" != "PLAYING" ]] && toggle_label="󰐊  Play"
    mute_label="󰖁  Mute"
    [[ "$muted" == "True" ]] && mute_label="󰕾  Unmute"

    choice=$(printf '%s\n' \
        "󰓃  $DEVICE · ${state:-idle} · ${volume:-0}%" \
        "$toggle_label" \
        "󰒮  Back 10 seconds" \
        "󰑖  Forward 30 seconds" \
        "󰒫  Seek to time…" \
        "󰝝  Volume −5" \
        "󰝞  Volume +5" \
        "$mute_label" \
        "󰓛  Stop playback" \
        | fuzzel --dmenu --prompt "Google Home: " --lines 9 --width 42)

    case "$choice" in
        *"  Play"|*"  Pause") run_catt play_toggle ;;
        *"Back 10 seconds") run_catt rewind 10 ;;
        *"Forward 30 seconds") run_catt ffwd 30 ;;
        *"Seek to time"*) seek_prompt ;;
        *"Volume −5") run_catt volumedown 5 ;;
        *"Volume +5") run_catt volumeup 5 ;;
        *"  Mute"|*"  Unmute") mute_toggle ;;
        *"Stop playback") run_catt stop ;;
        *) return ;;
    esac
    refresh_waybar
}

case "${1:-status}" in
    status) status ;;
    toggle) run_catt play_toggle; refresh_waybar ;;
    volume-up) run_catt volumeup 5; refresh_waybar ;;
    volume-down) run_catt volumedown 5; refresh_waybar ;;
    mute) mute_toggle; refresh_waybar ;;
    menu) menu ;;
    *) printf 'Usage: %s {status|toggle|volume-up|volume-down|mute|menu}\n' "$0" >&2; exit 2 ;;
esac
