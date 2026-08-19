#!/usr/bin/env bash
# Toggle Tailscale up/down from waybar. Requires the operator to be set once
# (`sudo tailscale set --operator=$USER`) so up/down need no sudo/password.
set -uo pipefail

if tailscale status >/dev/null 2>&1; then
  tailscale down
  notify-send -t 2000 "Tailscale" "Disconnected" 2>/dev/null || true
else
  if tailscale up 2>/tmp/ts-up.err; then
    notify-send -t 2000 "Tailscale" "Connected ($(tailscale ip -4 2>/dev/null | head -1))" 2>/dev/null || true
  else
    # up failed (often needs sudo if operator isn't set, or a login is required)
    notify-send -u critical -t 4000 "Tailscale" "up failed: $(head -c 160 /tmp/ts-up.err)" 2>/dev/null || true
  fi
fi
