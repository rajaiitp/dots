#!/usr/bin/env bash
# ============================================================================
# resolution.sh — per-output resolution picker for Hyprland (taskbar)
# ============================================================================
# Flow:
#   1. Pick an output (HDMI / Laptop).
#   2. Pick a resolution@refresh from that output's supported EDID modes.
# The choice is applied live AND saved to /tmp/display-res-<hdmi|laptop> so
# display_mode.sh reuses it whenever you switch Auto/Laptop/HDMI/Both.
#
# Usage:
#   resolution.sh                      -> interactive (fuzzel)
#   resolution.sh hdmi 2560x1440@60    -> set directly
#   resolution.sh laptop 1920x1200@60
# ============================================================================

set -uo pipefail

LAPTOP="eDP-1"
RESFILE_HDMI="/tmp/display-res-hdmi"
RESFILE_LAPTOP="/tmp/display-res-laptop"

get_external() {
    local ext
    ext=$(hyprctl monitors -j 2>/dev/null \
        | jq -r --arg lap "$LAPTOP" '.[] | select(.name != $lap) | .name' | head -n1)
    [[ -z "$ext" ]] && ext=$(hyprctl monitors all -j 2>/dev/null \
        | jq -r --arg lap "$LAPTOP" '.[] | select(.name != $lap) | .name' | head -n1)
    printf '%s' "$ext"
}

# Extra custom modes to offer for the external display even if the TV does not
# advertise them over EDID. 2560x1440@60 is the sweet spot on this hardware
# (sharp, 60Hz, and below the 4K@60 bandwidth bug on the Radeon 740M).
EXT_EXTRA_MODES="2560x1440@60"

# A curated shortlist of resolutions (by WIDTHxHEIGHT) to offer. Anything the
# display doesn't actually support is filtered out below.
WHITELIST="3840x2160 2560x1440 1920x1200 1920x1080 1600x1200 1280x800 1280x720"

# List a few useful modes as "WIDTHxHEIGHT@RR": one entry per resolution
# (preferring 60Hz, else the highest available), limited to the whitelist.
list_modes() {
    local name="$1"
    local all res rr best
    all=$( {
        hyprctl monitors all -j 2>/dev/null \
            | jq -r --arg n "$name" '.[] | select(.name == $n) | .availableModes[]' \
            | sed -E 's/@([0-9]+)\.[0-9]+Hz/@\1/'
        # Offer extra custom modes only for the external (non-laptop) output.
        [[ "$name" != "$LAPTOP" ]] && printf '%s\n' $EXT_EXTRA_MODES
    } )

    for res in $WHITELIST; do
        # Prefer a 60Hz variant, otherwise take the highest refresh available.
        best=$(printf '%s\n' "$all" | grep -E "^${res}@" | sort -t @ -k2,2nr)
        [[ -z "$best" ]] && continue
        rr=$(printf '%s\n' "$best" | grep -E '@60$' | head -n1)
        [[ -z "$rr" ]] && rr=$(printf '%s\n' "$best" | head -n1)
        printf '%s\n' "$rr"
    done
}

# Current mode of an output as "WIDTHxHEIGHT@RR".
current_mode() {
    hyprctl monitors -j 2>/dev/null | jq -r --arg n "$1" '
        .[] | select(.name == $n)
        | "\(.width)x\(.height)@\(.refreshRate | floor)"'
}

# Current mode string "WxH@RR" as Hyprland reports it (integer refresh).
mode_str() {
    hyprctl monitors -j 2>/dev/null | jq -r --arg n "$1" '
        .[] | select(.name == $n)
        | "\(.width)x\(.height)@\(.refreshRate | floor)"'
}
mon_height() {
    hyprctl monitors -j 2>/dev/null | jq -r --arg n "$1" '
        .[] | select(.name == $n) | .height'
}

