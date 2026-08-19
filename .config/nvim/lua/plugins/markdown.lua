-- No color overrides — let rose-pine drive render-markdown, treesitter, and
-- gemini-prompt highlights via their default links.
--
-- Setext headings (text underlined with === / ---): keep the neutralize link
-- so a bullet on a new line doesn't flash the paragraph above as a heading.
vim.api.nvim_set_hl(0, "@markup.setext.neutralized", { link = "Normal" })

local function toggle_render_for_current_buffer()
    local render_markdown = require("render-markdown")
    render_markdown.buf_toggle()

    local enabled = require("render-markdown.state").get(vim.api.nvim_get_current_buf()).enabled
    vim.notify(enabled and "Markdown rendering enabled" or "Markdown rendering revealed for editing", vim.log.levels.INFO)
end

vim.api.nvim_create_user_command("MarkdownRenderToggle", toggle_render_for_current_buffer, {
    desc = "Toggle markdown rendering for current buffer",
})

require("render-markdown").setup({
    render_modes = true,  -- render in all modes
    debounce = 50,        -- reduce re-render frequency for smoother scrolling
    anti_conceal = {
        enabled = true,
        above = 0,
        below = 0,
        disabled_modes = { "n", "v", "V" },  -- disable anti-conceal in normal and visual (keeps everything rendered)
    },
    win_options  = {
        conceallevel  = { default = 2, rendered = 3 },
        concealcursor = { default = "n", rendered = "nc" },  -- normal+command: don't reveal on cursor line
    },
    heading = {
        enabled     = true,
        sign        = false,
        -- Only ATX headings (#, ##). Disable setext (text underlined with
        -- === or ---), which caused a bullet-on-new-line (`text` + `-`) to
        -- momentarily render as a heading until the next char was typed.
        setext      = false,
        icons       = { "󰎤 ", "󰎧 ", "󰎪 ", "󰎭 ", "󰎱 ", "󰎳 " },
        backgrounds = {},
        foregrounds = {
            "RenderMarkdownH1", "RenderMarkdownH2", "RenderMarkdownH3",
            "RenderMarkdownH4", "RenderMarkdownH5", "RenderMarkdownH6",
        },
    },
    code = {
        enabled          = true,
        sign             = false,
        border           = "none",
        -- Disable background for code blocks to let treesitter highlighting show through
        disable_background = true,
        highlight        = "RenderMarkdownCode",
        highlight_inline = "RenderMarkdownCodeInline",
    },
    bullet   = { enabled = true, icons = { "●", "○", "◆", "◇" }, highlight = "RenderMarkdownBullet" },
    checkbox = {
        enabled   = true,
        unchecked = { icon = "󰄱 ", highlight = "RenderMarkdownUnchecked" },
        checked   = { icon = "󰄵 ", highlight = "RenderMarkdownChecked" },
    },
    link = { enabled = true, hyperlink = "󰌷 ", highlight = "RenderMarkdownLink" },
    list = { enable = true, indent = 0, shift_width = 0 },
})
