-- =============================================================================
-- WEZTERM CONFIGURATION
-- =============================================================================
-- WezTerm is the outer terminal host. Herdr owns workspaces, tabs, pane
-- navigation, persistence, and agent/review workflows inside it.

local wezterm = require("wezterm")
local config = {}

-- GUI sessions can start with a minimal PATH. Keep user-installed tools
-- available to ordinary terminal programs without making WezTerm a workflow
-- manager.
local inherited_path = os.getenv("PATH") or "/usr/local/bin:/usr/bin:/bin"
local user_tool_path = table.concat({
    wezterm.home_dir .. "/.pi/agent/bin",
    wezterm.home_dir .. "/.cargo/bin",
    wezterm.home_dir .. "/go/bin",
    wezterm.home_dir .. "/.bun/bin",
    wezterm.home_dir .. "/.local/bin",
    wezterm.home_dir .. "/.npm-global/bin",
    wezterm.home_dir .. "/bin",
    inherited_path,
}, ":")
config.set_environment_variables = {
    PATH = user_tool_path,
}

-- Discover SSH domains from ~/.ssh/config for ordinary remote terminal use.
-- Herdr remains responsible for local workspace/tab lifecycle.
config.ssh_domains = {}
for host, _ in pairs(wezterm.enumerate_ssh_hosts()) do
    -- systemd-ssh-proxy adds aliases such as machine/.host; they are not
    -- regular SSH hostnames and libssh rejects them as remote addresses.
    if host:match("^[%w][%w_.@%-]*$") then
        table.insert(config.ssh_domains, {
            name = "SSHMUX:" .. host,
            remote_address = host,
            multiplexing = "WezTerm",
            assume_shell = "Posix",
        })
    end
end

-- =============================================================================
-- APPEARANCE
-- =============================================================================

config.color_scheme = "GruvboxDark"
config.command_palette_bg_color = "#282828"
config.command_palette_fg_color = "#ebdbb2"
config.command_palette_font_size = 13
config.command_palette_rows = 14

config.font = wezterm.font_with_fallback({
    { family = "JetBrains Mono", weight = "ExtraLight" },
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
-- Reset cell bounds so characters are not artificially squished/interpolated.
config.cell_width = 0.9

-- Keep pane content identical; focus is indicated only by the pane top bar.
config.inactive_pane_hsb = {
    saturation = 1.0,
    brightness = 0.90,
}

-- =============================================================================
-- WINDOW
-- =============================================================================

-- The clean upstream build's native Wayland backend does not map a window
-- reliably on this Hyprland setup; use XWayland so WezTerm launches normally.
config.enable_wayland = false
config.window_close_confirmation = "NeverPrompt"
config.skip_close_confirmation_for_processes_named = {
    "bash", "sh", "zsh", "fish", "tmux", "nu", "cmd.exe", "pwsh.exe", "powershell.exe",
    "node", "python", "python3", "nvim", "vim", "ssh", "opencode",
}
-- Hide the macOS title bar while retaining the resize frame that Aerospace
-- needs for reliable tiling. Disable the native shadow without using NONE:
-- borderless windows lose normal resize/minimize behavior and tile poorly.
config.window_decorations = "NONE"
config.window_frame = {
    border_left_width = 0,
    border_right_width = 0,
    border_top_height = 0,
    border_bottom_height = 0,
}
config.term = "wezterm"
-- The outer WezTerm pane has no visual divider; Herdr supplies its own
-- internal pane borders and layout chrome.
config.colors = {
    -- GruvboxDark's default split color (#458588) was the visible cyan line.
    -- Match the terminal background instead of relying on alpha transparency.
    split = "#282828",
}
-- Herdr owns pane geometry and borders; do not add an outer WezTerm inset.
config.window_padding = {
    left = 0,
    right = 0,
    top = 0,
    bottom = 0,
}
-- Herdr owns tabs and workspaces. Hide WezTerm's native tab bar so there is
-- one clear lifecycle and no competing tab UI.
config.enable_tab_bar = false

-- =============================================================================
-- BEHAVIOR
-- =============================================================================

config.automatically_reload_config = true
-- Herdr uses the Kitty/CSI-u keyboard protocol for modified number keys
-- such as Ctrl+1..9; enable both encodings in the outer terminal.
config.enable_kitty_keyboard = true
config.enable_csi_u_key_encoding = true
config.audible_bell = "Disabled"
-- The standalone custom macOS build has no application bundle, so warning
-- notifications would crash when UserNotifications looks up its bundle.
config.warn_about_missing_glyphs = false
-- Keep WezTerm's outer keymap intentionally minimal; Herdr owns the
-- multiplexer keymap and native tab/workspace lifecycle.
config.disable_default_key_bindings = true
config.front_end = "WebGpu"
config.max_fps = 120
config.status_update_interval = 1000
config.exit_behavior = "Close"
config.exit_behavior_messaging = "Brief"
config.pane_focus_follows_mouse = true
config.mouse_bindings = {
    {
        event = { Up = { streak = 1, button = "Left" } },
        mods = "NONE",
        action = wezterm.action.CompleteSelection("ClipboardAndPrimarySelection"),
    },
}

-- Keep only the useful outer-terminal basics. No WezTerm tab/workspace
-- actions are bound here; Herdr receives its own keymap unchanged.
local act = wezterm.action
config.keys = {
    { key = "c", mods = "CTRL|SHIFT", action = act.CopyTo("Clipboard") },
    { key = "v", mods = "CTRL|SHIFT", action = act.PasteFrom("Clipboard") },
    { key = "f", mods = "CTRL|SHIFT", action = act.Search("CurrentSelectionOrEmptyString") },
    { key = "PageUp", mods = "SHIFT", action = act.ScrollByPage(-1) },
    { key = "PageDown", mods = "SHIFT", action = act.ScrollByPage(1) },
}

return config
