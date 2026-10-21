-- auto-session
local neo_tree = require("plugins.neo-tree")

require("auto-session").setup({
    enabled           = true,
    auto_save         = true,
    auto_restore      = true,
    auto_create       = true,
    pre_save_cmds     = { "silent! Neotree close" },
    post_restore_cmds = {
        "silent! Neotree close",
        -- Reload shada after session restore so jumplist/marks are correct
        "rshada!",
        function() neo_tree.schedule_startup_open() end,
    },
    no_restore_cmds = {
        function(is_startup)
            if is_startup then neo_tree.schedule_startup_open() end
        end,
    },
})

local neo_tree_startup_group = vim.api.nvim_create_augroup("NeoTreeAfterSessionStartup", { clear = true })
vim.api.nvim_create_autocmd("VimEnter", {
    group = neo_tree_startup_group,
    once = true,
    callback = neo_tree.schedule_startup_open,
    desc = "Open Neo-tree after auto-session startup",
})

vim.keymap.set("n", "<A-BS>", function()
    vim.cmd("wa")  -- save all modified buffers first
    vim.cmd("AutoSession save")
    vim.cmd("wshada!")   -- force-write shada before quitting
    vim.cmd("qall")
end, { desc = "Session: Save and quit" })
