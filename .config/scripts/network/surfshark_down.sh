#!/usr/bin/env bash
# Disconnect Surfshark VPN (right-click on the waybar module). Runs in a small
# terminal since `surfshark-vpn down` may prompt for sudo to tear down OpenVPN.
set -uo pipefail

exec /home/raja/.local/bin/wezterm start --class surfshark-tui -- bash -lc '
  surfshark-vpn down
  sleep 1
'
