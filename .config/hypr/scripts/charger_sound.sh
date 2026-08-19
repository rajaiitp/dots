#!/bin/bash
# Play a sound the instant the charger is connected / disconnected.
#
# Event-driven: blocks on `udevadm monitor` for power_supply changes and only
# reacts when AC/online actually flips. This fires the moment AC power toggles
# (same signal waybar's battery `format-plugged` uses), so the sound lands in
# sync with the bar's bolt icon instead of lagging behind a poll interval.
#
# Same sound (complete.oga) is played for both connect and disconnect.

AC="/sys/class/power_supply/AC/online"
SOUND_DIR="/usr/share/sounds/freedesktop/stereo"
SOUND="$SOUND_DIR/complete.oga"
LOG="${XDG_RUNTIME_DIR:-/tmp}/charger_sound.log"

log() { echo "$(date '+%H:%M:%S') $*" >> "$LOG"; }

# Pick an available player. paplay is the most reliable for detached processes.
play() {
    if command -v paplay >/dev/null 2>&1; then paplay "$SOUND" && return 0; fi
    if command -v pw-play >/dev/null 2>&1; then pw-play "$SOUND" && return 0; fi
    if command -v canberra-gtk-play >/dev/null 2>&1; then canberra-gtk-play -f "$SOUND" && return 0; fi
    return 1
}

[ -r "$AC" ] || { log "AC path unreadable: $AC"; exit 0; }

react() {
    local cur; cur=$(cat "$AC" 2>/dev/null)
    if [ "$cur" != "$prev" ]; then
        [ "$cur" = "1" ] && log "plugged"   || log "unplugged"
        play || log "play FAILED"
        prev="$cur"
    fi
}

prev=$(cat "$AC" 2>/dev/null)

if command -v udevadm >/dev/null 2>&1; then
    log "started (event-driven via udevadm)"
    # Each power_supply uevent line triggers a re-check of AC/online.
    udevadm monitor --udev --subsystem-match=power_supply 2>/dev/null | while read -r _; do
        react
    done
else
    # Fallback: fast poll if udevadm is unavailable.
    log "started (poll fallback, no udevadm)"
    while true; do
        react
        sleep 1
    done
fi
