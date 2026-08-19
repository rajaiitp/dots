-- =============================================================================
-- NEOVIM SETTINGS
-- =============================================================================

-- =============================================================================
-- EDITING
-- =============================================================================

vim.opt.tabstop = 4
vim.opt.softtabstop = 4
vim.opt.shiftwidth = 4
vim.opt.expandtab = true
vim.opt.smartindent = true
vim.opt.ignorecase = true
vim.opt.smartcase = true
vim.opt.clipboard = "unnamedplus"
vim.opt.whichwrap:append("<,>[")

-- Persistent undo
vim.opt.undofile = true
vim.opt.undodir = vim.fn.stdpath("data") .. "/undo"

-- Persistent history across sessions (shada)
-- !  = save/restore global variables with uppercase names
-- '1000 = remember marks for last 1000 files
-- <500 = save up to 500 lines per register
-- s100 = max item size 100KB
-- h   = disable 'hlsearch' on load
-- :500 = remember last 500 commands
-- /500 = remember last 500 searches
vim.opt.shada = "!,'1000,<500,s100,h,:500,/500"

-- =============================================================================
-- UI/DISPLAY
-- =============================================================================

vim.opt.foldcolumn = "0"
vim.opt.number = true
vim.opt.relativenumber = false
vim.opt.termguicolors = true
vim.opt.cmdheight = 0
-- Fixed typo in fillchars (removed extra space)
vim.opt.scrolloff = 15
vim.opt.sidescrolloff = 15
vim.opt.display:append("uhex")

-- Cursor settings
vim.opt.guicursor:append("a:blinkon0")

-- Mouse
vim.o.mouse = "a"
vim.opt.mousemodel = "extend"

-- 1. Setup appearance
vim.o.statuscolumn = ""
vim.opt.showbreak = ""
vim.opt.wrap = true
vim.opt.linebreak = true
-- Indent wrapped lines to match the previous line
vim.opt.breakindent = true
vim.opt.numberwidth = 2    -- Minimum width for the number column
vim.opt.signcolumn = "yes" -- Always show signcolumn for git/diagnostic indicators

-- CursorHold delay for auto-peek (200ms)
vim.opt.updatetime = 200

vim.opt.fillchars = { eob = " ", vert = "│", vertright = "│", vertleft = "│", horiz = "─", horizup = "┴", horizdown = "┬", verthoriz =
"┼" }

-- Encoding for nerd font icons
vim.opt.encoding = "utf-8"
vim.opt.fileencodings = "utf-8"

-- Winbar is set by plugins/winbar.lua

-- =============================================================================
-- TERMINAL
-- =============================================================================

vim.opt.shell = "zsh"
