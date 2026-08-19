#!/usr/bin/env bash
set -euo pipefail

zone=public
lan=192.168.178.0/24
fw=/usr/bin/firewall-cmd

sunshine_rules=(
  "rule family=ipv4 source address=$lan port port=47984 protocol=tcp accept"
  "rule family=ipv4 source address=$lan port port=47989 protocol=tcp accept"
  "rule family=ipv4 source address=$lan port port=47990 protocol=tcp accept"
  "rule family=ipv4 source address=$lan port port=48010 protocol=tcp accept"
  "rule family=ipv4 source address=$lan port port=47998 protocol=udp accept"
  "rule family=ipv4 source address=$lan port port=47999 protocol=udp accept"
  "rule family=ipv4 source address=$lan port port=48000 protocol=udp accept"
  "rule family=ipv4 source address=$lan port port=48002 protocol=udp accept"
  "rule family=ipv4 source address=$lan port port=48010 protocol=udp accept"
  "rule family=ipv4 source address=$lan port port=48000 protocol=tcp accept"
)

[[ $# == 2 && $2 =~ ^(on|off)$ ]] || { echo "usage: $0 {chromecast|sunshine} {on|off}" >&2; exit 2; }

set_service() {
  local service=$1 state=$2
  if [[ $state == on ]]; then
    "$fw" --permanent --zone="$zone" --query-service="$service" >/dev/null ||
      "$fw" --permanent --zone="$zone" --add-service="$service"
  else
    "$fw" --permanent --zone="$zone" --query-service="$service" >/dev/null &&
      "$fw" --permanent --zone="$zone" --remove-service="$service" || true
  fi
}

set_port() {
  local port=$1 state=$2
  if [[ $state == on ]]; then
    "$fw" --permanent --zone="$zone" --query-port="$port" >/dev/null ||
      "$fw" --permanent --zone="$zone" --add-port="$port"
  else
    "$fw" --permanent --zone="$zone" --query-port="$port" >/dev/null &&
      "$fw" --permanent --zone="$zone" --remove-port="$port" || true
  fi
}

set_rule() {
  local rule=$1 state=$2
  if [[ $state == on ]]; then
    "$fw" --permanent --zone="$zone" --query-rich-rule="$rule" >/dev/null ||
      "$fw" --permanent --zone="$zone" --add-rich-rule="$rule"
  else
    "$fw" --permanent --zone="$zone" --query-rich-rule="$rule" >/dev/null &&
      "$fw" --permanent --zone="$zone" --remove-rich-rule="$rule" || true
  fi
}

case "$1" in
  chromecast)
    set_service mdns "$2"
    set_port 8010/tcp "$2"
    ;;
  sunshine)
    for rule in "${sunshine_rules[@]}"; do set_rule "$rule" "$2"; done
    ;;
  *) echo "unknown firewall group: $1" >&2; exit 2 ;;
esac

"$fw" --reload
