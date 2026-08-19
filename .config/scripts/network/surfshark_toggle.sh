#!/usr/bin/env bash
# Waybar left-click:
#   connected    -> disconnect
#   disconnected -> connect to the LAST chosen location
#                   (if none saved yet, open the fuzzel picker)
set -uo pipefail

DIR="$(dirname "$(readlink -f "$0")")"
LAST="$HOME/.cache/surfshark_last.tsv"
notify() { notify-send -a Surfshark "Surfshark VPN" "$1" ${2:+-u "$2"} -t "${3:-2800}"; }

if pgrep -f 'surfshark.*\.ovpn' >/dev/null 2>&1; then
  notify "Disconnecting…" "" 2000
  sudo -n surfshark-vpn down >/dev/null 2>&1
  sudo -n pkill -x openvpn >/dev/null 2>&1   # fallback: down can miss a stale tunnel
  rm -f "$HOME/.cache/surfshark_ip"
  notify "Disconnected."
  exit 0
fi

if [ -s "$LAST" ]; then
  idx="$(cut -f1 "$LAST")"; label="$(cut -f2 "$LAST")"
  exec "$DIR/surfshark_connect.sh" "$idx" "$label"
else
  notify "No saved location yet — pick one" "" 2500
  exec "$DIR/surfshark_menu.sh"
fi
