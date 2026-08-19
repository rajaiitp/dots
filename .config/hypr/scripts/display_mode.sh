#!/usr/bin/env bash
# ============================================================================
# display_mode.sh — manual display output chooser for Hyprland
# ============================================================================
# Lets you pick: Auto | Laptop only | HDMI only | Both.
#
# Writes the chosen mode to /tmp/display-mode. hdmi.sh (the auto hotplug
# manager) reads this file and stays out of the way whenever the mode is not
# "auto", so the two never fight over the outputs.
#
# Usage:
#   display_mode.sh            -> fuzzel menu to pick a mode
#   display_mode.sh auto|laptop|hdmi|both  -> set that mode directly
#
# Crash-safety: Hyprland crashes if left with zero enabled monitors, so we
# ALWAYS enable the target output(s) before disabling anything else.
# ============================================================================

set -uo pipefail

LAPTOP="eDP-1"
MODEFILE="/tmp/display-mode"
# External mode: 2560x1440@60 avoids the 4K@60 amdgpu display-bandwidth bug on
# the Radeon 740M that causes lag/stutter (see hdmi.sh for details).
DEFAULT_EXT_MODE="2560x1440@60"
# Per-output resolution overrides written by resolution.sh (taskbar picker).
RESFILE_HDMI="/tmp/display-res-hdmi"
RESFILE_LAPTOP="/tmp/display-res-laptop"

# Resolution to use for each output: the user's saved choice if present,
# otherwise a safe default.
ext_mode()    { cat "$RESFILE_HDMI"   2>/dev/null || echo "$DEFAULT_EXT_MODE"; }
laptop_mode() { cat "$RESFILE_LAPTOP" 2>/dev/null || echo "preferred"; }

is_enabled() {
    hyprctl monitors -j 2>/dev/null \
        | jq -e --arg n "$1" 'any(.[]; .name == $n)' >/dev/null 2>&1
}

# Name of an external (non-laptop) output. Prefer an already-enabled one,
# otherwise fall back to a connected-but-disabled output from `monitors all`.
get_external() {
    local ext
    ext=$(hyprctl monitors -j 2>/dev/null \
        | jq -r --arg lap "$LAPTOP" '.[] | select(.name != $lap) | .name' | head -n1)
    if [[ -z "$ext" ]]; then
        ext=$(hyprctl monitors all -j 2>/dev/null \
            | jq -r --arg lap "$LAPTOP" '.[] | select(.name != $lap) | .name' | head -n1)
    fi
    printf '%s' "$ext"
}

# Each output enables at its saved (or default) resolution.
enable_mon() {
    if [[ "$1" == "$LAPTOP" ]]; then
        hyprctl keyword monitor "$1,$(laptop_mode),auto,1" >/dev/null 2>&1
    else
        hyprctl keyword monitor "$1,$(ext_mode),auto,1" >/dev/null 2>&1
    fi
}
disable_mon() { hyprctl keyword monitor "$1,disable" >/dev/null 2>&1; }

wait_enabled() {
    local n="$1" i
    for i in $(seq 1 15); do is_enabled "$n" && return 0; sleep 0.2; done
    return 1
}

apply_laptop() {
    enable_mon "$LAPTOP"
    if ! wait_enabled "$LAPTOP"; then hyprctl reload config-only >/dev/null 2>&1; wait_enabled "$LAPTOP"; fi
    local ext; ext="$(get_external)"
    [[ -n "$ext" ]] && is_enabled "$LAPTOP" && disable_mon "$ext"
    notify-send -t 1500 "🖥️ Display" "Laptop only"
}

apply_hdmi() {
    local ext; ext="$(get_external)"
    if [[ -z "$ext" ]]; then
        notify-send -t 2000 "🖥️ Display" "No external display connected"
        return 1
    fi
    enable_mon "$ext"
    if wait_enabled "$ext"; then
        disable_mon "$LAPTOP"
        notify-send -t 1500 "🖥️ Display" "HDMI only"
    else
        notify-send -t 2000 "🖥️ Display" "External ($ext) failed to enable"
        return 1
    fi
}

apply_both() {
    local ext; ext="$(get_external)"
    if [[ -z "$ext" ]]; then
        enable_mon "$LAPTOP"
        notify-send -t 2000 "🖥️ Display" "No external — laptop only"
        return
    fi

    # Make sure the external is on first (never risk zero monitors).
    enable_mon "$ext"
    wait_enabled "$ext"

    # Re-enable the laptop panel. After a spell of external-only the eDP-1
    # connector detaches and a plain `keyword monitor` SILENTLY FAILS, so fall
    # back to `reload config-only` (which reapplies hyprland.conf's monitor
    # rules and re-attaches the connector), exactly like apply_laptop().
    local i
    for i in $(seq 1 8); do
        enable_mon "$LAPTOP"
        sleep 0.3
        is_enabled "$LAPTOP" && break
        hyprctl reload config-only >/dev/null 2>&1
        sleep 0.7
        is_enabled "$LAPTOP" && break
    done

    # A config reload may have re-picked the external's preferred (4K) mode via
    # the catch-all rule, so re-assert the saved modes afterwards.
    # Stack the outputs vertically: HDMI on top at 0,0 and the laptop directly
    # below it (y = HDMI height), instead of side-by-side.
    local eh; eh=$(hyprctl monitors -j | jq -r --arg n "$ext" '.[]|select(.name==$n)|.height' 2>/dev/null)
    [[ -z "$eh" || "$eh" == "null" ]] && eh=1440
    hyprctl keyword monitor "$ext,$(ext_mode),0x0,1" >/dev/null 2>&1
    hyprctl keyword monitor "$LAPTOP,$(laptop_mode),0x${eh},1" >/dev/null 2>&1

    if is_enabled "$LAPTOP"; then
        notify-send -t 1500 "🖥️ Display" "Both (laptop + HDMI)"
    else
        notify-send -t 2000 "🖥️ Display" "HDMI on, laptop failed to enable"
    fi
}

apply_auto() {
    # Hand control back to the auto hotplug manager and let it reconcile now.
    notify-send -t 1500 "🖥️ Display" "Auto (follow hotplug)"
    pkill -x -f "$HOME/.config/hypr/scripts/hdmi.sh" >/dev/null 2>&1 || true
    setsid "$HOME/.config/hypr/scripts/hdmi.sh" >/dev/null 2>&1 &
}

set_mode() {
    local mode="$1"
    printf '%s\n' "$mode" > "$MODEFILE"
    case "$mode" in
        laptop) apply_laptop ;;
        hdmi)   apply_hdmi ;;
        both)   apply_both ;;
        auto)   apply_auto ;;
        *) echo "unknown mode: $mode" >&2; return 1 ;;
    esac
}

if [[ $# -ge 1 ]]; then
    set_mode "$1"
    exit $?
fi

choice=$(printf '%s\n' \
    "  Auto (follow hotplug)" \
    "  Laptop only" \
    "  HDMI only" \
    "  Both (laptop + HDMI)" \
    | fuzzel --dmenu --prompt "Display: " --lines 4 --width 24)

case "$choice" in
    *Auto*)   set_mode auto ;;
    *Laptop*) set_mode laptop ;;
    *HDMI*)   set_mode hdmi ;;
    *Both*)   set_mode both ;;
esac
