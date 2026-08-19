-- Disable netrw to prevent conflicts
vim.g.loaded_netrw = 1
vim.g.loaded_netrwPlugin = 1

-- Keep the file tree distinct from editor windows.
vim.api.nvim_set_hl(0, "NeoTreeNormal", { bg = "#000000" })
vim.api.nvim_set_hl(0, "NeoTreeNormalNC", { bg = "#000000" })
vim.api.nvim_set_hl(0, "NeoTreeEndOfBuffer", { bg = "#000000" })
vim.api.nvim_set_hl(0, "NeoTreeWinBar", { bg = "#000000", fg = "#000000" })
vim.api.nvim_set_hl(0, "NeoTreeWinBarNC", { bg = "#000000", fg = "#000000" })

-- Show Neo-tree's cursor line only while the tree itself has focus.
local cursorline_group = vim.api.nvim_create_augroup("NeoTreeFocusedCursorLine", { clear = true })
vim.api.nvim_create_autocmd({ "WinEnter", "BufWinEnter" }, {
    group = cursorline_group,
    callback = function()
        if vim.bo.filetype == "neo-tree" then vim.wo.cursorline = true end
    end,
})
vim.api.nvim_create_autocmd("WinLeave", {
    group = cursorline_group,
    callback = function()
        if vim.bo.filetype == "neo-tree" then vim.wo.cursorline = false end
    end,
})

local function open_file(state)
    local node = state.tree:get_node()
    if node.type ~= "file" then
        require("neo-tree.sources.filesystem.commands").toggle_node(state)
        return
    end

    if node.path:lower():match("%.pdf$") then
        vim.fn.jobstart({ "open", "-a", "Google Chrome", node.path }, { detach = true })
        return
    end

    require("neo-tree.sources.filesystem.commands").open(state)
end

-- Neo-tree renders its root directory as a path (for example, `~/dotfiles`).
-- Keep only the final directory name in the root row (`dotfiles`).
local default_name_component = require("neo-tree.sources.common.components").name
local function name_component(config, node, state)
    if node:get_depth() == 1 and node.path then
        local original_name = node.name
        node.name = vim.fn.fnamemodify(node.path, ":t")
        if node.name == "" then node.name = "/" end
        local result = default_name_component(config, node, state)
        node.name = original_name
        return result
    end
    return default_name_component(config, node, state)
end

require("neo-tree").setup({
    source_selector                 = {
        winbar               = false,
        statusline           = false,
        content_layout       = "center",
        sources              = {
            { source = "filesystem", display_name = "Files" },
        },
        highlight_tab        = "NeoTreeTabInactive",
        highlight_tab_active = "NeoTreeTabActive",
        highlight_background = "NeoTreeTabInactive",
    },
    close_if_last_window            = true,
    popup_border_style              = "single",
    enable_git_status               = true,
    enable_diagnostics              = true,
    open_files_do_not_replace_types = { "terminal", "trouble", "qf" },
    retain_hidden_root_indent       = false, -- Performance: don't indent hidden root
    event_handlers                  = {
        {
            event = "neo_tree_buffer_enter",
            handler = function()
                if vim.bo.filetype ~= "neo-tree" then return end
                vim.cmd("stopinsert")
                vim.cmd("setlocal nonumber norelativenumber signcolumn=no statuscolumn=")
                vim.bo.buflisted = false
                vim.wo.wrap = true
                vim.fn.winrestview({ leftcol = 0 })
            end,
        },
    },
    window                          = {
        position = "left",
        width = 25,
        auto_expand_width = false,
        mappings = {
            ["h"]             = "close_node",
            ["l"]             = open_file,
            -- Let the press select/focus its native target. On release inside
            -- Neo-tree, toggle only the selected expandable node (a folder).
            ["<LeftRelease>"] = "toggle_node",
            ["<2-LeftMouse>"] = open_file,
            ["<Left>"]        = "noop",
            ["<Right>"]       = "noop",
            ["<cr>"]          = open_file,
        },
    },
    filesystem                      = {
        components              = {
            name = name_component,
        },
        follow_current_file    = {
            enabled = false,
        },
        use_libuv_file_watcher = true,
        git_status_async       = true,
        async_directory_scan   = "auto",      -- Performance: scan dirs async
        scan_mode              = "shallow",   -- Performance: don't scan deeply on startup
        hijack_netrw_behavior  = "disabled",
        filtered_items         = {
            visible         = false,
            hide_dotfiles   = false,
            hide_gitignored = false,
        },
    },
    default_component_configs       = {
        name = {
            trailing_slash        = false,
            use_git_status_colors = true,
            highlight             = "NeoTreeFileName",
        },
        container = {
            enable_character_fade = false, -- Performance: disable fade animation
            width                 = "100%",
            right_padding         = 0,
        },
        git_status = {
            symbols = {
                -- Use simple symbols for better performance
                added     = "+",
                modified  = "~",
                deleted   = "-",
                renamed   = "→",
                untracked = "?",
                ignored   = "◌",
                unstaged  = "✗",
                staged    = "✓",
                conflict  = "!",
            },
        },
    },
    renderers                       = {
        file = {
            { "indent" },
            { "icon" },
            { "container", content = { { "name", use_git_status_colors = true, zindex = 10 } } },
        },
        directory = {
            { "indent" },
            { "icon" },
            { "container", content = { { "name", zindex = 10 } } },
        },
    },
})

local min_width = 90

local function neo_tree_is_open()
    for _, win in ipairs(vim.api.nvim_list_wins()) do
        local buf = vim.api.nvim_win_get_buf(win)
        if vim.api.nvim_buf_is_valid(buf) and vim.bo[buf].filetype == "neo-tree" then
            return true
        end
    end
    return false
end

local function refresh_git()
    if not package.loaded["neo-tree.sources.manager"] then return end
    local manager = require("neo-tree.sources.manager")
    manager.refresh("filesystem")
    manager.refresh("git_status")
end

-- Refresh after saving a file (debounced)
local save_timer = nil
vim.api.nvim_create_autocmd("BufWritePost", {
    callback = function()
        if save_timer then
            vim.fn.timer_stop(save_timer)
        end
        save_timer = vim.fn.timer_start(200, function()
            refresh_git()
            save_timer = nil
        end)
    end,
})

-- Refresh when focus returns to nvim (debounced to avoid rapid refreshes)
local focus_timer = nil
vim.api.nvim_create_autocmd({ "FocusGained", "TermLeave" }, {
    callback = function()
        if focus_timer then
            vim.fn.timer_stop(focus_timer)
        end
        focus_timer = vim.fn.timer_start(300, function()
            refresh_git()
            focus_timer = nil
        end)
    end,
})

vim.api.nvim_create_autocmd("DirChanged", {
    callback = refresh_git,
})

-- Refresh after any shell command (e.g. git cli run from nvim terminal)
vim.api.nvim_create_autocmd("ShellCmdPost", {
    callback = function()
        local cmd = vim.v.event.cmd or ""
        if cmd:match("^git") then refresh_git() end
    end,
})

vim.api.nvim_create_autocmd("VimResized", {
    callback = function()
        if vim.o.columns < min_width and neo_tree_is_open() then
            vim.cmd("Neotree close")
        end
    end,
})
