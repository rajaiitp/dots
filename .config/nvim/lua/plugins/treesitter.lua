local treesitter = require("nvim-treesitter")

local languages = {
    "json", "javascript", "typescript", "tsx", "yaml", "html",
    "css", "prisma", "markdown", "markdown_inline", "svelte",
    "graphql", "bash", "lua", "vim", "dockerfile", "gitignore",
    "query", "vimdoc", "c", "python", "rust", "go",
}

treesitter.setup()
treesitter.install(languages):wait(300000)

local configured = {}
for _, language in ipairs(languages) do
    configured[language] = true
end

vim.api.nvim_create_autocmd("FileType", {
    group = vim.api.nvim_create_augroup("TreesitterFeatures", { clear = true }),
    callback = function(args)
        local filetype = vim.bo[args.buf].filetype
        local language = vim.treesitter.language.get_lang(filetype) or filetype
        if not configured[language] then return end

        if pcall(vim.treesitter.start, args.buf, language) then
            vim.bo[args.buf].indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
        end
    end,
})
