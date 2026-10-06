local treesitter = require("nvim-treesitter")

local PARSERS = {
    "bash",
    "c",
    "css",
    "dockerfile",
    "gitignore",
    "go",
    "graphql",
    "html",
    "javascript",
    "json",
    "lua",
    "markdown",
    "markdown_inline",
    "prisma",
    "python",
    "query",
    "rust",
    "svelte",
    "tsx",
    "typescript",
    "vim",
    "vimdoc",
    "yaml",
}

local TREESITTER_GROUP = vim.api.nvim_create_augroup("TreesitterFeatures", { clear = true })

-- nvim-treesitter's current main branch provides parser management and queries.
-- Highlighting and indentation are native Neovim features and must be enabled
-- explicitly for each buffer.
treesitter.setup({})
treesitter.install(PARSERS)
vim.treesitter.language.register("bash", "sh")

vim.api.nvim_create_autocmd("FileType", {
    group = TREESITTER_GROUP,
    pattern = "*",
    callback = function(args)
        local filetype = vim.bo[args.buf].filetype
        local language = vim.treesitter.language.get_lang(filetype) or filetype
        local started = pcall(vim.treesitter.start, args.buf, language)
        if not started then return end

        local has_query, query = pcall(vim.treesitter.query.get, language, "indents")
        if has_query and query then
            vim.bo[args.buf].indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
        end
    end,
    desc = "Enable available Treesitter features",
})
