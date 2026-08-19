-- restart.lua
-- Tmux-based nvim restart

local M = {}

function M.restart()
    -- Check if running in tmux
    if vim.env.TMUX == nil then
        vim.notify("Not running in tmux - use :qa to quit and restart manually", vim.log.levels.WARN)
        return
    end
    
    -- Get current pane ID  
    local pane_id = vim.fn.system("tmux display-message -p '#{pane_id}'"):gsub("\n", "")
    
    -- Use tmux to send 'nvim' command after a brief delay
    vim.fn.jobstart(string.format(
        "sleep 0.2 && tmux send-keys -t %s 'nvim' C-m",
        pane_id
    ), { detach = true })
    
    -- Quit nvim
    vim.cmd("qall!")
end

return M
