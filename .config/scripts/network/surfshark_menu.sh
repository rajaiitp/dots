#!/usr/bin/env bash
# Surfshark location picker via fuzzel (waybar right-click).
#
# The surfshark-vpn CLI (v1.1.0) has no "connect <location>" command — location
# selection is only via its interactive wizard. We drive that wizard with
# `expect`, exactly like the community wrapper: page through the list, then send
# the chosen index. `expect` spawns `sudo -n surfshark-vpn`, so it runs as the
# regular user and relies on the passwordless sudoers rule (/etc/sudoers.d/
# surfshark) — no password prompt, no popup.
set -uo pipefail

CACHE="$HOME/.cache/surfshark_locations.tsv"   # "<index>\t<Country City>"
DISCONNECT="󰩈  Disconnect VPN"

notify() { notify-send -a Surfshark "Surfshark VPN" "$1" ${2:+-u "$2"} -t "${3:-2800}"; }

connected() { surfshark-vpn status 2>/dev/null | grep -qiv "not connected" \
              && surfshark-vpn status 2>/dev/null | grep -qi "."; }

# ── Refresh the location cache (only when disconnected; keep old copy on fail) ──
refresh_cache() {
  local tmp; tmp="$(mktemp)"
  timeout 8 bash -c 'sudo -n surfshark-vpn < /dev/null 2>/dev/null' \
    | tr -d '\r' \
    | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g; s/press enter for next page//g' \
    | grep -oE '^[0-9]+ [A-Z].*[A-Za-z]' \
    | awk 'NF{ idx=$1; $1=""; sub(/^ /,""); print idx "\t" $0 }' \
    | sort -u -t$'\t' -k1,1n > "$tmp"
  if [ -s "$tmp" ]; then mkdir -p "$(dirname "$CACHE")"; mv "$tmp" "$CACHE"; else rm -f "$tmp"; fi
}

if [ ! -s "$CACHE" ] || [ -n "$(find "$CACHE" -mtime +7 2>/dev/null)" ]; then
  surfshark-vpn status 2>/dev/null | grep -qi "not connected" && refresh_cache
fi
[ -s "$CACHE" ] || { notify "Could not load location list" critical 4000; exit 1; }

# ── fuzzel picker (Disconnect first, then locations) ──
choice="$( { printf '%s\n' "$DISCONNECT"; cut -f2 "$CACHE"; } \
  | fuzzel --dmenu --prompt "Surfshark 󰒃  " --lines 15 --width 40 )"
[ -z "$choice" ] && exit 0

if [ "$choice" = "$DISCONNECT" ]; then
  notify "Disconnecting…" "" 2000
  sudo -n surfshark-vpn down >/dev/null 2>&1
  notify "Disconnected."
  exit 0
fi

idx="$(awk -F'\t' -v c="$choice" '$2==c{print $1; exit}' "$CACHE")"
[ -z "$idx" ] && { notify "Location not found: $choice" critical 4000; exit 1; }

# Connect (and remember as "last used") via the shared helper.
exec "$(dirname "$(readlink -f "$0")")/surfshark_connect.sh" "$idx" "$choice"
