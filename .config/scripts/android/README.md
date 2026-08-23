# Xiaomi Pad HDMI/Termux stack

The tracked tablet customizations are consolidated here:

- `tablet-playback.sh` — dispatcher for playback, display launch, task moves,
  panel policy, media controls, and display-mode persistence. Installation keeps
  synchronized Termux and root-accessible `/data/adb/tablet-playback` copies so
  Magisk-granted Quick Settings actions never depend on Termux-private storage.
- `termux-boot/start-sshd` — key-only SSH on localhost, Wi-Fi, and VPN
  interfaces. It intentionally holds a Termux wake lock for always-on access.
- `charge-threshold.sh` — Magisk service that pauses at 80% and resumes at 75%
  only when it owns the pause.
- `set-hdmi-mirror-default.sh` — ADB helper that sets Android's
  `mirror_built_in_display=1` default so HDMI mirroring does not prompt.
- `../display/hdmi-panel-backlight.sh` — Magisk HDMI/backlight coordinator.
- `apps/hdmi-control-tile` — Move HDMI and Caffeinate Quick Settings tiles.
- `apps/tv-touch-controller` — low-latency external-display preview and touch
  injection.

Apply the HDMI mirroring default over any authorized USB or Wi-Fi ADB connection:

```sh
~/.config/scripts/android/set-hdmi-mirror-default.sh
# Or select a specific device:
~/.config/scripts/android/set-hdmi-mirror-default.sh \
  --serial 192.168.178.53:36413
```

Install scripts and rebuilt APKs over an authorized USB ADB connection:

```sh
tablet sync
# or
~/.config/scripts/android/install-tablet-stack.sh --apps
```

An event-driven compatibility version of the Termux HDMI notification is kept
by the first installation, without the old three-second polling loop. Connect
HDMI and verify that the repaired **Move HDMI** tile moves an app in both
directions. Then retire the duplicate notification and obsolete LSPosed HDMI
app:

```sh
~/.config/scripts/android/install-tablet-stack.sh \
  --retire-notification --retire-hook
```

The disabled LSPosed framework itself is not removed. The HDMI hook is
unnecessary because all display launches and task moves go through a root
command, while external system-decor policy is persisted in Android's display
settings.
