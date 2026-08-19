#!/usr/bin/env bash
set -euo pipefail

read -r cast sunshine < <(python3 - <<'PY'
import xml.etree.ElementTree as ET
root = ET.parse('/etc/firewalld/zones/public.xml').getroot()
services = {node.get('name') for node in root.findall('service')}
ports = {(node.get('port'), node.get('protocol')) for node in root.findall('port')}
rich_ports = {port.get('port') for rule in root.findall('rule') if (port := rule.find('port')) is not None}
cast = 'on' if 'mdns' in services or ('8010', 'tcp') in ports else 'off'
sunshine = 'on' if rich_ports & {'47984', '47989', '47990', '47998', '47999', '48000', '48002', '48010'} else 'off'
print(cast, sunshine)
PY
)

choice=$(printf '%s\n' \
  "Chromecast [$cast] — mDNS + VLC port 8010" \
  "Sunshine/Moonlight [$sunshine] — LAN game-streaming ports" \
  | fuzzel --dmenu --prompt='Firewall: ' --width=62 --lines=2)

case "$choice" in
  Chromecast*) group=chromecast; state=$cast ;;
  Sunshine*) group=sunshine; state=$sunshine ;;
  *) exit 0 ;;
esac

next=on
[[ $state == on ]] && next=off
pkexec "$(dirname "$(readlink -f "$0")")/firewall_toggle.sh" "$group" "$next"
