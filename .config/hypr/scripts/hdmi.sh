#!/usr/bin/env bash
# ============================================================================
# hdmi.sh — external-monitor-exclusive display manager for Hyprland
# ============================================================================
# Behaviour:
#   * External (Philips) connected  -> external ONLY, laptop panel disabled.
#   * External removed              -> laptop panel turns back on immediately.
#
# Why not kanshi?
#   Hyprland ignores wlr-output-management requests at runtime, so kanshi
#   cannot drive the outputs here. We talk to Hyprland natively via
#   `hyprctl keyword monitor`.
#
# Design (event-driven, crash-safe):
#   * We subscribe to Hyprland's native event stream (.socket2.sock) via socat
#     and react to monitoradded / monitorremoved events. No polling.
#   * Every reaction is a full *reconcile* of desired state, not a blind toggle,
#     so we self-heal regardless of which/what order events arrive.
#   * CRASH SAFETY: Hyprland crashes if it is ever left with zero enabled
#     monitors. We therefore NEVER disable a monitor until we have verified the
#     other one is actually enabled first. The laptop is only disabled *after*
#     the external is confirmed live.
#   * flock singleton so two instances can never race the outputs.
# ============================================================================

set -uo pipefail

LAPTOP="eDP-1"
# External display mode. The Radeon 740M (DCN 3.1.4) cannot reliably drive this
# panel at its native 4K@60 — the display engine fails bandwidth/compbuf
# programming (dcn314_validate_bandwidth / REG_WAIT compbuf_size timeouts),
# causing visible lag/stutter. 2560x1440@60 is smooth and error-free.
DEFAULT_EXT_MODE="2560x1440@60"
RESFILE_HDMI="/tmp/display-res-hdmi"
ext_mode() { cat "$RESFILE_HDMI" 2>/dev/null || echo "$DEFAULT_EXT_MODE"; }
CONF="$HOME/.config/hypr/hyprpaper.conf"
LOCKFILE="/tmp/hdmi-sh.lock"
# Manual override written by display_mode.sh. When its contents are anything
# other than "auto" (i.e. laptop/hdmi/both), the user has taken manual control
# and this auto-manager must NOT touch the outputs.
MODEFILE="/tmp/display-mode"

current_mode() { cat "$MODEFILE" 2>/dev/null || echo auto; }

WALL="$(awk -F= '/^[[:space:]]*preload[[:space:]]*=/ {sub(/^[[:space:]]+/,"",$2); print $2; exit}' "$CONF" 2>/dev/null)"
WALL="${WALL:-$HOME/Documents/wallpaper/Space-Nebula.png}"

# --- logging -----------------------------------------------------------------
LOG="/tmp/hdmi-sh.log"
log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*" >>"$LOG"; }

# --- singleton guard ---------------------------------------------------------
exec 9>"$LOCKFILE"
if ! flock -n 9; then
    exit 0   # another instance already owns the outputs
fi

# --- helpers -----------------------------------------------------------------

# Name of the active external output (a non-laptop monitor that Hyprland has
# ENABLED). Empty if none. We deliberately use `hyprctl monitors` (enabled
# only) and NOT `monitors all`: a just-unplugged output can linger in `all` as
# a disabled ghost, which would fool us into thinking the external is still
# present and prevent the laptop from turning back on. Hyprland auto-enables a
# freshly-plugged output (via the catch-all monitor rule), so an enabled-only
# check reliably reflects physical presence.
get_external() {
    hyprctl monitors -j 2>/dev/null \
        | jq -r --arg lap "$LAPTOP" '.[] | select(.name != $lap) | .name' 2>/dev/null \
        | head -n1
}

# True if the named output is currently ENABLED (enabled outputs only appear
# in plain `hyprctl monitors`, disabled ones do not).
is_enabled() {
    local name="$1"
    hyprctl monitors -j 2>/dev/null \
        | jq -e --arg n "$name" 'any(.[]; .name == $n)' >/dev/null 2>&1
}

set_wallpaper() {
    local mon="$1"
    hyprctl hyprpaper preload "$WALL"        >/dev/null 2>&1
    hyprctl hyprpaper wallpaper "$mon,$WALL"  >/dev/null 2>&1
    hyprctl hyprpaper unload unused           >/dev/null 2>&1
}

# --- state transitions -------------------------------------------------------

apply_external() {
    local ext="$1"

    # 1. Enable the external FIRST.
    hyprctl keyword monitor "$ext,$(ext_mode),auto,1" >/dev/null 2>&1

    # 2. Wait until it is genuinely enabled before touching the laptop, so we
    #    never end up with zero monitors (which crashes Hyprland).
    local i
    for i in $(seq 1 15); do
        is_enabled "$ext" && break
        sleep 0.2
    done

    if ! is_enabled "$ext"; then
        notify-send "🖥️ External ($ext) failed to enable — keeping laptop on"
        return 1
    fi

    # 3. External is confirmed live: safe to disable the laptop panel.
    hyprctl keyword monitor "$LAPTOP,disable" >/dev/null 2>&1

    set_wallpaper "$ext"
    notify-send "🖥️ External ($ext) — external only"
}

