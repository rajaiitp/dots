#!/usr/bin/env bash
# Connect Surfshark to a location by wizard index, driving the interactive wizard
# with expect (spawns `sudo -n surfshark-vpn`, passwordless via sudoers rule).
# Saves the choice to ~/.cache/surfshark_last.tsv so left-click can reconnect.
#   usage: surfshark_connect.sh <index> [label]
set -uo pipefail

idx="${1:-}"; label="${2:-#$idx}"
LAST="$HOME/.cache/surfshark_last.tsv"
IP_CACHE="$HOME/.cache/surfshark_ip"
notify() { notify-send -a Surfshark "Surfshark VPN" "$1" ${2:+-u "$2"} -t "${3:-2800}"; }

[ -z "$idx" ] && { notify "No location index given" critical 4000; exit 1; }

notify "Connecting to ${label}…"
sudo -n surfshark-vpn down >/dev/null 2>&1
sudo -n pkill -x openvpn >/dev/null 2>&1   # ensure a clean slate before reconnecting
rm -f "$IP_CACHE"
sleep 1

expect -c "
  set timeout 45
  spawn sudo -n surfshark-vpn
  expect {
    -re \"press enter for next page\"             { send \"\r\"; exp_continue }
    -re \"Enter a number to select the location\" { send \"$idx\r\"; exp_continue }
    -re \"select the VPN connection type\"        { send \"\r\"; exp_continue }
    -re \"Connected to Surfshark\"                { exit 0 }
    -re \"VPN process is running\"                 { exit 0 }
    timeout                                        { exit 1 }
    eof                                            { exit 0 }
  }
" >/dev/null 2>&1

sleep 2
if pgrep -f 'surfshark.*\.ovpn' >/dev/null 2>&1; then
  mkdir -p "$(dirname "$LAST")"
  printf '%s\t%s\n' "$idx" "$label" > "$LAST"
  # Fetch the public exit IP once and cache it for the status tooltip.
  ip="$(timeout 4 curl -s https://ipinfo.io/ip 2>/dev/null | tr -d '[:space:]')"
  [ -n "$ip" ] && printf '%s\n' "$ip" > "$IP_CACHE"
  notify "Connected: ${label}${ip:+  ($ip)}" "" 3200
else
  notify "Connect to ${label} may have failed" critical 4000
fi
