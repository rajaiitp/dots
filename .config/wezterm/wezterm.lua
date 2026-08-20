local wezterm = require("wezterm")
local config = {}

-- Plain outer terminal: Herdr and other workflows are started explicitly.
config.color_scheme = "GruvboxDark"
config.font = wezterm.font_with_fallback({
    { family = "JetBrains Mono", weight = "Light" },
})
config.font_rules = {
    {
        intensity = "Bold",
        italic = false,
        font = wezterm.font({ family = "JetBrains Mono", weight = "Regular" }),
    },
    {
        intensity = "Bold",
        italic = true,
        font = wezterm.font({ family = "JetBrains Mono", weight = "Regular", style = "Italic" }),
    },
}
config.font_size = 12
config.cell_width = 0.9

-- Use XWayland/OpenGL for reliable startup on this Hyprland setup.
config.enable_wayland = false
config.front_end = "OpenGL"
config.window_close_confirmation = "NeverPrompt"
-- Hide the title bar while retaining the native resize border/hit area.
config.window_decorations = "RESIZE"
-- Keep the tiled outer window fixed when Ctrl+Plus/Minus changes the font;
-- recalculate the terminal grid instead of resizing against Hyprland.
config.adjust_window_size_when_changing_font_size = false
config.use_resize_increments = true
config.window_frame = {
    border_left_width = 0,
    border_right_width = 0,
    border_top_height = 0,
    border_bottom_height = 0,
}
config.window_padding = {
    left = 0,
    right = 0,
    top = 0,
    bottom = 0,
}
config.colors = { split = "#282828" }
config.enable_tab_bar = false
config.term = "wezterm"

-- Keep modified-key input available to applications such as Herdr without
-- restoring WezTerm's own tab/workspace keymap.
config.enable_kitty_keyboard = true
config.enable_csi_u_key_encoding = true
config.audible_bell = "Disabled"
config.automatically_reload_config = true

config.mouse_bindings = {
    {
        event = { Up = { streak = 1, button = "Left" } },
        mods = "NONE",
        action = wezterm.action.CompleteSelection("ClipboardAndPrimarySelection"),
    },
}

local act = wezterm.action
config.keys = {
    -- WezTerm's defaults reserve Ctrl-Tab for native tab switching. Forward
    -- these keys so Herdr can cycle agents while keeping other defaults,
    -- including the built-in font-size shortcuts.
    { key = "Tab",      mods = "CTRL",        action = act.SendKey({ key = "Tab", mods = "CTRL" }) },
    { key = "Tab",      mods = "CTRL|SHIFT",  action = act.SendKey({ key = "Tab", mods = "CTRL|SHIFT" }) },
    { key = "c",        mods = "CTRL|SHIFT", action = act.CopyTo("Clipboard") },
    { key = "v",        mods = "CTRL|SHIFT", action = act.PasteFrom("Clipboard") },
    { key = "f",        mods = "CTRL|SHIFT", action = act.Search("CurrentSelectionOrEmptyString") },
    { key = "PageUp",   mods = "SHIFT",      action = act.ScrollByPage(-1) },
    { key = "PageDown", mods = "SHIFT",      action = act.ScrollByPage(1) },
}

return config
