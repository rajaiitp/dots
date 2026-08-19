#!/usr/bin/env bash
# Waybar status for the smooth Hyprsunset ramp service.
set -u

runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$UID}"
state_file="$runtime_dir/hyprsunset-ramp.status"
override_file="$runtime_dir/hyprsunset-ramp.override"
if systemctl --user is-active --quiet hyprsunset-ramp.service; then
    temp=$(cat "$state_file" 2>/dev/null || printf '?')
    if [[ -s "$override_file" ]]; then
        printf '{"text":"󰖨","class":"override","tooltip":"Hyprsunset — %s K"}\n' "$temp"
    else
        printf '{"text":"󰖨","class":"on","tooltip":"Hyprsunset — %s K"}\n' "$temp"
    fi
else
    printf '%s\n' '{"text":"󰖨","class":"off","tooltip":"Hyprsunset off"}'
fi
