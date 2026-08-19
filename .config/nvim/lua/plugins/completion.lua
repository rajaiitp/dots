require("blink.cmp").setup({
    keymap = {
        preset  = "default",
        ["<C-k>"] = { "select_prev", "fallback" },
        ["<C-j>"] = { "select_next", "fallback" },
        ["<CR>"]  = { "accept", "fallback" },
        ["<Tab>"] = { "snippet_forward", "fallback" },
    },
    appearance = {
        use_nvim_cmp_as_default = true,
        nerd_font_variant       = "mono",
    },
    -- Disable blink entirely inside neo-tree's popup / input prompts (filetype
            -- 'neo-tree-popup') and any prompt buffers — otherwise buffer-word
            -- completion pollutes the "Enter name for new file" dialog.
    enabled = function()
        if vim.bo.buftype == "prompt" then return false end
        if vim.bo.filetype == "neo-tree-popup" then return false end
        return true
    end,
    sources = {
        default = function()
            if vim.bo.filetype == "markdown" then return {} end
            return { "lsp", "path", "snippets", "buffer" }
        end,
    },
    completion = {
        menu = {
            border = "single",
            draw = {
                columns = {
                    { "label", "label_description", gap = 1 },
                    { "kind_icon" },
                },
            },
        },
        documentation = {
            auto_show          = true,
            auto_show_delay_ms = 500,
            window = { border = "single" },
        },
    },
    signature = {
        enabled = true,
        window  = { border = "single" },
    },
})