apply_laptop() {
    # CRITICAL: after the external is unplugged Hyprland falls back to a
    # transient headless output and the physical eDP-1 connector is detached.
    # In that state `hyprctl keyword monitor eDP-1,...` SILENTLY FAILS to
    # re-attach it (confirmed via drm logs). The only reliable way to bring the
    # laptop panel back is `hyprctl reload config-only`, which reapplies the
    # monitor rules from hyprland.conf (including `monitor = eDP-1,...`) and
    # re-attaches the connector. config-only avoids re-running exec autostart.
    local i
    for i in $(seq 1 8); do
        # Fast path first (works when connector is still attached).
        hyprctl keyword monitor "$LAPTOP,preferred,auto,1" >/dev/null 2>&1
        sleep 0.3
        is_enabled "$LAPTOP" && break
        # Reliable path: reapply monitor rules from config.
        hyprctl reload config-only >/dev/null 2>&1
        sleep 0.7
        is_enabled "$LAPTOP" && break
    done

    if ! is_enabled "$LAPTOP"; then
        log "  !! apply_laptop: eDP-1 still not enabled after retries"
        return 1
    fi

    set_wallpaper "$LAPTOP"
    notify-send "💻 Laptop only"
}

# Reconcile actual outputs to the desired policy. Idempotent.
reconcile() {
    # Respect a manual override — do nothing unless we're in auto mode.
    if [[ "$(current_mode)" != "auto" ]]; then
        log "reconcile: manual mode ($(current_mode)) active -> skip"
        return 0
    fi
    local ext; ext="$(get_external)"
    local lap_on ext_on
    is_enabled "$LAPTOP" && lap_on=yes || lap_on=no
    [[ -n "$ext" ]] && { is_enabled "$ext" && ext_on=yes || ext_on=no; } || ext_on=none
    log "reconcile: external='${ext:-<none>}' ext_enabled=$ext_on laptop_enabled=$lap_on"

    if [[ -n "$ext" ]]; then
        # External present -> external only. Re-run enable if laptop still on
        # or the external isn't enabled yet.
        if ! is_enabled "$ext" || is_enabled "$LAPTOP"; then
            log "  -> apply_external($ext)"
            apply_external "$ext"
        else
            log "  -> already external-only, no-op"
        fi
    else
        # No external -> laptop must be on.
        if ! is_enabled "$LAPTOP"; then
            log "  -> apply_laptop (turning laptop ON)"
            apply_laptop
        else
            log "  -> laptop already on, no-op"
        fi
    fi
}

# --- main loop ---------------------------------------------------------------

log "=== hdmi.sh started (pid $$) ==="
# Apply correct state once at startup.
reconcile

SOCK="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/hypr/${HYPRLAND_INSTANCE_SIGNATURE}/.socket2.sock"

# A hotplug (esp. unplug) produces a STORM of events while Hyprland spins up /
# tears down a transient FALLBACK headless output and reassigns CRTCs. If we
# reconcile on each individual event we act mid-churn and the change may not
# stick. Instead we debounce: every monitor event bumps a timestamp file, and
# a ticker reconciles only once the stream has been QUIET for DEBOUNCE seconds
# (i.e. the storm has settled).

STAMP="/tmp/hdmi-sh.stamp"   # contents = epoch.ns of last monitor event
DEBOUNCE=1.2                 # seconds of quiet required before reconciling

now()       { date +%s.%N; }
read_stamp() { cat "$STAMP" 2>/dev/null || echo 0; }

run_event_reader() {
    # Runs socat and records the time of every monitor event (no reconcile here).
    while true; do
        socat -U - "UNIX-CONNECT:$SOCK" 2>/dev/null | while read -r line; do
            case "$line" in
                monitor*)
                    log "EVENT: $line"
                    now > "$STAMP"        # record time of this event
                    ;;
            esac
        done
        # socat/socket dropped (Hyprland restart): bump so ticker reconciles.
        now > "$STAMP"
        sleep 1
    done
}

if command -v socat >/dev/null 2>&1 && [[ -S "$SOCK" ]]; then
    echo 0 > "$STAMP"
    run_event_reader &
    READER_PID=$!
    trap 'kill "$READER_PID" 2>/dev/null' EXIT

    LAST_PROCESSED=0
    while true; do
        sleep 0.3
        EVENT_T="$(read_stamp)"
        # New event since we last reconciled?
        if awk "BEGIN{exit !($EVENT_T > $LAST_PROCESSED)}"; then
            # Only act once the stream has been quiet for DEBOUNCE seconds.
            QUIET="$(awk "BEGIN{print $(now) - $EVENT_T}")"
            if awk "BEGIN{exit !($QUIET >= $DEBOUNCE)}"; then
                log "storm settled -> reconcile"
                reconcile
                LAST_PROCESSED="$EVENT_T"
            fi
        fi
    done
else
    # Fallback path: socat or socket unavailable -> poll gently.
    while true; do
        reconcile
        sleep 1
    done
fi
