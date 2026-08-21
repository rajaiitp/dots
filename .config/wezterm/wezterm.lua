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

-- The Linux/Hyprland setup needs XWayland/OpenGL. On macOS use WebGPU's
-- Metal renderer instead: the OpenGL backend can leave stale glyphs on screen
-- even when the shell receives the correct input.
if wezterm.target_triple:find("darwin") then
    config.front_end = "WebGpu"
else
    config.enable_wayland = false
    config.front_end = "OpenGL"
end
config.window_close_confirmation = "NeverPrompt"
-- Hide the title bar while retaining the native resize border/hit area.
config.window_decorations = "RESIZE"
-- Keep the tiled outer window fixed when Ctrl+Plus/Minus changes the font;
-- recalculate the terminal grid instead of resizing against Hyprland.
-- config.adjust_window_size_when_changing_font_size = false
-- config.use_resize_increments = true
config.window_frame = {
    border_left_width = 0,
    border_right_width = 0,
    border_top_height = 0,
    border_bottom_height = 0,
}
config.window_padding = {
    left = 5,
    right = 0,
    top = 5,
    bottom = 0,
}
config.enable_tab_bar = false

-- Do not enable Kitty keyboard protocol in this older WezTerm release: its
-- enhanced encoding can prevent Escape from reaching terminal applications.
-- Ctrl+Tab below sends the required CSI-u sequences only for Herdr.
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
    -- Bypass WezTerm's native tab switching and send Herdr's Ctrl+Tab keys
    -- without globally enabling the Kitty keyboard protocol.
    { key = "Tab", mods = "CTRL",       action = act.SendString("\x1b[9;5u") },
    { key = "Tab", mods = "CTRL|SHIFT", action = act.SendString("\x1b[9;6u") },
    { key = "c",   mods = "CTRL|SHIFT", action = act.CopyTo("Clipboard") },
    { key = "v",   mods = "CTRL|SHIFT", action = act.PasteFrom("Clipboard") },
}

-- WezTerm reserves Ctrl+1..9 for its own tabs even when its tab bar is hidden.
-- Forward CSI-u sequences so Herdr's indexed tab bindings receive them.
for index = 1, 9 do
    local key = tostring(index)
    table.insert(config.keys, {
        key = key,
        mods = "CTRL",
        action = act.SendString(string.format("\x1b[%d;5u", string.byte(key))),
    })
end

return config
