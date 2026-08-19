#!/usr/bin/env python3
import json
import xml.etree.ElementTree as ET
from pathlib import Path

zone = "public"
path = Path(f"/etc/firewalld/zones/{zone}.xml")
if not path.exists():
    print(json.dumps({"text": "󰒃", "class": "off", "tooltip": "Firewall public zone is not configured"}))
    raise SystemExit

root = ET.parse(path).getroot()
services = {node.get("name") for node in root.findall("service")}
ports = {(node.get("port"), node.get("protocol")) for node in root.findall("port")}
rules = []
for rule in root.findall("rule"):
    source = rule.find("source")
    port = rule.find("port")
    if port is not None:
        rules.append((port.get("port"), port.get("protocol"), source.get("address") if source is not None else "any"))

sunshine_ports = {"47984", "47989", "47990", "47998", "47999", "48000", "48002", "48010"}
cast = "mdns" in services or ("8010", "tcp") in ports
sunshine = any(port in sunshine_ports for port, _, _ in rules)

lines = [f"Firewall zone: {zone}", "", "Protected/system entries:"]
if "dhcpv6-client" in services:
    lines.append("• 546/udp — DHCPv6 network configuration")
if "ssh" in services:
    lines.append("• 22/tcp — SSH remote shell")

lines += ["", "Managed custom entries:"]
if cast:
    if "mdns" in services:
        lines.append("• 5353/udp — mDNS device/Chromecast discovery")
    if ("8010", "tcp") in ports:
        lines.append("• 8010/tcp — VLC Chromecast media stream")
else:
    lines.append("• Chromecast — disabled")

sunshine_descriptions = {
    ("47984", "tcp"): "Sunshine HTTPS/GameStream",
    ("47989", "tcp"): "Sunshine HTTP/GameStream",
    ("47990", "tcp"): "Sunshine web UI",
    ("48010", "tcp"): "Sunshine RTSP",
    ("48010", "udp"): "Sunshine input/data",
    ("47998", "udp"): "Moonlight video",
    ("47999", "udp"): "Moonlight control",
    ("48000", "tcp"): "Moonlight data",
    ("48000", "udp"): "Moonlight audio",
    ("48002", "udp"): "Sunshine microphone channel",
}
if sunshine:
    for port, proto, source in sorted(rules, key=lambda item: (int(item[0]), item[1])):
        description = sunshine_descriptions.get((port, proto), "unclassified rich rule")
        lines.append(f"• {port}/{proto} — {description} ({source})")
else:
    lines.append("• Sunshine/Moonlight — disabled")

for service in sorted(services - {"dhcpv6-client", "ssh", "mdns"}):
    lines.append(f"• service:{service} — unclassified firewalld service")
for port, proto in sorted(ports - {("8010", "tcp")}):
    lines.append(f"• {port}/{proto} — unclassified explicit port")

lines += ["", "Click to enable/disable managed groups"]
print(json.dumps({
    "text": "󰒃",
    "class": "on" if cast or sunshine else "off",
    "tooltip": "\n".join(lines),
}))
