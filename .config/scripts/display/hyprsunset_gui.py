#!/usr/bin/env python3
"""Compact GTK4 status/control popup for the Hyprsunset smooth ramp."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import gi

gi.require_version("Gdk", "4.0")
gi.require_version("Gtk", "4.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

SERVICE = "hyprsunset-ramp.service"
RUNTIME_DIR = Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}"))
STATUS_FILE = RUNTIME_DIR / "hyprsunset-ramp.status"
OVERRIDE_FILE = RUNTIME_DIR / "hyprsunset-ramp.override"
OVERRIDE_MIN = 2500
OVERRIDE_MAX = 6500
CSS = b"""
window { background: #1e1e2e; color: #cdd6f4; border: 1px solid #45475a; }
.popup { padding: 14px; }
.heading { font-size: 18px; font-weight: 800; }
.subheading { color: #a6adc8; font-size: 13px; }
.detail { color: #6c7086; font-size: 12px; }
.temperature-value { min-width: 58px; color: #f9e2af; font-weight: 700; }
scale trough { min-height: 6px; border-radius: 3px; background: #45475a; }
scale highlight { min-height: 6px; border-radius: 3px; background: #f9e2af; }
scale slider { min-width: 16px; min-height: 16px; border-radius: 8px; background: #cdd6f4; }
button { min-height: 34px; background: #313244; color: #cdd6f4; }
button:hover { background: #45475a; }
"""


def service_active() -> bool:
    return subprocess.run(
        ["systemctl", "--user", "is-active", "--quiet", SERVICE], check=False
    ).returncode == 0


def current_temperature() -> str:
    try:
        return STATUS_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return "?"


def override_temperature() -> int | None:
    try:
        value = int(OVERRIDE_FILE.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None
    return value if OVERRIDE_MIN <= value <= OVERRIDE_MAX else None


def set_override_temperature(value: int) -> None:
    value = max(OVERRIDE_MIN, min(OVERRIDE_MAX, round(value / 100) * 100))
    OVERRIDE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = OVERRIDE_FILE.with_name(f"{OVERRIDE_FILE.name}.tmp-{os.getpid()}")
    temporary.write_text(f"{value}\n", encoding="utf-8")
    temporary.replace(OVERRIDE_FILE)
    subprocess.run(
        ["hyprctl", "hyprsunset", "temperature", str(value)],
        check=False,
        timeout=5,
    )
    STATUS_FILE.write_text(f"{value}\n", encoding="utf-8")


def clear_override() -> None:
    try:
        OVERRIDE_FILE.unlink()
    except FileNotFoundError:
        pass


class HyprsunsetPopup(Gtk.ApplicationWindow):
    def __init__(self, app: Gtk.Application) -> None:
        super().__init__(application=app, title="Hyprsunset")
        self.set_default_size(350, -1)
        self.set_resizable(False)
        self.set_decorated(False)
        self._had_focus = False
        self._dismiss_armed = False
        self._focus_loss_source = 0
        self._override_timer = 0
        self._updating_temperature = False
        self.connect("notify::is-active", self._on_focus_changed)
        GLib.timeout_add(500, self._arm_dismissal)
        self._build()

    def _build(self) -> None:
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        root.add_css_class("popup")
        self.set_child(root)

        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        title = Gtk.Label(label="Hyprsunset", xalign=0, hexpand=True)
        title.add_css_class("heading")
        header.append(title)
        restart = Gtk.Button(label="Resume automatic ramp")
        restart.connect("clicked", self._restart)
        header.append(restart)
        root.append(header)

        temperature_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        self.temperature_scale = Gtk.Scale.new_with_range(
            Gtk.Orientation.HORIZONTAL, OVERRIDE_MIN, OVERRIDE_MAX, 100
        )
        self.temperature_scale.set_draw_value(False)
        self.temperature_scale.set_hexpand(True)
        self.temperature_scale.set_tooltip_text("Override the automatic temperature ramp")
        self.temperature_scale.connect("value-changed", self._on_temperature_changed)
        temperature_row.append(self.temperature_scale)
        self.temperature_value = Gtk.Label(label="? K")
        self.temperature_value.add_css_class("temperature-value")
        temperature_row.append(self.temperature_value)
        root.append(temperature_row)

        self._refresh()

    def _refresh(self) -> None:
        temperature = current_temperature()
        override = override_temperature()

        try:
            value = override if override is not None else int(temperature)
        except ValueError:
            value = 4500
        value = max(OVERRIDE_MIN, min(OVERRIDE_MAX, round(value / 100) * 100))
        self._updating_temperature = True
        self.temperature_scale.set_value(value)
        self.temperature_value.set_label(f"{value} K")
        self._updating_temperature = False

    def _restart(self, _button: Gtk.Button) -> None:
        clear_override()
        subprocess.Popen(["systemctl", "--user", "restart", SERVICE], start_new_session=True)
        GLib.timeout_add(500, self._refresh_once)

    def _on_temperature_changed(self, scale: Gtk.Scale) -> None:
        if self._updating_temperature:
            return
        value = round(scale.get_value() / 100) * 100
        self.temperature_value.set_label(f"{value} K")
        if self._override_timer:
            GLib.source_remove(self._override_timer)
        self._override_timer = GLib.timeout_add(150, self._commit_temperature, value)

    def _commit_temperature(self, value: int) -> bool:
        self._override_timer = 0
        try:
            set_override_temperature(value)
        except (OSError, subprocess.SubprocessError) as error:
            self.temperature_value.set_tooltip_text(f"Temperature change failed: {error}")
        else:
            self._refresh()
        return GLib.SOURCE_REMOVE

    def _refresh_once(self) -> bool:
        self._refresh()
        return GLib.SOURCE_REMOVE

    def _arm_dismissal(self) -> bool:
        self._dismiss_armed = True
        if self._had_focus and not self.is_active():
            self.close()
        return GLib.SOURCE_REMOVE

    def _on_focus_changed(self, window: Gtk.Window, *_: object) -> None:
        if window.is_active():
            self._had_focus = True
            if self._focus_loss_source:
                GLib.source_remove(self._focus_loss_source)
                self._focus_loss_source = 0
        elif self._had_focus and self._dismiss_armed and not self._focus_loss_source:
            self._focus_loss_source = GLib.timeout_add(250, self._close_if_still_inactive)

    def _close_if_still_inactive(self) -> bool:
        self._focus_loss_source = 0
        if self._had_focus and not self.is_active():
            self.close()
        return GLib.SOURCE_REMOVE


class HyprsunsetApp(Gtk.Application):
    def __init__(self) -> None:
        super().__init__(application_id="com.raja.HyprsunsetPopup")

    def do_activate(self) -> None:
        window = self.props.active_window or HyprsunsetPopup(self)
        window.present()


if __name__ == "__main__":
    provider = Gtk.CssProvider()
    provider.load_from_data(CSS)
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
    )
    raise SystemExit(HyprsunsetApp().run(None))
