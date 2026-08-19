#!/usr/bin/env bash
# ============================================================================
# audio_sink_toggle.sh — pick the audio output device (sink)
# ============================================================================
# Click the taskbar volume icon to choose from ALL available output streams
# (internal speaker, connected HDMI, Bluetooth, USB DACs, …). Sets it as the
# default sink and moves every currently-playing stream onto it.
#
# Usage:
#   audio_sink_toggle.sh            -> fuzzel menu of available sinks
#   audio_sink_toggle.sh next       -> cycle to the next available sink
#   audio_sink_toggle.sh <name|id>  -> switch directly to that sink
# ============================================================================

set -uo pipefail

# Available sinks only: drop HDMI/DP outputs whose port has no display attached
# (they show up but can't actually play). A sink is kept if ANY of its ports is
# "available", or if it has no port availability info (e.g. speaker/BT/USB).
available_sinks_json() {
    pactl -f json list sinks 2>/dev/null | jq -c '
        [ .[]
          | select(
              ([.ports[]?.availability] | length) == 0
              or ([.ports[]?.availability] | index("available"))
              or (.name | test("HDMI") | not)
            )
        ]'
}

switch_to() {
    local target="$1" label="$2"
    [[ -z "$target" || "$target" == "null" ]] && { notify-send -t 1500 "Audio" "Sink not found"; exit 1; }
    pactl set-default-sink "$target"
    # Move existing playback streams to the new sink.
    local input
    for input in $(pactl list short sink-inputs 2>/dev/null | awk '{print $1}'); do
        [[ -n "$input" ]] && pactl move-sink-input "$input" "$target" 2>/dev/null || true
    done
    notify-send -t 1500 "󰓃 Audio output" "$label" 2>/dev/null || true
}

desc_for() { available_sinks_json | jq -r --arg n "$1" '.[] | select(.name==$n) | .description'; }

# ---- direct / cycle -------------------------------------------------------
if [[ $# -ge 1 && "$1" != "menu" ]]; then
    if [[ "$1" == "next" ]]; then
        cur=$(pactl get-default-sink 2>/dev/null || echo "")
        mapfile -t names < <(available_sinks_json | jq -r '.[].name')
        [[ ${#names[@]} -eq 0 ]] && exit 0
        idx=0
        for i in "${!names[@]}"; do [[ "${names[$i]}" == "$cur" ]] && idx=$i; done
        next="${names[$(( (idx + 1) % ${#names[@]} ))]}"
        switch_to "$next" "$(desc_for "$next")"
        exit 0
    fi
    # Treat the arg as a sink name (or index).
    switch_to "$1" "$(desc_for "$1")"
    exit 0
fi

# ---- interactive menu ------------------------------------------------------
cur=$(pactl get-default-sink 2>/dev/null || echo "")
# Build "description" lines, marking the current default with ●.
menu=$(available_sinks_json | jq -r --arg cur "$cur" '
    .[] | (if .name==$cur then "● " else "  " end) + .description')

[[ -z "$menu" ]] && { notify-send "Audio" "No output devices"; exit 0; }

count=$(printf '%s\n' "$menu" | wc -l)
choice=$(printf '%s\n' "$menu" \
    | fuzzel --dmenu --prompt "Audio out: " --lines "$count" --width 42 \
    | sed -E 's/^[●[:space:]]+//')

[[ -z "$choice" ]] && exit 0

# Map the chosen description back to a sink name.
target=$(available_sinks_json | jq -r --arg d "$choice" '.[] | select(.description==$d) | .name' | head -n1)
switch_to "$target" "$choice"
