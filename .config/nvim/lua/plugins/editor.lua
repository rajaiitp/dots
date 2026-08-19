-- gitsigns
require("gitsigns").setup({
    current_line_blame = false,
    current_line_blame_opts = {
        virt_text     = true,
        virt_text_pos = "eol",
        delay         = 200,
        ignore_whitespace = true,
    },
    current_line_blame_formatter = "  <author>, <author_time:%R> • <summary>",
    signs = {
        add          = { text = "│" },
        change       = { text = "│" },
        delete       = { text = "_" },
        topdelete    = { text = "‾" },
        changedelete = { text = "~" },
        untracked    = { text = "┆" },
    },
    signs_staged_enable = false,
    signcolumn          = true,
    linehl              = false,  -- controlled by global toggle
    word_diff           = false,  -- disable word-level diff (keep clean red background)
    on_attach = function(bufnr)
        local gs = package.loaded.gitsigns
        local function map(mode, l, r, opts)
            opts        = opts or {}
            opts.buffer = bufnr
            vim.keymap.set(mode, l, r, opts)
        end
        
        -- Hunk navigation (silent, no notifications)
        map("n", "}", function()
            gs.next_hunk({ navigation_message = false })
        end, { desc = "Git: Next hunk" })
        map("n", "{", function()
            gs.prev_hunk({ navigation_message = false })
        end, { desc = "Git: Prev hunk" })
        
        -- Hunk operations
        map("n", "<leader>hs", gs.stage_hunk, { desc = "Git: Stage hunk" })
        map("n", "<leader>hr", gs.reset_hunk, { desc = "Git: Reset hunk" })
        map("n", "<leader>hu", gs.undo_stage_hunk, { desc = "Git: Undo stage hunk" })
        map("n", "<leader>hp", gs.preview_hunk, { desc = "Git: Preview hunk" })
        
        -- Visual mode staging
        map("v", "<leader>hs", function() gs.stage_hunk({vim.fn.line('.'), vim.fn.line('v')}) end, { desc = "Git: Stage hunk" })
        map("v", "<leader>hr", function() gs.reset_hunk({vim.fn.line('.'), vim.fn.line('v')}) end, { desc = "Git: Reset hunk" })
        
        -- Blame
        map("n", "ghb", gs.toggle_current_line_blame, { desc = "Git: Toggle inline blame" })
        map("n", "ghB", function() gs.blame_line({ full = true }) end, { desc = "Git: Blame line (full)" })
    end,
})

-- mini.nvim
require("mini.surround").setup()
require("mini.ai").setup({
    n_lines = 500,
    custom_textobjects = {
        o = require("mini.ai").gen_spec.treesitter({
            a = { "@block.outer", "@conditional.outer", "@loop.outer" },
            i = { "@block.inner", "@conditional.inner", "@loop.inner" },
        }, {}),
        f = require("mini.ai").gen_spec.treesitter({ a = "@function.outer", i = "@function.inner" }, {}),
        c = require("mini.ai").gen_spec.treesitter({ a = "@class.outer",    i = "@class.inner"    }, {}),
        t = { "<([%p%w]-)%f[^<%w][^<>]->.-</%1>", "^<.->().*()</[^/]->$" },
        d = { "%f[%d]%d+" },
        e = {
            { "%u[%l%d]+%f[^%l%d]", "%f[%S][%l%d]+%f[^%l%d]", "%f[%P][%l%d]+%f[^%l%d]", "^[%l%d]+%f[^%l%d]" },
            "^().*()$",
        },
        u = require("mini.ai").gen_spec.function_call(),
        U = require("mini.ai").gen_spec.function_call({ name_pattern = "[%w_]" }),
    },
})

local miniclue = require("mini.clue")
miniclue.setup({
    triggers = {
        { mode = "n", keys = "<Leader>" },
        { mode = "x", keys = "<Leader>" },
        { mode = "i", keys = "<C-x>" },
        { mode = "n", keys = "'" },
        { mode = "n", keys = "`" },
        { mode = "x", keys = "'" },
        { mode = "x", keys = "`" },
        { mode = "n", keys = '"' },
        { mode = "x", keys = '"' },
        { mode = "i", keys = "<C-r>" },
        { mode = "c", keys = "<C-r>" },
        { mode = "n", keys = "<C-w>" },
        { mode = "n", keys = "z" },
        { mode = "x", keys = "z" },
    },
    clues = {
        miniclue.gen_clues.builtin_completion(),
        miniclue.gen_clues.marks(),
        miniclue.gen_clues.registers(),
        miniclue.gen_clues.windows(),
        miniclue.gen_clues.z(),
    },
})

-- autopairs
require("nvim-autopairs").setup()

-- Undotree and local-highlight are intentionally disabled.

-- document highlight (built-in LSP — highlights all refs to symbol under cursor)
-- wired in lsp.lua via LspAttach (see vim.lsp.buf.document_highlight)

-- =============================================================================
-- GIT — gitsigns gutter signs, blame, and hunk staging only.
-- All in-editor diff VIEWERS were removed (codediff.nvim + gitsigns-enhanced).
-- Full diff review now lives outside nvim: tmux prefix+g → fzf branch → fzf
-- commit → `hunk show <commit>` (see ~/.config/tmux/scripts/hunk_review.sh).
--
-- Remaining keymaps (wired in gitsigns on_attach above):
--   } / {      : next / prev hunk
--   <leader>hs : stage hunk       <leader>hr : reset hunk
--   <leader>hu : undo stage hunk  <leader>hp : preview hunk
--   ghb        : toggle inline blame   ghB : blame line (full)
-- =============================================================================
