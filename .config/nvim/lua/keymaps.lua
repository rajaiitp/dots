-- =============================================================================
-- KEYMAP CONFIGURATION
-- =============================================================================

local map = vim.keymap.set

-- =============================================================================
-- MODE/NAVIGATION OVERRIDES
-- =============================================================================
-- Smart insert mode (indent on empty lines)
local function IndentWithI()
    local line = vim.fn.getline(".")
    if #line == 0 or line:match("^%s*$") then
        return '"_cc'
    else
        return "i"
    end
end
map("n", "i", IndentWithI, { noremap = true, silent = true, expr = true, desc = "Smart insert mode" })

-- Insert mode shortcuts
map("i", ";;", "<Esc>A;", { noremap = true })
map("i", "jj", "<Esc>", { noremap = true, silent = true })
map("i", "kk", "<Esc>", { noremap = true, silent = true })

-- Navigation remaps
map({ "n", "v" }, ";", "%", { noremap = true, silent = true })
map({ "n", "v" }, ",", ";", { noremap = true, silent = true })

-- Center screen after jumps
map("n", "G", "Gzz", { noremap = true, silent = true })
map("n", "gg", "ggzz", { noremap = true, silent = true })
map("n", "gi", "gi<Esc>zzi", { noremap = true, silent = true })
map("n", "%", "%zz", { noremap = true, silent = true })
map("n", "`a", "`azz", { noremap = true, silent = true })
map("n", "'a", "'azz", { noremap = true, silent = true })

-- =============================================================================
-- CLIPBOARD & EDITING
-- =============================================================================

-- Clipboard operations
map({ "n", "v" }, "<leader>y", [["+y"]], { desc = "Copy to system clipboard" })
map("v", "p", '"_dP', { desc = "Paste without replacing clipboard" })

-- Change without yanking (delete yanks normally)
map("n", "c", '"_c', { noremap = true, silent = true, desc = "Change" })

-- Copy file path (uses vim.notify so it's visible with cmdheight=0)
local function copy_full_path()
    local full_path = vim.fn.expand("%:p")
    vim.fn.setreg("+", full_path)
    vim.notify("Copied: " .. full_path, vim.log.levels.INFO)
end
map("n", "<leader>yp", copy_full_path, { desc = "Copy file path" })

-- =============================================================================
-- LINE MANIPULATION
-- =============================================================================

-- Move lines
map("n", "<A-j>", ":m .+1<CR>==", { desc = "Move line down", silent = true })
map("n", "<A-k>", ":m .-2<CR>==", { desc = "Move line up", silent = true })
map("x", "<A-j>", function()
    vim.cmd([[silent! move '>+1]])
    vim.cmd([[silent! normal! gv=gv]])
end, { desc = "Move selection down", silent = true })
map("x", "<A-k>", function()
    vim.cmd([[silent! move '<-2]])
    vim.cmd([[silent! normal! gv=gv]])
end, { desc = "Move selection up", silent = true })

-- Indent/unindent
map("n", "<A-l>", ">>", { desc = "Indent line" })
map("n", "<A-h>", "<<", { desc = "Unindent line" })
map("v", "<A-l>", ">gv", { desc = "Indent selection" })
map("v", "<A-h>", "<gv", { desc = "Unindent selection" })

-- Disable conflicting keys
map("n", "<C-f>", "<Nop>", { noremap = true, silent = true })

-- =============================================================================
-- SEARCH & REPLACE
-- =============================================================================

map("n", "<leader>h", ":nohlsearch<CR>", { desc = "Clear search highlight", silent = true })
map("n", "<leader>rw", [[:%s/\<<C-r><C-w>\>/<C-r><C-w>/gI<Left><Left><Left>]], { desc = "Replace word" })
map("x", "<leader>/", 'y/<C-R>"<CR>N', { desc = "Search selection" })
map("n", "<leader>/", function()
    vim.fn.setreg("/", "\\<" .. vim.fn.expand("<cword>") .. "\\>")
    vim.cmd("normal! n")
    vim.cmd("set hlsearch")
end, { desc = "Search word under cursor" })

-- =============================================================================
-- FILE OPERATIONS
-- =============================================================================

map("n", "<leader>s", "<cmd>write<CR>", { desc = "Save file" })

-- =============================================================================
-- BUFFERS
-- =============================================================================

-- Switch to alternate buffer
map("n", "<leader>i", "<cmd>b#<CR>", { desc = "Switch to last buffer", silent = true })

-- Move through listed buffers
map("n", "<C-l>", "<cmd>bnext<CR>", { desc = "Next buffer", silent = true })
map("n", "<C-h>", "<cmd>bprevious<CR>", { desc = "Previous buffer", silent = true })

-- Close current buffer and switch to previous
map("n", "<C-q>", "<cmd>bp|bd#<CR>", { desc = "Close buffer, switch to last", silent = true })

-- =============================================================================
-- UI
-- =============================================================================

map("n", "<leader>ww", function()
    vim.opt_local.wrap = not vim.wo.wrap
end, { desc = "Toggle word wrap" })

-- =============================================================================
-- CONFIG RESTART
-- =============================================================================

map("n", "<leader>R", function()
    require("core.restart").restart()
end, { desc = "Restart nvim (tmux)" })

-- =============================================================================
-- PLUGINS
-- =============================================================================

map("n", "gt", "<cmd>Neotree filesystem toggle left<CR>", { desc = "Toggle Neo-tree" })
map("n", "<leader>gg", "<cmd>LazyGit<CR>", { desc = "LazyGit" })
map("n", "<leader>gb", function()
    require("fzf-lua").git_branches({
        winopts = {
            fullscreen = false,
            height = 0.4,
            width = 0.5,
            row = 0.3,
            preview = { hidden = "hidden" },
        },
    })
end, { desc = "Git: Switch branch" })

-- Git commit browsing with diff preview (using fzf-lua you already have!)
map("n", "<leader>gl", "<cmd>FzfLua git_commits<CR>", { desc = "Git: Browse commits with diff" })
map("n", "<leader>gf", "<cmd>FzfLua git_bcommits<CR>", { desc = "Git: File commit history" })
map("n", "<leader>gS", "<cmd>FzfLua git_status<CR>", { desc = "Git: Status with preview" })
