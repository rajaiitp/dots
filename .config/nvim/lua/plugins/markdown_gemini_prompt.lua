local M = {}

local ns = vim.api.nvim_create_namespace("markdown_gemini_prompt")

function M.refresh(buf)
    buf = buf or vim.api.nvim_get_current_buf()
    if not vim.api.nvim_buf_is_valid(buf) or vim.bo[buf].filetype ~= "markdown" then return end

    vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)

    local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
    for row, line in ipairs(lines) do
        if line:match("^G>%s*") then
            vim.api.nvim_buf_set_extmark(buf, ns, row - 1, 0, {
                end_row = row,
                hl_group = "MarkdownGeminiPrompt",
                hl_eol = true,
                priority = 250,
            })
            vim.api.nvim_buf_set_extmark(buf, ns, row - 1, 0, {
                end_col = math.min(2, #line),
                hl_group = "MarkdownGeminiPromptPrefix",
                priority = 251,
            })
        end
    end
end

function M.setup(buf)
    buf = buf or vim.api.nvim_get_current_buf()
    local group = vim.api.nvim_create_augroup("MarkdownGeminiPrompt_" .. buf, { clear = true })

    vim.api.nvim_create_autocmd({ "BufEnter", "TextChanged", "TextChangedI", "InsertLeave" }, {
        buffer = buf,
        group = group,
        callback = function()
            require("plugins.markdown_gemini_prompt").refresh(buf)
        end,
    })

    M.refresh(buf)
end

return M
