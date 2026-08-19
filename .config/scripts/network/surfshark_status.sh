#!/usr/bin/env bash
# Waybar module: Surfshark VPN status.
# The surfshark-vpn CLI `status` is unreliable for a non-root user (it can't read
# the root-owned status file and wrongly reports "Not connected"). Instead we
# detect the live OpenVPN tunnel via its process cmdline, which a normal user CAN
# read and which also encodes the server (e.g. "nl-ams" -> Netherlands Amsterdam).
# text = lock icon; class on/off drives color; tooltip shows the location.
set -uo pipefail

# The surfshark openvpn process embeds the config path .../<code>.prod.surfshark…
line="$(pgrep -a -f 'surfshark.*\.ovpn' 2>/dev/null | grep -m1 openvpn || true)"

if [ -z "$line" ]; then
  printf '{"text":"\uf023","tooltip":"Surfshark VPN: off","class":"off"}\n'
  exit 0
fi

# Extract the server code (e.g. "nl-ams", "us-nyc") from the config filename.
code="$(printf '%s' "$line" | grep -oE '[a-z]{2}-[a-z]{2,4}' | head -1)"
[ -n "$code" ] || code="connected"

# Public exit IP, cached at connect time by surfshark_connect.sh.
ip="$(head -1 "$HOME/.cache/surfshark_ip" 2>/dev/null)"
ipline=""
[ -n "$ip" ] && ipline="\\nIP: ${ip}"

printf '{"text":"\uf023","tooltip":"Surfshark VPN: on (%s)%s","class":"on"}\n' "$code" "$ipline"
