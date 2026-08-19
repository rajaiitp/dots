#!/usr/bin/env python3
"""Compact GTK4 controller for a single Google Cast speaker."""

from __future__ import annotations

import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

import gi

gi.require_version("Gdk", "4.0")
gi.require_version("Gtk", "4.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

DEVICE = os.environ.get("GOOGLE_HOME_DEVICE", "Bedroom speaker")
CATT = os.environ.get("CATT_BIN", os.path.expanduser("~/.local/bin/catt"))

CSS = b"""
window { background: #1e1e2e; color: #cdd6f4; border: 1px solid #45475a; }
.controller { padding: 14px; }
.device { font-size: 18px; font-weight: 800; }
.status { color: #6c7086; font-size: 12px; }
.status.online { color: #a6e3a1; }
.status.error { color: #f38ba8; }
.title { font-size: 15px; font-weight: 700; }
.time { color: #a6adc8; font-size: 11px; font-family: monospace; }
button { min-height: 30px; min-width: 34px; border-radius: 8px; background: #313244; color: #cdd6f4; }
button:hover { background: #45475a; }
button.play { min-height: 32px; min-width: 40px; border-radius: 16px; background: #cba6f7; color: #1e1e2e; font-size: 16px; }
button.play:hover { background: #b4befe; }
button.danger { color: #f38ba8; }
scale trough { min-height: 6px; border-radius: 3px; background: #45475a; }
scale highlight { min-height: 6px; border-radius: 3px; background: #cba6f7; }
scale slider { min-width: 16px; min-height: 16px; border-radius: 8px; background: #cdd6f4; }
.volume-value { min-width: 42px; color: #94e2d5; font-weight: 700; }
.separator { background: #313244; min-height: 1px; }
"""


def fmt_time(seconds: float) -> str:
    seconds = max(0, int(seconds or 0))
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


class ControllerWindow(Gtk.ApplicationWindow):
    def __init__(self, app: Gtk.Application) -> None:
        super().__init__(application=app, title="Google Home Controller")
        self.set_default_size(350, 195)
        self.set_resizable(False)
        self.set_decorated(False)
        self._had_focus = False
        self._dismiss_armed = False
        self._closed = False

        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="cast-control")
        self.online = False
        self.state = "UNKNOWN"
        self.duration = 0.0
        self.updating = False
        self.volume_timer = 0
        self.seek_timer = 0

        self._build_ui()
        self.connect("close-request", self._on_close)
        self.connect("notify::is-active", self._on_focus_changed)
        GLib.timeout_add(500, self._arm_focus_dismissal)
        GLib.timeout_add_seconds(4, self._periodic_refresh)
        self.refresh()

    def _build_ui(self) -> None:
        root = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10)
        root.add_css_class("controller")
        self.set_child(root)

        header = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8)
        name = Gtk.Label(label=DEVICE, xalign=0, hexpand=True)
        name.add_css_class("device")
        self.status_label = Gtk.Label(label="● Connecting…", xalign=1)
        self.status_label.add_css_class("status")
        header.append(name)
        header.append(self.status_label)
        root.append(header)

        self.title_label = Gtk.Label(label="Waiting for media status", xalign=0, ellipsize=3)
        self.title_label.add_css_class("title")
        root.append(self.title_label)

        seek_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        self.seek_scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 100, 1)
        self.seek_scale.set_draw_value(False)
        self.seek_scale.set_hexpand(True)
        self.seek_scale.set_sensitive(False)
        self.seek_scale.connect("value-changed", self._on_seek_changed)
        seek_row.append(self.seek_scale)
        self.elapsed_label = Gtk.Label(label="0:00", xalign=1)
        self.elapsed_label.add_css_class("time")
        seek_row.append(self.elapsed_label)
        root.append(seek_row)

        controls = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=10)
        self.play_button = self._button("▶", self._toggle, "Play or pause")
        self.play_button.add_css_class("play")
        controls.append(self.play_button)
        self.volume_scale = Gtk.Scale.new_with_range(Gtk.Orientation.HORIZONTAL, 0, 100, 1)
        self.volume_scale.set_draw_value(False)
        self.volume_scale.set_hexpand(True)
        self.volume_scale.connect("value-changed", self._on_volume_changed)
        controls.append(self.volume_scale)
        self.volume_label = Gtk.Label(label="0%")
        self.volume_label.add_css_class("volume-value")
        controls.append(self.volume_label)
        root.append(controls)

    @staticmethod
    def _button(label: str, callback: Callable[..., Any], tooltip: str) -> Gtk.Button:
        button = Gtk.Button(label=label)
        button.set_tooltip_text(tooltip)
        button.connect("clicked", callback)
        return button

    def _run(self, *args: str, json_output: bool = False) -> Any:
        result = subprocess.run(
            [CATT, "-d", DEVICE, *args],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "Cast command failed")
        return json.loads(result.stdout) if json_output else result.stdout

    def _async(self, function: Callable[[], Any], done: Callable[[Any, Exception | None], None]) -> None:
        future = self.pool.submit(function)

        def complete() -> bool:
            try:
                done(future.result(), None)
            except Exception as error:  # Surface network/CLI errors in the UI.
                done(None, error)
            return GLib.SOURCE_REMOVE

        future.add_done_callback(lambda _: GLib.idle_add(complete))

    def refresh(self) -> None:
        if self._closed:
            return
        self._async(lambda: self._run("info", "-j", json_output=True), self._apply_status)

    def _apply_status(self, data: dict[str, Any] | None, error: Exception | None) -> None:
        if error or not data:
            self.online = False
            self.status_label.set_text("● Offline")
            self.status_label.remove_css_class("online")
            self.status_label.add_css_class("error")
            self.title_label.set_text(str(error) if error else "Speaker unavailable")
            self.seek_scale.set_sensitive(False)
            return

        self.online = True
        self.state = str(data.get("player_state") or "IDLE").upper()
        self.duration = float(data.get("duration") or 0)
        current = float(data.get("current_time") or 0)
        volume = float(data.get("volume_level") or 0)
        volume = volume * 100 if volume <= 1 else volume
        metadata = data.get("media_metadata") or {}
        title = metadata.get("title") or metadata.get("subtitle") or "No media title"

        self.updating = True
        self.title_label.set_text(str(title))
        self.status_label.set_text(f"● {self.state.title()}")
        self.status_label.remove_css_class("error")
        self.status_label.add_css_class("online")
        self.play_button.set_label("⏸" if self.state == "PLAYING" else "▶")
        self.volume_scale.set_value(round(volume))
        self.volume_label.set_text(f"{round(volume)}%")
        self.seek_scale.set_range(0, max(1, self.duration))
        self.seek_scale.set_value(min(current, self.duration) if self.duration else 0)
        self.seek_scale.set_sensitive(self.duration > 0)
        self.elapsed_label.set_text(fmt_time(current))
        self.updating = False

    def command(self, *args: str) -> None:
        def done(_: Any, error: Exception | None) -> None:
            if error:
                self.status_label.set_text("● Error")
                self.status_label.remove_css_class("online")
                self.status_label.add_css_class("error")
                self.status_label.set_tooltip_text(str(error))
                return
            GLib.timeout_add(350, self._refresh_once)

        self._async(lambda: self._run(*args), done)

    def _refresh_once(self) -> bool:
        self.refresh()
        return GLib.SOURCE_REMOVE

    def _toggle(self, *_: Any) -> None:
        self.command("play_toggle")

    def _on_volume_changed(self, scale: Gtk.Scale) -> None:
        if self.updating:
            return
        value = round(scale.get_value())
        self.volume_label.set_text(f"{value}%")
        if self.volume_timer:
            GLib.source_remove(self.volume_timer)
        self.volume_timer = GLib.timeout_add(250, self._commit_volume, value)

    def _commit_volume(self, value: int) -> bool:
        self.volume_timer = 0
        self.command("volume", str(value))
        return GLib.SOURCE_REMOVE

    def _on_seek_changed(self, scale: Gtk.Scale) -> None:
        if self.updating or not self.duration:
            return
        value = round(scale.get_value())
        self.elapsed_label.set_text(fmt_time(value))
        if self.seek_timer:
            GLib.source_remove(self.seek_timer)
        self.seek_timer = GLib.timeout_add(500, self._commit_seek, value)

    def _commit_seek(self, value: int) -> bool:
        self.seek_timer = 0
        self.command("seek", str(value))
        return GLib.SOURCE_REMOVE

    def _periodic_refresh(self) -> bool:
        if self._closed:
            return GLib.SOURCE_REMOVE
        if not self.volume_timer and not self.seek_timer:
            self.refresh()
        return GLib.SOURCE_CONTINUE

    def _arm_focus_dismissal(self) -> bool:
        self._dismiss_armed = True
        if self._had_focus and not self.is_active():
            self.close()
        return GLib.SOURCE_REMOVE

    def _on_focus_changed(self, window: Gtk.Window, *_: Any) -> None:
        if window.is_active():
            self._had_focus = True
        elif self._had_focus and self._dismiss_armed:
            window.close()

    def _on_close(self, *_: Any) -> bool:
        self._closed = True
        self.pool.shutdown(wait=False, cancel_futures=True)
        return False


class ControllerApp(Gtk.Application):
    def __init__(self) -> None:
        super().__init__(application_id="com.raja.GoogleHomeController")

    def do_activate(self) -> None:
        window = self.props.active_window
        if window is None:
            window = ControllerWindow(self)
        window.present()


if __name__ == "__main__":
    provider = Gtk.CssProvider()
    provider.load_from_data(CSS)
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(),
        provider,
        Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
    )
    raise SystemExit(ControllerApp().run(None))
