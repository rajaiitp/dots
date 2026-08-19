#!/usr/bin/env python3
"""Compact GTK4 popup for selecting the PipeWire/PulseAudio output sink."""

from __future__ import annotations

import json
import os
import subprocess
from typing import Any

import gi

gi.require_version("Gdk", "4.0")
gi.require_version("Gtk", "4.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

SWITCH_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audio_sink_toggle.sh")
CSS = b"""
window { background: #1e1e2e; color: #cdd6f4; border: 1px solid #45475a; }
.popup { padding: 14px; }
.heading { font-size: 18px; font-weight: 800; }
.subheading { color: #6c7086; font-size: 12px; }
.sink { min-height: 42px; padding: 0 10px; background: #313244; color: #cdd6f4; }
.sink:hover { background: #45475a; }
.sink.active { background: #45475a; color: #94e2d5; }
.indicator { min-width: 18px; color: #6c7086; }
.indicator.active { color: #94e2d5; }
"""


def run(*args: str) -> str:
    result = subprocess.run(args, capture_output=True, text=True, timeout=4, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "Command failed")
    return result.stdout


def available_sinks() -> tuple[str, list[dict[str, Any]]]:
    default = run("pactl", "get-default-sink").strip()
    sinks = json.loads(run("pactl", "-f", "json", "list", "sinks"))
    available: list[dict[str, Any]] = []
    for sink in sinks:
        ports = sink.get("ports") or []
        has_available_port = any(port.get("availability") == "available" for port in ports)
        is_hdmi = "HDMI" in str(sink.get("name", "")).upper()
        if not ports or has_available_port or not is_hdmi:
            available.append(sink)
    available.sort(key=lambda item: item.get("name") != default)
    return default, available


class SoundPopup(Gtk.ApplicationWindow):
    def __init__(self, app: Gtk.Application) -> None:
        super().__init__(application=app, title="Sound Output")
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

        title = Gtk.Label(label="Sound output", xalign=0)
        title.add_css_class("heading")
        root.append(title)

        try:
            default, sinks = available_sinks()
        except (OSError, RuntimeError, json.JSONDecodeError) as error:
            label = Gtk.Label(label=str(error), xalign=0, wrap=True)
            label.add_css_class("subheading")
            root.append(label)
            return

        subtitle = Gtk.Label(label=f"{len(sinks)} available device{'s' if len(sinks) != 1 else ''}", xalign=0)
        subtitle.add_css_class("subheading")
        root.append(subtitle)

        for sink in sinks:
            name = str(sink.get("name", ""))
            description = str(sink.get("description") or name)
            active = name == default
            button = Gtk.Button()
            button.add_css_class("sink")
            if active:
                button.add_css_class("active")
            row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
            indicator = Gtk.Label(label="●" if active else "○")
            indicator.add_css_class("indicator")
            if active:
                indicator.add_css_class("active")
            label = Gtk.Label(label=description, xalign=0, hexpand=True, ellipsize=3)
            row.append(indicator)
            row.append(label)
            button.set_child(row)
            button.connect("clicked", self._select_sink, name)
            root.append(button)

    def _select_sink(self, _button: Gtk.Button, name: str) -> None:
        try:
            run(SWITCH_SCRIPT, name)
        except (OSError, RuntimeError) as error:
            dialog = Gtk.AlertDialog(message="Could not switch audio output", detail=str(error))
            dialog.show(self)
            return
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


class SoundApp(Gtk.Application):
    def __init__(self) -> None:
        super().__init__(application_id="com.raja.SoundSinkPopup")

    def do_activate(self) -> None:
        window = self.props.active_window or SoundPopup(self)
        window.present()


if __name__ == "__main__":
    provider = Gtk.CssProvider()
    provider.load_from_data(CSS)
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    )
    raise SystemExit(SoundApp().run(None))
