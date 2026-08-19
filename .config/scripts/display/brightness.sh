#!/bin/sh

set -eu

display="eDP-1"

case "${1:-}" in
  up)
    hyprctl dispatch dpms on "$display" >/dev/null
    brightnessctl --min-value=0 set +5%
    ;;
  down)
    brightnessctl --min-value=0 set 5%-
    if [ "$(brightnessctl get)" -eq 0 ]; then
      hyprctl dispatch dpms off "$display" >/dev/null
    fi
    ;;
  *)
    echo "usage: $0 {up|down}" >&2
    exit 2
    ;;
esac
