#!/usr/bin/env python3
"""Compact GTK4 popup for Hyprland display modes and resolutions."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

import gi

gi.require_version("Gdk", "4.0")
gi.require_version("Gtk", "4.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

LAPTOP = "eDP-1"
MODE_FILE = Path("/tmp/display-mode")
MODE_SCRIPT = os.path.expanduser("~/.config/hypr/scripts/display_mode.sh")
RESOLUTION_SCRIPT = os.path.expanduser("~/.config/hypr/scripts/resolution.sh")
WHITELIST = ["3840x2160", "2560x1440", "1920x1200", "1920x1080", "1600x1200", "1280x800", "1280x720"]
CSS = b"""
window { background: #1e1e2e; color: #cdd6f4; border: 1px solid #45475a; }
.popup { padding: 14px; }
.heading { font-size: 18px; font-weight: 800; }
.mode { min-height: 34px; background: #313244; color: #cdd6f4; }
.mode:hover { background: #45475a; }
.mode.active { background: #45475a; color: #94e2d5; }
dropdown button { min-height: 34px; background: #313244; color: #cdd6f4; }
"""


def command_json(*args: str) -> Any:
    result = subprocess.run(args, capture_output=True, text=True, timeout=4, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "Command failed")
    return json.loads(result.stdout)


def monitor_data() -> list[dict[str, Any]]:
    active = {item["name"]: item for item in command_json("hyprctl", "monitors", "-j")}
    monitors = command_json("hyprctl", "monitors", "all", "-j")
    for monitor in monitors:
        monitor["active"] = monitor["name"] in active
        if monitor["active"]:
            monitor["current"] = active[monitor["name"]]
    monitors.sort(key=lambda item: item["name"] == LAPTOP)
    return monitors


def useful_modes(monitor: dict[str, Any]) -> list[str]:
    choices: dict[str, list[int]] = {}
    for raw in monitor.get("availableModes") or []:
        try:
            resolution, refresh = raw.split("@", 1)
            hz = int(float(refresh.removesuffix("Hz")))
        except (ValueError, AttributeError):
            continue
        if resolution in WHITELIST:
            choices.setdefault(resolution, []).append(hz)
    if monitor["name"] != LAPTOP:
        choices.setdefault("2560x1440", []).append(60)

    modes: list[str] = []
    for resolution in WHITELIST:
        rates = choices.get(resolution)
        if not rates:
            continue
        rate = 60 if 60 in rates else max(rates)
        modes.append(f"{resolution}@{rate}")
    return modes


class DisplayPopup(Gtk.ApplicationWindow):
    def __init__(self, app: Gtk.Application) -> None:
        super().__init__(application=app, title="Display Controls")
        self.set_default_size(350, -1)
        self.set_resizable(False)
        self.set_decorated(False)
        self._had_focus = False
        self._dismiss_armed = False
        self._focus_loss_source = 0
        self.monitors: list[dict[str, Any]] = []
        self.resolution_picker = Gtk.DropDown.new_from_strings([])
        self._populating_resolution = False
        self.connect("notify::is-active", self._on_focus_changed)
        GLib.timeout_add(500, self._arm_dismissal)
        self._build()

    def _build(self) -> None:
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        root.add_css_class("popup")
        self.set_child(root)

        try:
            self.monitors = monitor_data()
        except (OSError, RuntimeError, json.JSONDecodeError) as error:
            title = Gtk.Label(label="Display", xalign=0)
            title.add_css_class("heading")
            root.append(title)
            root.append(Gtk.Label(label=str(error), xalign=0, wrap=True))
            return

        current_mode = MODE_FILE.read_text().strip() if MODE_FILE.exists() else "auto"
        external = any(item["name"] != LAPTOP for item in self.monitors)
        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        title = Gtk.Label(label="Display", xalign=0, hexpand=True)
        title.add_css_class("heading")
        header.append(title)

        mode_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6)
        for key, label in (("auto", "Auto"), ("laptop", "Laptop"), ("hdmi", "HDMI")):
            button = Gtk.Button(label=label, hexpand=True)
            button.add_css_class("mode")
            if key == current_mode:
                button.add_css_class("active")
            if key == "hdmi" and not external:
                button.set_sensitive(False)
            button.connect("clicked", self._set_display_mode, key)
            mode_row.append(button)
        header.append(mode_row)
        root.append(header)

        names = [
            ("HDMI · " if item["name"] != LAPTOP else "Laptop · ") + item["name"]
            for item in self.monitors
        ]
        self.output_picker = Gtk.DropDown.new_from_strings(names)
        self.output_picker.connect("notify::selected", self._output_changed)
        root.append(self.output_picker)

        self.resolution_picker.connect("notify::selected", self._resolution_changed)
        root.append(self.resolution_picker)
        self._populate_modes(0)

    def _populate_modes(self, index: int) -> None:
        if not self.monitors or index >= len(self.monitors):
            return
        monitor = self.monitors[index]
        modes = useful_modes(monitor)
        current = monitor.get("current") or {}
        current_mode = f"{current.get('width')}x{current.get('height')}@{int(current.get('refreshRate', 0))}"

        self._populating_resolution = True
        self.resolution_picker.set_model(Gtk.StringList.new(modes))
        self.resolution_picker.set_selected(modes.index(current_mode) if current_mode in modes else 0)
        self._populating_resolution = False

    def _output_changed(self, picker: Gtk.DropDown, *_: Any) -> None:
        self._populate_modes(picker.get_selected())

    def _resolution_changed(self, picker: Gtk.DropDown, *_: Any) -> None:
        if self._populating_resolution:
            return
        output_index = self.output_picker.get_selected()
        if not self.monitors or output_index >= len(self.monitors):
            return
        monitor = self.monitors[output_index]
        modes = useful_modes(monitor)
        selected = picker.get_selected()
        if selected >= len(modes):
            return
        target = "laptop" if monitor["name"] == LAPTOP else "hdmi"
        self._launch(RESOLUTION_SCRIPT, target, modes[selected])

    def _launch(self, *args: str) -> None:
        subprocess.Popen(
            args,
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self.close()

    def _set_display_mode(self, _button: Gtk.Button, mode: str) -> None:
        self._launch(MODE_SCRIPT, mode)

    def _set_resolution(self, _button: Gtk.Button, target: str, mode: str) -> None:
        self._launch(RESOLUTION_SCRIPT, target, mode)

    def _arm_dismissal(self) -> bool:
        self._dismiss_armed = True
        if self._had_focus and not self.is_active():
            self.close()
        return GLib.SOURCE_REMOVE

    def _on_focus_changed(self, window: Gtk.Window, *_: Any) -> None:
        if window.is_active():
            self._had_focus = True
            if self._focus_loss_source:
                GLib.source_remove(self._focus_loss_source)
                self._focus_loss_source = 0
        elif self._had_focus and self._dismiss_armed and not self._focus_loss_source:
            # Gtk.DropDown briefly transfers focus to its Wayland popup. Delay
            # dismissal so that transient focus hand-off does not close this
            # window, while a genuine click outside still dismisses it.
            self._focus_loss_source = GLib.timeout_add(250, self._close_if_still_inactive)

    def _close_if_still_inactive(self) -> bool:
        self._focus_loss_source = 0
        if self._had_focus and not self.is_active():
            self.close()
        return GLib.SOURCE_REMOVE


class DisplayApp(Gtk.Application):
    def __init__(self) -> None:
        super().__init__(application_id="com.raja.DisplayPopup")

    def do_activate(self) -> None:
        window = self.props.active_window or DisplayPopup(self)
        window.present()


if __name__ == "__main__":
    provider = Gtk.CssProvider()
    provider.load_from_data(CSS)
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    )
    raise SystemExit(DisplayApp().run(None))
