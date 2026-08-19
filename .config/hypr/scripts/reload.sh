#!/bin/sh
WS=$(hyprctl activeworkspace -j | jq -r .id)
hyprctl reload config-only
pkill waybar; waybar &
hyprctl dispatch workspace "$WS"