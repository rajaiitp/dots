#!/usr/bin/env python3
"""Compact GTK4 popup for managed firewalld feature groups."""

from __future__ import annotations

import os
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import gi

gi.require_version("Gdk", "4.0")
gi.require_version("Gtk", "4.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

ZONE = "public"
ZONE_FILE = Path(f"/etc/firewalld/zones/{ZONE}.xml")
TOGGLE_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "firewall_toggle.sh")
SUNSHINE_PORTS = {"47984", "47989", "47990", "47998", "47999", "48000", "48002", "48010"}
CSS = b"""
window { background: #1e1e2e; color: #cdd6f4; border: 1px solid #45475a; }
.popup { padding: 14px; }
.heading { font-size: 18px; font-weight: 800; }
.subheading { color: #6c7086; font-size: 12px; }
.feature { min-height: 48px; padding: 0 10px; background: #313244; color: #cdd6f4; }
.feature:hover { background: #45475a; }
.feature-name { font-weight: 700; }
.state { min-width: 46px; font-weight: 800; }
.state.on { color: #a6e3a1; }
.state.off { color: #6c7086; }
"""


def firewall_states() -> tuple[bool, bool]:
    root = ET.parse(ZONE_FILE).getroot()
    services = {node.get("name") for node in root.findall("service")}
    ports = {(node.get("port"), node.get("protocol")) for node in root.findall("port")}
    rich_ports = {
        port.get("port")
        for rule in root.findall("rule")
        if (port := rule.find("port")) is not None
    }
    cast = "mdns" in services or ("8010", "tcp") in ports
    sunshine = bool(rich_ports & SUNSHINE_PORTS)
    return cast, sunshine


class FirewallPopup(Gtk.ApplicationWindow):
    def __init__(self, app: Gtk.Application) -> None:
        super().__init__(application=app, title="Firewall Controls")
        self.set_default_size(350, -1)
        self.set_resizable(False)
        self.set_decorated(False)
        self._had_focus = False
        self._dismiss_armed = False
        self.connect("notify::is-active", self._on_focus_changed)
        GLib.timeout_add(500, self._arm_dismissal)
        self._build()

    def _build(self) -> None:
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        root.add_css_class("popup")
        self.set_child(root)

        title = Gtk.Label(label="Firewall", xalign=0)
        title.add_css_class("heading")
        root.append(title)
        subtitle = Gtk.Label(label=f"Managed access · {ZONE} zone", xalign=0)
        subtitle.add_css_class("subheading")
        root.append(subtitle)

        try:
            cast, sunshine = firewall_states()
        except (OSError, ET.ParseError) as error:
            label = Gtk.Label(label=str(error), xalign=0, wrap=True)
            label.add_css_class("subheading")
            root.append(label)
            return

        root.append(self._feature_button("Chromecast", "chromecast", cast))
        root.append(self._feature_button("Sunshine / Moonlight", "sunshine", sunshine))

    def _feature_button(self, label: str, group: str, enabled: bool) -> Gtk.Button:
        button = Gtk.Button()
        button.add_css_class("feature")
        row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        name = Gtk.Label(label=label, xalign=0, hexpand=True)
        name.add_css_class("feature-name")
        state = Gtk.Label(label="ON" if enabled else "OFF")
        state.add_css_class("state")
        state.add_css_class("on" if enabled else "off")
        row.append(name)
        row.append(state)
        button.set_child(row)
        button.set_tooltip_text(f"Turn {label} {'off' if enabled else 'on'}")
        button.connect("clicked", self._toggle, group, enabled)
        return button

    def _toggle(self, _button: Gtk.Button, group: str, enabled: bool) -> None:
        target = "off" if enabled else "on"
        environment = os.environ.copy()
        # Waybar inherited /usr/bin/fish as SHELL, but it is not listed in
        # /etc/shells; pkexec rejects the request before showing authentication.
        environment["SHELL"] = "/bin/sh"
        subprocess.Popen(
            [
                "/bin/sh", "-c",
                'if pkexec "$1" "$2" "$3"; then '
                'notify-send -t 1800 "Firewall" "$4 $3"; '
                'pkill -SIGUSR2 waybar 2>/dev/null || true; '
                'else notify-send -t 2200 "Firewall" "Change cancelled or failed"; fi',
                "firewall-popup", TOGGLE_SCRIPT, group, target,
                "Chromecast" if group == "chromecast" else "Sunshine / Moonlight",
            ],
            env=environment,
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.close()

    def _arm_dismissal(self) -> bool:
        self._dismiss_armed = True
        if self._had_focus and not self.is_active():
            self.close()
        return GLib.SOURCE_REMOVE

    def _on_focus_changed(self, window: Gtk.Window, *_: Any) -> None:
        if window.is_active():
            self._had_focus = True
        elif self._had_focus and self._dismiss_armed:
            window.close()


class FirewallApp(Gtk.Application):
    def __init__(self) -> None:
        super().__init__(application_id="com.raja.FirewallPopup")

    def do_activate(self) -> None:
        window = self.props.active_window or FirewallPopup(self)
        window.present()


if __name__ == "__main__":
    provider = Gtk.CssProvider()
    provider.load_from_data(CSS)
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    )
    raise SystemExit(FirewallApp().run(None))
