#!/usr/bin/env bash
# Waybar JSON for the resolution picker: shows current res of the "active"
# output (external if present, else laptop) and both in the tooltip.
LAPTOP="eDP-1"

mode_of() {
    hyprctl monitors -j 2>/dev/null | jq -r --arg n "$1" '
        .[] | select(.name == $n) | "\(.width)x\(.height)@\(.refreshRate|floor)"'
}

ext=$(hyprctl monitors -j 2>/dev/null | jq -r --arg lap "$LAPTOP" '
    .[] | select(.name != $lap) | .name' | head -n1)

lap_res=$(mode_of "$LAPTOP")
tip="Resolution"
[[ -n "$lap_res" ]] && tip="$tip\nLaptop: $lap_res"

if [[ -n "$ext" ]]; then
    ext_res=$(mode_of "$ext")
    tip="$tip\nHDMI: $ext_res"
    text="$ext_res"
else
    text="$lap_res"
fi

# Icon only (no resolution text). Current resolutions live in the tooltip.
# Keep the tooltip's \n as literal JSON escapes (raw newlines are invalid JSON).
icon=$(printf '\U000f0379')   # nf-md-monitor
printf '{"text":"%s","tooltip":"%s"}\n' "$icon" "$tip"
