#!/usr/bin/env bash
# Emit waybar JSON showing the current default audio output (speaker vs HDMI).
default=$(pactl get-default-sink 2>/dev/null || echo "")
mute=$(pactl get-sink-mute @DEFAULT_SINK@ 2>/dev/null)

if [[ "$mute" == *"yes"* ]]; then
    icon="\U000f075f"   # nf-md-volume_mute (audio muted)
    text="Muted"
elif [[ "$default" == *"HDMI"* ]]; then
    icon="\uf26c"   # fa-television (audio out to TV/HDMI)
    text="HDMI audio"
else
    icon="\uf028"   # fa-volume-up (internal speaker)
    text="Speaker"
fi

printf '{"text":"%b","tooltip":"Audio output: %s"}\n' "$icon" "$text"