# Re-align outputs so they never overlap or leave gaps after a resolution
# change. Mirrors the layout policy in display_mode.sh:
#   * both  -> HDMI on top at 0,0; laptop directly below at 0,<hdmi_height>.
#   * single output -> pinned at 0,0.
relayout() {
    local mode ext eh
    mode=$(cat /tmp/display-mode 2>/dev/null || echo auto)
    ext=$(get_external)

    if [[ "$mode" == "both" && -n "$ext" ]] && is_enabled "$ext" && is_enabled "$LAPTOP"; then
        eh=$(mon_height "$ext"); [[ -z "$eh" || "$eh" == "null" ]] && eh=1440
        hyprctl keyword monitor "$ext,$(mode_str "$ext"),0x0,1"        >/dev/null 2>&1
        hyprctl keyword monitor "$LAPTOP,$(mode_str "$LAPTOP"),0x${eh},1" >/dev/null 2>&1
    else
        # Only one active output — keep it at the origin.
        local only
        for only in "$ext" "$LAPTOP"; do
            [[ -n "$only" ]] && is_enabled "$only" \
                && hyprctl keyword monitor "$only,$(mode_str "$only"),0x0,1" >/dev/null 2>&1
        done
    fi
}

is_enabled() {
    hyprctl monitors -j 2>/dev/null | jq -e --arg n "$1" 'any(.[]; .name == $n)' >/dev/null 2>&1
}

apply_res() {
    local name="$1" mode="$2" resfile="$3"
    # Keep current position (fall back to auto).
    local pos
    pos=$(hyprctl monitors -j 2>/dev/null | jq -r --arg n "$name" '
        .[] | select(.name == $n) | "\(.x)x\(.y)"')
    [[ -z "$pos" || "$pos" == "null" || "$pos" == "x" ]] && pos="auto"

    hyprctl keyword monitor "$name,$mode,$pos,1" >/dev/null 2>&1
    sleep 1

    local now; now=$(current_mode "$name")
    if [[ "${now%@*}" == "${mode%@*}" ]]; then
        printf '%s\n' "$mode" > "$resfile"
        # Re-align both screens so the size change doesn't overlap/gap them.
        relayout
        notify-send -t 1800 "🖥️ Resolution" "$name → $mode"
    else
        notify-send -t 2500 "🖥️ Resolution" "$name rejected $mode (now $now)"
        return 1
    fi
}

# ---- direct (non-interactive) mode ----------------------------------------
if [[ $# -ge 2 ]]; then
    case "$1" in
        hdmi)   apply_res "$(get_external)" "$2" "$RESFILE_HDMI" ;;
        laptop) apply_res "$LAPTOP"          "$2" "$RESFILE_LAPTOP" ;;
        *) echo "usage: resolution.sh hdmi|laptop WxH@RR" >&2; exit 1 ;;
    esac
    exit $?
fi

# ---- interactive: choose output -------------------------------------------
ext="$(get_external)"
outlist="  Laptop ($LAPTOP)"
[[ -n "$ext" ]] && outlist="  HDMI ($ext)"$'\n'"$outlist"

out=$(printf '%s\n' "$outlist" | fuzzel --dmenu --prompt "Output: " --lines 2 --width 28)
[[ -z "$out" ]] && exit 0

case "$out" in
    *HDMI*)   name="$ext";   resfile="$RESFILE_HDMI" ;;
    *Laptop*) name="$LAPTOP"; resfile="$RESFILE_LAPTOP" ;;
    *) exit 0 ;;
esac
[[ -z "$name" ]] && { notify-send "🖥️ Resolution" "No such output"; exit 1; }

# ---- choose resolution -----------------------------------------------------
cur="$(current_mode "$name")"
mode=$(list_modes "$name" \
    | awk -v c="$cur" '{ printf "%s%s\n", ($0==c?"● ":"  "), $0 }' \
    | fuzzel --dmenu --prompt "Resolution: " --lines 12 --width 24 \
    | sed -E 's/^[●[:space:]]+//')

[[ -z "$mode" ]] && exit 0
apply_res "$name" "$mode" "$resfile"
