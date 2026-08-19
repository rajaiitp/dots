#!/usr/bin/env bash
# Volume/mute OSD via dunst. Adjusts the default sink, then shows a single
# replacing notification with a progress bar (dunst renders the int:value hint
# as a bar). Usage: volume_osd.sh up|down|mute
set -euo pipefail

SINK="@DEFAULT_AUDIO_SINK@"
STEP="5%"

case "${1:-}" in
    up)   wpctl set-mute "$SINK" 0; wpctl set-volume -l 1.0 "$SINK" "${STEP}+" ;;
    down) wpctl set-mute "$SINK" 0; wpctl set-volume -l 1.0 "$SINK" "${STEP}-" ;;
    mute) wpctl set-mute "$SINK" toggle ;;
    *)    echo "usage: $0 up|down|mute" >&2; exit 1 ;;
esac

# Query resulting state. `wpctl get-volume` -> "Volume: 0.45 [MUTED]"
read -r _ vol state < <(wpctl get-volume "$SINK")
pct=$(awk -v v="$vol" 'BEGIN{printf "%d", v*100 + 0.5}')

if [[ "${state:-}" == "[MUTED]" ]]; then
    icon="audio-volume-muted-symbolic"
    body="󰝟  Muted"
    bar=0
else
    if   (( pct == 0 )); then icon="audio-volume-muted-symbolic"; glyph="󰝟"
    elif (( pct < 34 )); then icon="audio-volume-low-symbolic";    glyph="󰕿"
    elif (( pct < 67 )); then icon="audio-volume-medium-symbolic"; glyph="󰖀"
    else                      icon="audio-volume-high-symbolic";   glyph="󰕾"; fi
    body="$glyph  ${pct}%"
    bar=$pct
fi

dunstify -a volume_osd -u low -i "$icon" \
    -h "string:x-dunst-stack-tag:volume_osd" \
    -h "int:value:${bar}" \
    "Volume" "$body"
