require("nvim-web-devicons").setup()

-- No color overrides — link everything to rose-pine's theme-managed groups.
vim.api.nvim_set_hl(0, "WinBar",      { link = "StatusLine" })
vim.api.nvim_set_hl(0, "WinBarNC",    { link = "StatusLineNC" })
vim.api.nvim_set_hl(0, "WinBarPath",  { link = "Comment" })
vim.api.nvim_set_hl(0, "WinBarFile",  { link = "Title" })
vim.api.nvim_set_hl(0, "WinBarMod",   { link = "DiagnosticWarn" })
vim.api.nvim_set_hl(0, "WinBarError", { link = "DiagnosticError" })
vim.api.nvim_set_hl(0, "WinBarWarn",  { link = "DiagnosticWarn" })
vim.api.nvim_set_hl(0, "WinBarInfo",  { link = "DiagnosticInfo" })
vim.api.nvim_set_hl(0, "WinBarHint",   { link = "DiagnosticHint" })
vim.api.nvim_set_hl(0, "WinBarBranch", { link = "DiagnosticInfo" })

local excluded_ft = { "neo-tree", "TelescopePrompt", "toggleterm", "help", "qf" }

local icons = {
    error    = "󰅖 ",
    warn     = "󰀦 ",
    info     = "󰋽 ",
    hint     = "󰌵 ",
    modified = "●",
    readonly = " ",
}

local function get_diagnostics()
    -- Use vim.diagnostic.status() (Neovim 0.12) for a compact summary string
    local bufnr  = vim.api.nvim_get_current_buf()
    if vim.b[bufnr].diagnostics_settling then return "" end
    local status = vim.diagnostic.status(bufnr)
    if status == "" then return "" end
    -- Map the status string to styled parts using our icons
    local diags  = vim.diagnostic.get(bufnr)
    local counts = { 0, 0, 0, 0 }
    for _, d in ipairs(diags) do
        counts[d.severity] = (counts[d.severity] or 0) + 1
    end
    local parts = {}
    if counts[1] > 0 then table.insert(parts, "%#WinBarError#" .. icons.error .. counts[1]) end
    if counts[2] > 0 then table.insert(parts, "%#WinBarWarn#"  .. icons.warn  .. counts[2]) end
    if counts[3] > 0 then table.insert(parts, "%#WinBarInfo#"  .. icons.info  .. counts[3]) end
    if counts[4] > 0 then table.insert(parts, "%#WinBarHint#"  .. icons.hint  .. counts[4]) end
    return table.concat(parts, " ")
end

-- Async breadcrumb cache: buf → { symbols, crumb }
local _crumb_cache = {}
local _branch_cache = {}
local _branch_pending = {}

local function find_symbol(symbols, line, depth)
    if depth > 5 then return nil end
    local best = nil
    for _, sym in ipairs(symbols or {}) do
        local r = sym.range or (sym.location and sym.location.range)
        if r and line >= r.start.line and line <= r["end"].line then
            best = sym.name
            local child = find_symbol(sym.children or {}, line, depth + 1)
            if child then best = best .. " › " .. child end
        end
    end
    return best
end

local function refresh_breadcrumbs(bufnr)
    local clients = vim.lsp.get_clients({ bufnr = bufnr })
    for _, client in ipairs(clients) do
        if client:supports_method("textDocument/documentSymbol") then
            local params = { textDocument = vim.lsp.util.make_text_document_params(bufnr) }
            vim.lsp.buf_request(bufnr, "textDocument/documentSymbol", params, function(_, result)
                if result then
                    _crumb_cache[bufnr] = result
                    -- Force winbar redraw
                    vim.schedule(function()
                        if vim.api.nvim_buf_is_valid(bufnr) then
                            vim.cmd("redrawstatus")
                        end
                    end)
                end
            end)
            break
        end
    end
end

local function get_breadcrumbs()
    local bufnr  = vim.api.nvim_get_current_buf()
    local symbols = _crumb_cache[bufnr]
    if not symbols then return "" end
    local line = vim.api.nvim_win_get_cursor(0)[1] - 1
    return find_symbol(symbols, line, 0) or ""
end

local function get_branch()
    local cwd = vim.fn.fnamemodify(vim.fn.expand("%:p:h"), ":p")
    if cwd == "" then return "" end
    if _branch_cache[cwd] ~= nil then return _branch_cache[cwd] end
    if not _branch_pending[cwd] then
        _branch_pending[cwd] = true
        vim.system({ "git", "-C", cwd, "branch", "--show-current" }, { text = true }, function(res)
            local branch = (res.stdout or ""):gsub("%s+", "")
            vim.schedule(function()
                _branch_cache[cwd] = res.code == 0 and branch or ""
                _branch_pending[cwd] = nil
                vim.cmd("redrawstatus")
            end)
        end)
    end
    return ""
end

local function build_winbar()
    if vim.tbl_contains(excluded_ft, vim.bo.filetype) then return "" end

    local absolute_path = vim.fn.expand("%:p")
    if absolute_path == "" then return " [No Name]" end
    local path = vim.fn.fnamemodify(absolute_path, ":.")

    local filename  = vim.fn.fnamemodify(path, ":t")
    local directory = vim.fn.fnamemodify(path, ":h")
    local ext       = vim.fn.fnamemodify(path, ":e")
    local ok, devicons = pcall(require, "nvim-web-devicons")
    local icon_str = ""
    if ok then
        local icon, icon_hl = devicons.get_icon(filename, ext, { default = true })
        icon_str = icon and ("%#" .. (icon_hl or "WinBar") .. "#" .. icon .. " ") or ""
    end

    -- Path relative to Neovim's current working directory, with filename highlighted.
    local path_str = "%#WinBarPath#" .. directory .. "/%#WinBarFile#" .. filename

    local mod      = vim.bo.modified and (" %#WinBarMod#" .. icons.modified) or ""
    local diag     = get_diagnostics()
    local diag_str = diag ~= "" and ("    " .. diag) or ""
    local line_str = string.format("    %%#WinBarPath#%d:%d", vim.fn.line("."), vim.fn.line("$"))
    local branch   = get_branch()
    local branch_str = branch ~= "" and ("%#WinBarBranch#" .. branch) or ""

    return " " .. icon_str .. path_str .. mod .. line_str .. diag_str .. "%=" .. branch_str .. "%*"
end

_G.Winbar = build_winbar

vim.api.nvim_create_autocmd({ "BufEnter", "BufModifiedSet", "WinEnter", "DiagnosticChanged", "CursorMoved" }, {
    callback = function()
        local win_config = vim.api.nvim_win_get_config(0)
        if win_config.relative ~= "" then return end
        if vim.bo.filetype == "neo-tree" then return end
        if not vim.tbl_contains(excluded_ft, vim.bo.filetype) then
            vim.wo.winbar = "%{%v:lua.Winbar()%}"
        else
            vim.wo.winbar = ""
        end
    end,
})

-- LSP symbol breadcrumbs are no longer displayed (winbar shows just the
-- filename), so the async symbol-fetching autocmd is disabled to avoid
-- pointless documentSymbol requests. The find_symbol/get_breadcrumbs/
-- refresh_breadcrumbs helpers above are left dormant for easy re-enable.
-- vim.api.nvim_create_autocmd({ "BufEnter", "CursorHold", "BufWritePost" }, {
--     callback = function()
--         local bufnr = vim.api.nvim_get_current_buf()
--         if vim.tbl_contains(excluded_ft, vim.bo.filetype) then return end
--         refresh_breadcrumbs(bufnr)
--     end,
-- })

vim.o.laststatus  = 0
vim.o.showtabline = 0
