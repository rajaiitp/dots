#!/usr/bin/env bash
# Waybar JSON for the combined display control (mode + resolution).
# Text: an icon reflecting the current display mode.
# Tooltip: current mode plus each active output's resolution.
LAPTOP="eDP-1"
mode=$(cat /tmp/display-mode 2>/dev/null || echo auto)

case "$mode" in
    laptop) mtext="Laptop only" ;;
    hdmi)   mtext="HDMI only" ;;
    both)   mtext="Both" ;;
    *)      mtext="Auto" ;;
esac
icon="\U000f0379"   # nf-md-monitor (screen)

mode_of() {
    hyprctl monitors -j 2>/dev/null | jq -r --arg n "$1" '
        .[] | select(.name == $n) | "\(.width)x\(.height)@\(.refreshRate|floor)"'
}

ext=$(hyprctl monitors -j 2>/dev/null | jq -r --arg lap "$LAPTOP" '
    .[] | select(.name != $lap) | .name' | head -n1)

tip="Display: $mtext"
lap_res=$(mode_of "$LAPTOP"); [[ -n "$lap_res" ]] && tip="$tip\nLaptop: $lap_res"
if [[ -n "$ext" ]]; then
    ext_res=$(mode_of "$ext"); [[ -n "$ext_res" ]] && tip="$tip\nHDMI: $ext_res"
fi

iconstr=$(printf "$icon")   # expand \U escape
printf '{"text":"%s","tooltip":"%s"}\n' "$iconstr" "$tip"
