#!/bin/bash
# Battery watchdog:
#   - Warn once when battery drops to/below WARN_LEVEL while discharging.
#   - Auto-suspend at SUSPEND_LEVEL so you never lose work on a dead battery.
# Re-arms the warning only after the battery recovers above WARN_LEVEL
# (e.g. after plugging in), so you don't get spammed every loop.

BAT="/sys/class/power_supply/BAT0"
WARN_LEVEL=15
SUSPEND_LEVEL=5
POLL=60          # seconds between checks (tightened from 120 for faster reaction)

SOUND_DIR="/usr/share/sounds/freedesktop/stereo"
WARN_SOUND="$SOUND_DIR/dialog-warning.oga"
CRIT_SOUND="$SOUND_DIR/alarm-clock-elapsed.oga"

# Play a notification sound (paplay → pw-play → canberra).
play_sound() {
    local f="$1"
    if command -v paplay >/dev/null 2>&1; then paplay "$f" >/dev/null 2>&1 &
    elif command -v pw-play >/dev/null 2>&1; then pw-play "$f" >/dev/null 2>&1 &
    elif command -v canberra-gtk-play >/dev/null 2>&1; then canberra-gtk-play -f "$f" >/dev/null 2>&1 &
    fi
}

warned=0

while true; do
    lvl=$(cat "$BAT/capacity" 2>/dev/null)
    status=$(cat "$BAT/status" 2>/dev/null)

    if [ "$status" = "Discharging" ] && [ -n "$lvl" ]; then
        # Critical: give a final notice, let it reach the user, then suspend.
        if [ "$lvl" -le "$SUSPEND_LEVEL" ]; then
            notify-send -u critical "Battery Critical" "Level: ${lvl}% — suspending to protect your work."
            play_sound "$CRIT_SOUND"
            sleep 5
            systemctl suspend
            sleep "$POLL"
            continue
        fi

        # Low: warn once per discharge episode.
        if [ "$lvl" -le "$WARN_LEVEL" ] && [ "$warned" -eq 0 ]; then
            notify-send -u critical "Battery Low" "Level: ${lvl}% — plug in soon (auto-suspend at ${SUSPEND_LEVEL}%)."
            play_sound "$WARN_SOUND"
            warned=1
        fi
    else
        # Charging / full / plugged: re-arm the warning.
        warned=0
    fi

    sleep "$POLL"
done
