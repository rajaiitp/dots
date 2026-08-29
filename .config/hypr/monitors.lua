-- See https://wiki.hypr.land/Configuring/Basics/Monitors/
-- List current monitors and supported resolutions with: hyprctl monitors all

local omarchy_gdk_scale = 2

hl.env("GDK_SCALE", tostring(omarchy_gdk_scale))

-- Current laptop panel and Philips external display.  The external display
-- starts after the laptop's 1920px panel at its 1.5 scale (1280 logical px).
hl.monitor({ output = "eDP-1", mode = "1920x1200@60", position = "0x0", scale = 1.3 })
hl.monitor({ output = "DP-2", mode = "2560x1440@59.95", position = "1280x0", scale = 1 })

-- Sensible fallback for any display connected later.
hl.monitor({ output = "", mode = "preferred", position = "auto", scale = 1.25 })
