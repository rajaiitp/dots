-- =============================================================================
-- AUTOCOMMANDS
-- =============================================================================

local autocmd = vim.api.nvim_create_autocmd

-- =============================================================================
-- USER COMMANDS
-- =============================================================================

vim.api.nvim_create_user_command("Restart", function()
    require("core.restart").restart()
end, { desc = "Restart nvim in tmux" })

-- =============================================================================
-- EDITING
-- =============================================================================

autocmd("TextYankPost", {
    callback = function()
        vim.hl.on_yank({ timeout = 700 })
    end,
})

-- =============================================================================
-- FILE MANAGEMENT
-- =============================================================================
-- Markdown settings for better rendering
autocmd("FileType", {
    pattern = "markdown",
    callback = function(args)
        vim.opt_local.tabstop = 2
        vim.opt_local.softtabstop = 2
        vim.opt_local.shiftwidth = 2
        require("plugins.markdown_gemini_prompt").setup(args.buf)
        -- Auto-continue bullets and numbered lists
        vim.opt_local.formatoptions:append("r")    -- Continue comments (bullets) on Enter
        vim.opt_local.formatoptions:append("o")    -- Continue comments on 'o' and 'O'
        vim.opt_local.comments = "b:*,b:-,b:+,n:>" -- Recognize *, -, +, > as comment leaders

        -- Smart Enter: remove empty bullets/checkboxes/numbers, continue them
        vim.keymap.set("i", "<CR>", function()
            local line = vim.api.nvim_get_current_line()
            local col = vim.fn.col(".")

            -- Empty checkbox `- [ ]` / `- [x]`: delete it
            if line:match("^%s*[%-%*%+]%s%[%s?%s?%]%s*$") then
                return "<C-u>"
            end

            -- Empty bullet `- ` / `* ` / `+ `: delete it
            if line:match("^%s*[%-%*%+]%s*$") then
                return "<C-u>"
            end

            -- Empty numbered `1. ` / `12. ` (nothing after): delete it
            if line:match("^%s*%d+%.%s*$") then
                return "<C-u>"
            end

            -- Checkbox with content: continue with fresh unchecked checkbox
            if line:match("^%s*[%-%*%+]%s%[.%]") then
                local indent = line:match("^(%s*)")
                if col == 1 then
                    -- At start of checkbox line: insert new checkbox above
                    return "<Esc>O<C-u>" .. indent .. "- [ ] "
                else
                    -- After content: add new checkbox below
                    return "<Esc>o<C-u>" .. indent .. "- [ ] "
                end
            end

            -- Numbered list with content: continue with (N+1).
            local indent, num = line:match("^(%s*)(%d+)%.%s")
            if num then
                local next_num = tonumber(num) + 1
                return "<CR>" .. indent .. next_num .. ". "
            end

            -- Normal Enter (formatoptions 'r' will auto-continue bullets)
            return "<CR>"
        end, { buffer = true, expr = true, desc = "Smart Enter: bullets, checkboxes, numbered lists" })

        -- Smart `o`: continue checkbox / numbered list on new line below
        vim.keymap.set("n", "o", function()
            local line = vim.api.nvim_get_current_line()
            local function open_below(text)
                local row = vim.api.nvim_win_get_cursor(0)[1]
                vim.api.nvim_buf_set_lines(0, row, row, false, { text })
                vim.api.nvim_win_set_cursor(0, { row + 1, #text })
                vim.cmd("startinsert!")
                return row + 1
            end
            local function renumber_following(start_row, indent, next_num)
                local line_count = vim.api.nvim_buf_line_count(0)
                for row = start_row, line_count do
                    local following = vim.api.nvim_buf_get_lines(0, row - 1, row, false)[1]
                    local item_indent, suffix = following:match("^(%s*)%d+(%.%s.*)$")
                    if item_indent == indent then
                        vim.api.nvim_buf_set_lines(
                            0, row - 1, row, false, { indent .. next_num .. suffix })
                        next_num = next_num + 1
                    elseif item_indent and #item_indent > #indent then
                        -- Nested numbered item: leave it unchanged and keep scanning.
                    elseif following:match("^%s*$") then
                        break
                    else
                        local following_indent = following:match("^(%s*)")
                        if #following_indent <= #indent then
                            break
                        end
                    end
                end
            end
            if line:match("^%s*[%-%*%+]%s%[.%]") then
                local indent = line:match("^(%s*)")
                open_below(indent .. "- [ ] ")
                return
            end
            local indent, num = line:match("^(%s*)(%d+)%.%s")
            if num then
                local next_num = tonumber(num) + 1
                local inserted_row = open_below(indent .. next_num .. ". ")
                renumber_following(inserted_row + 1, indent, next_num + 1)
                return
            end
            -- Feed raw `o` (noremap) so default behavior runs normally
            vim.api.nvim_feedkeys(
                vim.api.nvim_replace_termcodes("o", true, false, true),
                "n", false)
        end, { buffer = true, desc = "Smart o: continue checkbox / numbered list" })

        -- Smart `O`: continue checkbox / numbered list on new line above.
        -- For numbers: inserts (N-1). above when N>1, else 1. — the current
        -- line's number is intentionally left as-is (markdown renderers
        -- auto-renumber, and renumbering the whole sequence is out of scope).
        vim.keymap.set("n", "O", function()
            local line = vim.api.nvim_get_current_line()
            if line:match("^%s*[%-%*%+]%s%[.%]") then
                local indent = line:match("^(%s*)")
                vim.api.nvim_feedkeys(
                    vim.api.nvim_replace_termcodes("O<C-u>" .. indent .. "- [ ] ", true, false, true),
                    "n", false)
                return
            end
            local indent, num = line:match("^(%s*)(%d+)%.%s")
            if num then
                local prev_num = math.max(1, tonumber(num) - 1)
                vim.api.nvim_feedkeys(
                    vim.api.nvim_replace_termcodes(
                        "O<C-u>" .. indent .. prev_num .. ". ", true, false, true),
                    "n", false)
                return
            end
            -- Feed raw `O` (noremap) so default behavior runs normally
            vim.api.nvim_feedkeys(
                vim.api.nvim_replace_termcodes("O", true, false, true),
                "n", false)
        end, { buffer = true, desc = "Smart O: continue checkbox / numbered list" })

        -- Smart Tab: indent current list item (bullet OR numbered)
        vim.keymap.set("i", "<Tab>", function()
            local line = vim.api.nvim_get_current_line()
            if line:match("^%s*[%-%*%+]%s") or line:match("^%s*%d+%.%s") then
                return "<C-t>" -- Indent the line
            else
                return "<Tab>" -- Normal tab behavior
            end
        end, { buffer = true, expr = true, desc = "Smart Tab: indent bullets / numbered lists" })

        -- Smart Shift-Tab: unindent current list item (bullet OR numbered)
        vim.keymap.set("i", "<S-Tab>", function()
            local line = vim.api.nvim_get_current_line()
            if line:match("^%s*[%-%*%+]%s") or line:match("^%s*%d+%.%s") then
                return "<C-d>"   -- Unindent the line
            else
                return "<S-Tab>" -- Normal shift-tab behavior
            end
        end, { buffer = true, expr = true, desc = "Smart Shift-Tab: unindent bullets / numbered lists" })

        -- Toggle checkbox checked state: `- [ ]` <-> `- [x]`
        vim.keymap.set({ "n", "v" }, "<leader>t", function()
            local vstart = vim.fn.line("v")
            local vend = vim.fn.line(".")
            local first = math.min(vstart, vend)
            local last = math.max(vstart, vend)
            for lnum = first, last do
                local line = vim.fn.getline(lnum)
                local new_line
                if line:match("^%s*[%-%*%+]%s+%[ %]") then
                    new_line = line:gsub("(%[)%s(%])", "%1x%2", 1)
                elseif line:match("^%s*[%-%*%+]%s+%[[xX]%]") then
                    new_line = line:gsub("(%[)[xX](%])", "%1 %2", 1)
                elseif line:match("^%s*[%-%*%+]%s") then
                    -- Plain bullet: add an unchecked checkbox
                    new_line = line:gsub("^(%s*[%-%*%+]%s+)", "%1[ ] ", 1)
                end
                if new_line then
                    vim.fn.setline(lnum, new_line)
                end
            end
        end, { buffer = true, desc = "Toggle checkbox" })

        vim.keymap.set("n", "<leader>ga", function()
            require("plugins.gemini_markdown").answer_current_prompt()
        end, { buffer = true, desc = "Gemini: Answer G> prompt" })

        vim.keymap.set("n", "<leader>mr", "<cmd>MarkdownRenderToggle<cr>", {
            buffer = true,
            desc = "Markdown: Toggle rendered view",
        })

        vim.treesitter.start()
    end,
    desc = "Enable markdown rendering with smart bullet behavior",
})

-- Reload file when it changes on disk — works in insert mode too.
-- Triggers:
--   FocusGained / BufEnter→ window regained focus / switched buffers
--   CursorHold        → fires ~updatetime (200ms) after cursor idle in normal mode
--   CursorHoldI       → same, but in INSERT mode (this is the key missing piece)
-- The `mode() ~= "c"` guard skips reloads while the command-line is open.
-- The buftype guard skips terminal / prompt / quickfix buffers.
vim.opt.autoread = true -- explicit; nvim default but be defensive
autocmd({ "FocusGained", "BufEnter", "CursorHold", "CursorHoldI" }, {
    pattern = "*",
    callback = function()
        if vim.fn.mode() ~= "c" and vim.bo.buftype == "" and vim.fn.filereadable(vim.fn.expand("%")) == 1 then
            vim.cmd("silent! checktime")
        end
    end,
    desc = "Reload buffer when file changes on disk (works in insert mode)",
})

-- When the reload actually happens, tell the user — helpful because it can
-- feel invisible when your text just changes under you.
autocmd("FileChangedShellPost", {
    pattern = "*",
    callback = function()
        vim.notify("Buffer reloaded (external change on disk)", vim.log.levels.INFO)
    end,
})

local save_augroup = vim.api.nvim_create_augroup("AutoSaveGroup", { clear = true })

local function save_valid_buffer()
    local buf_path = vim.api.nvim_buf_get_name(0)

    if buf_path ~= "" and vim.bo.modifiable and vim.bo.modified and vim.fn.filereadable(buf_path) == 1 then
        pcall(vim.cmd.write)
    end
end
autocmd({ "BufLeave", "VimLeave", "FocusLost" }, {
    group = save_augroup,
    callback = save_valid_buffer,
})

-- =============================================================================
-- NEO-TREE CLEANUP
-- =============================================================================

autocmd("VimLeavePre", {
    callback = function()
        -- Close neo-tree before exiting to prevent session/state issues
        -- Only close if it's actually open to avoid unnecessary overhead
        for _, win in ipairs(vim.api.nvim_list_wins()) do
            local buf = vim.api.nvim_win_get_buf(win)
            if vim.api.nvim_buf_is_valid(buf) and vim.bo[buf].filetype == "neo-tree" then
                pcall(vim.cmd, "Neotree close")
                break
            end
        end
    end,
    desc = "Close neo-tree before exiting Neovim",
})

-- =============================================================================
-- SCROLLOFF AT END OF FILE
-- =============================================================================

local SCROLLOFF = 15

vim.keymap.set("n", "j", function()
    local cur = vim.fn.line(".")
    local last = vim.fn.line("$")

    if cur >= last then return end

    local lines_to_eof = last - cur
    local win_height = vim.api.nvim_win_get_height(0)

    if lines_to_eof <= SCROLLOFF and last > (win_height - SCROLLOFF) then
        -- Near EOF and file is long enough that scrolloff padding matters
        vim.api.nvim_feedkeys("j" .. vim.api.nvim_replace_termcodes("<C-e>", true, false, true), "n", false)
    else
        vim.api.nvim_feedkeys("j", "n", false)
    end
end, { noremap = true, silent = true })

vim.keymap.set("n", "k", function()
    local cur = vim.fn.line(".")
    local last = vim.fn.line("$")

    if cur <= 1 then return end

    local lines_to_eof = last - cur

    local win_height = vim.api.nvim_win_get_height(0)
    if lines_to_eof < SCROLLOFF and last > (win_height - SCROLLOFF) then
        -- Near EOF going up and file is long enough that scrolloff padding matters
        vim.api.nvim_feedkeys("k" .. vim.api.nvim_replace_termcodes("<C-y>", true, false, true), "n", false)
    else
        vim.api.nvim_feedkeys("k", "n", false)
    end
end, { noremap = true, silent = true })

-- =============================================================================
-- CLEANUP ORPHANED NVIM PROCESSES
-- =============================================================================
-- fzf-lua spawns "nvim --embed" helper processes for previews.
-- These can become orphaned and spin at 100% CPU if the picker is dismissed
-- abnormally. Kill any that are using excessive CPU on FocusGained.

local function cleanup_orphaned_nvim()
    local my_pid = vim.fn.getpid()
    local result = vim.fn.systemlist(
        "ps -eo pid,ppid,%cpu,command | grep 'nvim --embed' | grep -v grep"
    )
    for _, line in ipairs(result) do
        local pid, ppid, cpu = line:match("^%s*(%d+)%s+(%d+)%s+(%d+%.?%d*)")
        if pid and ppid and cpu then
            pid = tonumber(pid)
            ppid = tonumber(ppid)
            cpu = tonumber(cpu)
            -- Only kill children of THIS nvim that are spinning at >80% CPU
            if ppid == my_pid and cpu > 80 then
                vim.fn.system("kill -9 " .. pid)
            end
        end
    end
end

autocmd("FocusGained", {
    callback = function()
        vim.defer_fn(cleanup_orphaned_nvim, 1000)
    end,
})
