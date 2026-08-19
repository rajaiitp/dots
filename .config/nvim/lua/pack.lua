-- =============================================================================
-- vim.pack — built-in plugin manager (Neovim 0.12+)
-- Replaces lazy.nvim. Plugins are installed to:
--   ~/.local/share/nvim/site/pack/core/opt/
-- Run :lua vim.pack.update() to update all plugins.
-- =============================================================================

local gh = function(x) return "https://github.com/" .. x end

-- Build hooks: run after install/update
vim.api.nvim_create_autocmd("PackChanged", {
    callback = function(ev)
        local name = ev.data.spec.name
        local kind = ev.data.kind
        if kind ~= "install" and kind ~= "update" then return end

        if name == "nvim-treesitter" then
            if not ev.data.active then vim.cmd.packadd("nvim-treesitter") end
            vim.cmd("TSUpdate")
        end

        if name == "mason.nvim" then
            if not ev.data.active then vim.cmd.packadd("mason.nvim") end
            vim.cmd("MasonUpdate")
        end
    end,
})

-- =============================================================================
-- 1. COLORSCHEME (must be first)
-- =============================================================================
vim.pack.add({ gh("ellisonleao/gruvbox.nvim") })
require("plugins.theme")

-- =============================================================================
-- 2. ICONS (needed by many plugins)
-- =============================================================================
vim.pack.add({ gh("nvim-tree/nvim-web-devicons") })

-- =============================================================================
-- 3. SHARED DEPENDENCIES
-- =============================================================================
vim.pack.add({
    gh("nvim-lua/plenary.nvim"),
    gh("MunifTanjim/nui.nvim"),
})

-- =============================================================================
-- 4. WINBAR
-- =============================================================================
require("plugins.winbar")

-- =============================================================================
-- 5. FILE TREE
-- =============================================================================
vim.pack.add({
    { src = gh("nvim-neo-tree/neo-tree.nvim"), version = "v3.x" },
})
require("plugins.neo-tree")

-- =============================================================================
-- 6. TREESITTER
-- =============================================================================
vim.pack.add({
    gh("nvim-treesitter/nvim-treesitter"),
    -- nvim-ts-autotag removed: use built-in vim.lsp.linked_editing_range for tag renaming
})
require("plugins.treesitter")

-- =============================================================================
-- 7. COMPLETION
-- =============================================================================
vim.pack.add({
    gh("saghen/blink.cmp"),
    gh("rafamadriz/friendly-snippets"),
})
require("plugins.completion")

-- =============================================================================
-- 8. LSP
-- =============================================================================
vim.pack.add({
    gh("williamboman/mason.nvim"),
    gh("williamboman/mason-lspconfig.nvim"),
    gh("neovim/nvim-lspconfig"),
    gh("antosha417/nvim-lsp-file-operations"),
    gh("folke/lazydev.nvim"),
})
require("plugins.lsp")

-- =============================================================================
-- 9. FORMATTING
-- =============================================================================
vim.pack.add({ gh("stevearc/conform.nvim") })
require("plugins.conform")

-- =============================================================================
-- 10. MASON TOOLS
-- =============================================================================
vim.pack.add({ gh("WhoIsSethDaniel/mason-tool-installer.nvim") })
require("plugins.mason")

-- =============================================================================
-- 11. FUZZY FINDER
-- =============================================================================
vim.pack.add({
    gh("ibhagwan/fzf-lua"),
    gh("folke/todo-comments.nvim"),
})
require("plugins.fzf")

-- =============================================================================
-- 12. EDITOR ENHANCEMENTS
-- =============================================================================
vim.pack.add({
    gh("lewis6991/gitsigns.nvim"),
    { src = gh("echasnovski/mini.nvim"), version = "main" },
    gh("windwp/nvim-autopairs"),
})
require("plugins.editor")
-- require("plugins.project-ask")  -- DISABLED: heavy model

-- =============================================================================
-- 13. UI
-- =============================================================================
vim.pack.add({ gh("karb94/neoscroll.nvim") })
require("plugins.ui")

-- =============================================================================
-- 14. MARKDOWN
-- =============================================================================
vim.pack.add({ gh("MeanderingProgrammer/render-markdown.nvim") })
require("plugins.markdown")

-- =============================================================================
-- 15. UTILS
-- =============================================================================
vim.pack.add({ gh("rmagatti/auto-session") })
require("plugins.utils")


