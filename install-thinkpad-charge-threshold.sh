#!/usr/bin/env bash
# Install the ThinkPad 75–80% battery charge-limit service.
set -euo pipefail

if (( EUID != 0 )); then
  echo "Run this installer with sudo." >&2
  exit 1
fi

readonly source_file="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/thinkpad-charge-threshold.service"
readonly destination_file=/etc/systemd/system/thinkpad-charge-threshold.service

[[ -r $source_file ]] || {
  echo "Missing service file: $source_file" >&2
  exit 1
}
[[ -e /sys/class/power_supply/BAT0/charge_control_start_threshold ]] || {
  echo "BAT0 start-threshold control is unavailable; made no changes." >&2
  exit 1
}
[[ -e /sys/class/power_supply/BAT0/charge_control_end_threshold ]] || {
  echo "BAT0 end-threshold control is unavailable; made no changes." >&2
  exit 1
}

install -D -m 0644 "$source_file" "$destination_file"
systemctl daemon-reload
systemctl enable --now thinkpad-charge-threshold.service
systemctl is-active --quiet thinkpad-charge-threshold.service
printf 'Charge thresholds applied: start %s%%, stop %s%%.\n' \
  "$(< /sys/class/power_supply/BAT0/charge_control_start_threshold)" \
  "$(< /sys/class/power_supply/BAT0/charge_control_end_threshold)"
