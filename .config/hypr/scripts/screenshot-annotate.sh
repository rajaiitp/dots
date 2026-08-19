#!/bin/bash
# Region screenshot -> annotate in swappy (flameshot-style editor for Wayland).
#
# Flameshot's own capture is broken on Hyprland/wlroots ("Unable to capture
# screen"), so we use the reliable native path: slurp selects the region, grim
# captures it, and swappy opens it for annotation (arrow/box/ellipse/text/blur/
# brush). swappy reads the image from stdin via `-f -`.
#
# Bound to SUPER+SHIFT+A. Pairs with SUPER+A (region -> clipboard via grim).

set -uo pipefail

# slurp: interactively drag-select a region. Cancel (empty) -> abort cleanly.
geom="$(slurp 2>/dev/null || true)"
[ -z "$geom" ] && exit 0

# grim captures the region to stdout; swappy opens it for annotation.
# In swappy, Ctrl+S saves (default ~/Desktop or per ~/.config/swappy/config),
# Ctrl+C copies the annotated result to the clipboard.
grim -g "$geom" - | swappy -f -
