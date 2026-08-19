#!/usr/bin/env bash
# Waybar module: Tailscale status.
# text = VPN/mesh icon; class on/off drives color; tooltip shows self IP + peers.
set -uo pipefail

if ! command -v tailscale >/dev/null 2>&1; then
  printf '{"text":"\uf0e8","tooltip":"tailscale not installed","class":"off"}\n'
  exit 0
fi

# `tailscale status` exits non-zero when the backend is stopped/logged out.
if status="$(timeout 6 tailscale status 2>/dev/null)"; then
  self="$(tailscale ip -4 2>/dev/null | head -1)"
  # Count online peers (lines whose status field is "active"/"idle", excluding self).
  peers="$(printf '%s\n' "$status" | grep -cE '^100\.' 2>/dev/null || echo 0)"
  peers=$(( peers > 0 ? peers - 1 : 0 ))
  printf '{"text":"\uf0e8","tooltip":"Tailscale: up  (%s, %s peers)","class":"on"}\n' "${self:-?}" "$peers"
else
  printf '{"text":"\uf0e8","tooltip":"Tailscale: down","class":"off"}\n'
fi
