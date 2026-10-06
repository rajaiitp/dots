local RUNTIME_DIR_MODE = 448 -- 0700
local runtime_dir = ("/tmp/nvim-%d"):format(vim.uv.os_get_passwd().uid)
vim.fn.mkdir(runtime_dir, "p", RUNTIME_DIR_MODE)
vim.env.XDG_RUNTIME_DIR = runtime_dir

vim.g.mapleader = " "
vim.g.maplocalleader = "\\"



-- ============================================================
-- PLUGINS — vim.pack (built-in, Neovim 0.12+)
-- ============================================================
require("pack")

-- ============================================================
-- CORE CONFIG
-- ============================================================
require("set")
require("keymaps")
require("autocmds")
