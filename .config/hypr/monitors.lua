-- See https://wiki.hypr.land/Configuring/Basics/Monitors/
-- List current monitors and supported resolutions with: hyprctl monitors all

local omarchy_gdk_scale = 2

hl.env("GDK_SCALE", tostring(omarchy_gdk_scale))

-- The laptop's 1920px panel uses a 4/3 scale, so it is 1440 logical pixels
-- wide. Place the Philips display immediately to its right—without overlap.
hl.monitor({ output = "eDP-1", mode = "1920x1200@60", position = "0x0", scale = 1.333333 })
hl.monitor({ output = "DP-2", mode = "2560x1440@59.95", position = "1440x0", scale = 1 })

for workspace = 1, 4 do
  hl.workspace_rule({ workspace = tostring(workspace), monitor = "DP-2" })
end
hl.workspace_rule({ workspace = "5", monitor = "eDP-1" })

-- Sensible fallback for any display connected later.
hl.monitor({ output = "", mode = "preferred", position = "auto", scale = 1.25 })
