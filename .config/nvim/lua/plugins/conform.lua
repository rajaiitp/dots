local conform = require("conform")

conform.setup({
    formatters_by_ft = {
        yaml       = { "prettier" },
        json       = { "prettier" },
        jsonc      = { "prettier" },
        markdown   = { "markdown_prettier" },
        r          = { "styler" },
        lua        = { "lua_ls" },
        python     = { "ruff" },
    },
    format_on_save = function(bufnr)
        -- Don't format special buffers
        if vim.bo[bufnr].buftype ~= "" then return end
        return { timeout_ms = 2000, lsp_fallback = true }
    end,
    notify_on_error = false,
    formatters = {
        prettier = {
            prepend_args = { "--embedded-language-formatting=auto" },
        },
        ruff_format = {
            prepend_args = { "--line-length=88" },
            ignore_errors = true,
        },
    },
})

conform.formatters.markdown_prettier = {
    command = "prettier",
    args    = {
        "--embedded-language-formatting=auto",
        "--prose-wrap=preserve",
        "--end-of-line=lf",
        "--parser=markdown",
    },
    stdin = true,
}
