return function(ctx)
  local left = {}
  for _, agent in ipairs(ctx.agents) do
    local marker = agent.marker
    if marker == "" then marker = "○" end
    local fg = "dim"
    if agent.state == "needs_input" then fg = "warning"
    elseif agent.state == "errored" then fg = "error"
    elseif agent.state == "working" then fg = "status.busy"
    elseif agent.state == "done" and not agent.done_seen then fg = "success" end
    left[#left + 1] = {
      ref = agent.ref,
      text = agent.name .. " · " .. agent.project,
      indicator = marker,
      indicator_fg = fg,
      fg = agent.focused and "accent" or "dim",
      bg = "panel",
    }
  end

  local right = {}
  for _, workspace in ipairs(ctx.workspaces) do
    right[#right + 1] = {
      ref = workspace.ref,
      text = " " .. (workspace.index == 0 and "+" or (workspace.index .. ": " .. workspace.name)) .. " ",
      fg = workspace.active and "accent" or "dim",
      bg = "panel",
    }
  end
  right[#right + 1] = { ref = "picker", text = ctx.picker .. " ▼", fg = "fg", bold = true }
  return { left = left, right = right }
end
