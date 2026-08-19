-- Gruvbox Dark — the shared editor/terminal theme.

require("gruvbox").setup({
    contrast = "",
    terminal_colors = true,
    bold = true,
    italic = {
        strings = true,
        comments = true,
        operators = false,
        folds = true,
    },
    dim_inactive = false,
    transparent_mode = false,
})

vim.o.background = "dark"
vim.cmd.colorscheme("gruvbox")

vim.opt.cursorline = true
vim.opt.cursorlineopt = "both"
