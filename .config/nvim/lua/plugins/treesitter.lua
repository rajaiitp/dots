local ok, configs = pcall(require, "nvim-treesitter.configs")
if ok then
    -- Set compiler to use system cc
    require("nvim-treesitter.install").compilers = { "cc", "gcc", "clang" }
    
    configs.setup({
        highlight            = { enable = true },
        indent               = { enable = true },
        incremental_selection = { enable = true },
        auto_install = true, -- Auto-install missing parsers
        -- autotag removed: built-in vim.lsp.linked_editing_range handles tag renaming
        ensure_installed = {
            "json", "javascript", "typescript", "tsx", "yaml", "html",
            "css", "prisma", "markdown", "markdown_inline", "svelte",
            "graphql", "bash", "lua", "vim", "dockerfile", "gitignore",
            "query", "vimdoc", "c", "python", "rust", "go",
        },
    })
else
    vim.treesitter.language.register("bash", "sh")
end
