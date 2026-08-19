local fzf = require("fzf-lua")

fzf.setup({
    -- Tighter matching + better sort order
    fzf_opts = {
        ["--algo"]     = "v1",                  -- stricter contiguous matching
        ["--scheme"]   = "default",
        ["--tiebreak"] = "length,index",        -- tie: shorter line → earlier in file
    },
    -- Sensible non-fullscreen default: a centered window (pickers WITH a preview
    -- use this). Preview-less pickers override with smaller sizes below.
    winopts = {
        height     = 0.80,
        width      = 0.80,
        row        = 0.50,
        col        = 0.50,
        border     = "single",
        preview    = {
            layout    = "horizontal",
            horizontal = "right:55%",
            border    = "single",
            scrollbar = false,
            wrap      = "wrap",
            winopts   = { wrap = true },
        },
    },
    files = {
        file_icons  = true,
        color_icons = true,
        rg_opts     = "--hidden --glob '!.git' --files",
    },
    grep = {
        rg_opts = "--hidden --column --line-number --no-heading --color=always --smart-case --max-columns=4096 -e",
        rg_glob = true,
    },
})

vim.keymap.set("n", "<leader>ff", function()
    fzf.files({
        previewer = false,
        winopts = {
            fullscreen = false,
            height     = 0.4,
            width      = 0.5,
            row        = 0.4,
            col        = 0.5,
            border     = "single",
        },
    })
end, { desc = "Go to file (compact, no preview)" })
-- Find string: live grep with glob support
-- Press Tab to insert " -- " for folder filtering
vim.keymap.set("n", "<leader>fs", function()
    fzf.live_grep({
        rg_opts = "--hidden --column --line-number --no-heading --color=always --ignore-case --max-columns=4096 -e",
        fzf_opts = {
            ["--smart-case"] = true,
        },
        keymap = {
            fzf = { ["tab"] = "put( -- )" },
        },
        formatter = "path.filename_first",
        winopts = {
            height = 0.85, width = 0.85, row = 0.5, col = 0.5,
            preview = { layout = "vertical", vertical = "down:55%" },
        },
    })
end, { desc = "Find string (Tab to add path filter)" })

-- Buffers + recent files: small, no preview (just a short list to pick from).
local compact = { fullscreen = false, height = 0.40, width = 0.45, row = 0.4, col = 0.5, border = "single" }
vim.keymap.set("n", "<leader>fb", function()
    fzf.buffers({ previewer = false, winopts = compact })
end, { desc = "Find buffer" })
vim.keymap.set("n", "gO", function()
    fzf.oldfiles({ previewer = false, winopts = compact })
end, { desc = "Go to old/recent file" })

require("todo-comments").setup({
    keywords = {
        HEADING    = { color = "info", alt = { "TITLE", "HEAD" } },
        SECTION    = { color = "hint", alt = { "PART" } },
        SUBSECTION = { color = "hint" },
    },
})
