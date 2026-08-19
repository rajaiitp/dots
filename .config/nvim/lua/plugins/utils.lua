-- auto-session
require("auto-session").setup({
    pre_save_cmds     = { "silent! Neotree close" },
    post_restore_cmds = {
        "silent! Neotree close",
        -- Reload shada after session restore so jumplist/marks are correct
        "rshada!",
    },
})
vim.keymap.set("n", "<A-BS>", function()
    vim.cmd("wa")  -- save all modified buffers first
    vim.cmd("AutoSession save")
    vim.cmd("wshada!")   -- force-write shada before quitting
    vim.cmd("qall")
end, { desc = "Session: Save and quit" })

-- Trouble and lazygit.nvim are intentionally disabled.
