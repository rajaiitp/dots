-- Keybindings migrated from the previous Hyprland configuration. Omarchy's
-- media, clipboard, workspace-number, and browser bindings already provide
-- the same functions and remain at their defaults.

-- Apps and capture.
hl.unbind("SUPER + RETURN")
o.bind("SUPER + RETURN", "WezTerm", { launch = "wezterm-gui start --always-new-process" })
o.bind("SUPER + D", "Apps menu", "omarchy-menu toggle apps")
o.bind("SUPER + E", "File manager", { omarchy = "nautilus" })

hl.unbind("SUPER + P")
o.bind("SUPER + P", "Color picker", "pkill hyprpicker || hyprpicker -a")
o.bind("SUPER + SHIFT + V", "Audio", "omarchy-shell shell toggle omarchy.audio")
o.bind("SUPER + A", "Screenshot selection to clipboard", "grim -g \"$(slurp)\" - | wl-copy")

-- Window management.
hl.unbind("SUPER + Q")
o.bind("SUPER + Q", "Close window", hl.dsp.window.close())

hl.unbind("SUPER + SPACE")
o.bind("SUPER + SPACE", "Full screen", hl.dsp.window.fullscreen({ mode = "fullscreen" }))

hl.unbind("SUPER + SHIFT + F")
o.bind("SUPER + SHIFT + F", "Fake full screen", "hyprctl dispatch fullscreenstate 0 2")

hl.unbind("SUPER + SHIFT + SPACE")
o.bind("SUPER + SHIFT + SPACE", "Toggle floating", hl.dsp.window.float({ action = "toggle" }))

hl.unbind("SUPER + SHIFT + X")
o.bind("SUPER + SHIFT + X", "Kill window", "hyprctl kill")
o.bind("SUPER + SHIFT + Q", "Lock system", "omarchy system lock")

-- System actions.
hl.unbind("SUPER + CTRL + T")
o.bind("SUPER + CTRL + T", "Theme menu", "omarchy-menu toggle theme")

hl.unbind("SUPER + SHIFT + S")
o.bind("SUPER + SHIFT + S", "Suspend", "systemctl suspend")
o.bind("SUPER + SHIFT + R", "Reload Hyprland", "hyprctl reload")

-- Workspace navigation and vim-style window navigation.
hl.unbind("SUPER + TAB")
o.bind("SUPER + TAB", "Former workspace", hl.dsp.focus({ workspace = "previous" }))

hl.unbind("SUPER + H")
hl.unbind("SUPER + J")
hl.unbind("SUPER + K")
hl.unbind("SUPER + L")
o.bind("SUPER + H", "Focus left", hl.dsp.focus({ direction = "l" }))
o.bind("SUPER + J", "Focus down", hl.dsp.focus({ direction = "d" }))
o.bind("SUPER + K", "Focus up", hl.dsp.focus({ direction = "u" }))
o.bind("SUPER + L", "Focus right", hl.dsp.focus({ direction = "r" }))

o.bind("SUPER + SHIFT + H", "Resize window left", "hyprctl dispatch resizeactive -100 0")
o.bind("SUPER + SHIFT + J", "Resize window down", "hyprctl dispatch resizeactive 0 100")
o.bind("SUPER + SHIFT + K", "Resize window up", "hyprctl dispatch resizeactive 0 -100")
o.bind("SUPER + SHIFT + L", "Resize window right", "hyprctl dispatch resizeactive 100 0")

-- Mouse bindings: Shift+left drags a window; Super+left resizes it.
hl.unbind("SUPER + mouse:272")
o.bind("SHIFT + mouse:272", "Move window", hl.dsp.window.drag(), { mouse = true })
o.bind("SUPER + mouse:272", "Resize window", hl.dsp.window.resize(), { mouse = true })
