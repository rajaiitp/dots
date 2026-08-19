-- Inline diagnostics
vim.diagnostic.config({
    virtual_text     = true,
    virtual_lines    = false,
    signs            = true,
    underline        = false,
    update_in_insert = false,
    severity_sort    = true,
    float = {
        border     = "single",
        max_width  = math.floor(vim.o.columns * 0.9),
        max_height = math.floor(vim.o.lines   * 0.9),
    },
})

-- No highlight overrides — rose-pine drives LspReference* styling.

-- Silence progress handlers (noice handles these)
vim.lsp.handlers["$/progress"]       = function() end
vim.lsp.handlers["window/progress"]  = function() end

local publish_diagnostics = vim.lsp.handlers["textDocument/publishDiagnostics"]
vim.lsp.handlers["textDocument/publishDiagnostics"] = function(err, result, ctx, config)
    local bufnr = result and result.uri and vim.uri_to_bufnr(result.uri)
    if bufnr and vim.b[bufnr].diagnostics_settling then
        return
    end
    return publish_diagnostics(err, result, ctx, config)
end

-- Shim deprecated API for plugins still calling it on newer Neovim
if vim.lsp.get_clients and vim.lsp.get_active_clients then
    vim.lsp.get_active_clients = vim.lsp.get_clients
end

-- Large LSP floating previews
local orig_util_open_floating_preview = vim.lsp.util.open_floating_preview
function vim.lsp.util.open_floating_preview(contents, syntax, opts, ...)
    opts            = opts or {}
    opts.border     = "single"
    opts.max_width  = math.floor(vim.o.columns * 0.9)
    opts.max_height = math.floor(vim.o.lines   * 0.9)
    return orig_util_open_floating_preview(contents, syntax, opts, ...)
end

local lspconfig       = require("lspconfig")
local mason_lspconfig = require("mason-lspconfig")
-- fzf-lua is required lazily inside LspAttach so it's always loaded by then

local function buf_supports_method(bufnr, method)
    for _, client in ipairs(vim.lsp.get_clients({ bufnr = bufnr })) do
        if client:supports_method(method) then return true end
    end
    return false
end

local function settle_diagnostics(bufnr)
    vim.b[bufnr].diagnostics_settling = true
    vim.diagnostic.reset(nil, bufnr)
    vim.defer_fn(function()
        if not vim.api.nvim_buf_is_valid(bufnr) then return end
        vim.b[bufnr].diagnostics_settling = false
        vim.cmd("redrawstatus")
    end, 1500)
end

-- Mason setup
require("mason").setup({
    ui = {
        icons = {
            package_installed   = "✓",
            package_pending     = "➜",
            package_uninstalled = "✗",
        },
    },
})

require("mason-lspconfig").setup({
    automatic_installation = true,
    ensure_installed = {
        "lua_ls", "emmet_ls", "graphql", "svelte", "html",
        "cssls", "tailwindcss", "prismals", "pyright", "ruff", "gopls",
    },
})

-- lazydev for Neovim Lua development
require("lazydev").setup({
    library = {
        { path = "${3rd}/luv/library", words = { "vim%.uv" } },
    },
})

-- lsp-file-operations
require("lsp-file-operations").setup()

local on_attach = function(client, bufnr)
    if not vim.api.nvim_buf_is_valid(bufnr) then return end
    local conform_ok, conform = pcall(require, "conform")
    if conform_ok and #conform.list_formatters_to_run(bufnr) > 0 then
        client.server_capabilities.document_formatting       = false
        client.server_capabilities.document_range_formatting = false
    end
end

vim.api.nvim_create_autocmd("LspAttach", {
    group = vim.api.nvim_create_augroup("UserLspConfig", {}),
    callback = function(ev)
        settle_diagnostics(ev.buf)
        on_attach(vim.lsp.get_client_by_id(ev.data.client_id), ev.buf)
        local opts = { buffer = ev.buf, silent = true }
        local fzf  = require("fzf-lua")

        opts.desc = "LSP: Definition"
        vim.keymap.set("n", "gd", fzf.lsp_definitions, opts)
        opts.desc = "LSP: References"
        vim.keymap.set("n", "fu", fzf.lsp_references, opts)
        opts.desc = "LSP: Implementations"
        vim.keymap.set("n", "ga", fzf.lsp_implementations, opts)
        opts.desc = "LSP: Code actions"
        vim.keymap.set({ "n", "v" }, "<leader>ca", function()
            fzf.lsp_code_actions({ 
                winopts = { fullscreen = false, height = 0.525, width = 0.6 },
                previewer = false
            })
        end, opts)
        opts.desc = "LSP: Hover"
        vim.keymap.set("n", "K", vim.lsp.buf.hover, opts)
        if buf_supports_method(ev.buf, "textDocument/signatureHelp") then
            opts.desc = "LSP: Signature help"
            vim.keymap.set("i", "<C-k>", vim.lsp.buf.signature_help, opts)

            -- Auto signature help on ( or ,
            vim.api.nvim_create_autocmd("CursorMovedI", {
                buffer = ev.buf,
                callback = function()
                    local line = vim.api.nvim_get_current_line()
                    local col = vim.api.nvim_win_get_cursor(0)[2]
                    if line:sub(1, col):match("[%(,]%s*$") then
                        vim.lsp.buf.signature_help()
                    end
                end,
            })
        end

        opts.desc = "LSP: Rename"
        vim.keymap.set("n", "<leader>rn", vim.lsp.buf.rename, opts)

        local client = vim.lsp.get_client_by_id(ev.data.client_id)

        -- client:supports_method() is the new API in 0.12 (colon, not dot)
        -- All capability enables use { bufnr = N } filter table, not bare number

        -- Inlay hints (built-in)
        if client and client:supports_method("textDocument/inlayHint") then
            vim.lsp.inlay_hint.enable(true, { bufnr = ev.buf })
        end

        -- Document highlight — highlight all refs to symbol under cursor
        if client and client:supports_method("textDocument/documentHighlight") then
            local hl_group = vim.api.nvim_create_augroup("lsp_doc_highlight_" .. ev.buf, { clear = true })
            vim.api.nvim_create_autocmd("CursorHold", {
                buffer = ev.buf, group = hl_group,
                callback = function() vim.lsp.buf.document_highlight() end,
            })
            vim.api.nvim_create_autocmd({ "CursorMoved", "InsertEnter" }, {
                buffer = ev.buf, group = hl_group,
                callback = function() vim.lsp.buf.clear_references() end,
            })
        end

        -- document_color is ON by default in 0.12 — no explicit enable needed

        -- Code lenses — display as virtual lines, refresh on save/leave insert
        if client and client:supports_method("textDocument/codeLens") then
            vim.lsp.codelens.enable(true, { bufnr = ev.buf })
            opts.desc = "LSP: Run codelens"
            vim.keymap.set({ "n", "v" }, "grx", vim.lsp.codelens.run, opts)
        end

        -- On-type formatting (built-in 0.12)
        if client and client:supports_method("textDocument/onTypeFormatting") then
            vim.lsp.on_type_formatting.enable(true, { bufnr = ev.buf })
        end

        -- Linked editing range — auto-rename paired HTML tags
        if client and client:supports_method("textDocument/linkedEditingRange") then
            vim.lsp.linked_editing_range.enable(true, { bufnr = ev.buf })
        end

        -- Symbols / call hierarchy
        opts.desc = "LSP: Symbols outline"
        vim.keymap.set("n", "go", function()
            fzf.lsp_document_symbols({
                winopts = { fullscreen = true, preview = { layout = "vertical", vertical = "down:65%" } },
            })
        end, opts)
        opts.desc = "LSP: Incoming calls"
        vim.keymap.set("n", "gc", fzf.lsp_incoming_calls, opts)
        opts.desc = "LSP: Outgoing calls"
        vim.keymap.set("n", "gC", fzf.lsp_outgoing_calls, opts)
    end,
})

local capabilities = require("blink.cmp").get_lsp_capabilities()

local function setup_lsp_handlers()
    if not mason_lspconfig.setup_handlers then
        vim.defer_fn(setup_lsp_handlers, 100)
        return
    end
    mason_lspconfig.setup_handlers({
        function(server_name)
            if server_name == "pylsp" or server_name == "ruff_lsp" then return end
            lspconfig[server_name].setup({ capabilities = capabilities, on_attach = on_attach })
        end,
        ["svelte"] = function()
            lspconfig["svelte"].setup({
                capabilities = capabilities,
                on_attach = function(client, bufnr)
                    on_attach(client, bufnr)
                    vim.api.nvim_create_autocmd("BufWritePost", {
                        pattern  = { "*.js", "*.ts" },
                        callback = function(ctx)
                            client.notify("$/onDidChangeTsOrJsFile", { uri = ctx.match })
                        end,
                    })
                end,
            })
        end,
        ["graphql"] = function()
            lspconfig["graphql"].setup({
                capabilities = capabilities,
                filetypes    = { "graphql", "gql", "svelte", "typescriptreact", "javascriptreact" },
                on_attach    = on_attach,
            })
        end,
        ["emmet_ls"] = function()
            lspconfig["emmet_ls"].setup({
                capabilities = capabilities,
                filetypes    = { "html","typescriptreact","javascriptreact","css","sass","scss","less","svelte" },
                on_attach    = on_attach,
            })
        end,
        ["lua_ls"] = function()
            lspconfig["lua_ls"].setup({
                capabilities = capabilities,
                settings     = {
                    Lua = {
                        diagnostics = {
                            globals = { "vim" },
                        },
                        workspace = {
                            checkThirdParty = false,
                            library = vim.api.nvim_get_runtime_file("", true),
                        },
                        telemetry = { enable = false },
                    },
                },
                on_attach    = on_attach,
            })
        end,
        ["pyright"] = function()
            lspconfig["pyright"].setup({
                capabilities = capabilities,
                settings     = {
                    python = {
                        analysis = {
                            typeCheckingMode       = "basic",
                            useLibraryCodeForTypes = true,
                            diagnosticMode         = "workspace",
                        },
                    },
                },
                filetypes    = { "python" },
                init_options = {
                    interpreter = {
                        properties = {
                            InterpreterPath = vim.fn.exepath("python3"),
                            Version         = "3.12",
                        },
                    },
                },
                on_attach = on_attach,
            })
        end,
        ["ruff"] = function()
            local ruff_cap = require("blink.cmp").get_lsp_capabilities()
            ruff_cap.workspace.applyEdit = true
            lspconfig["ruff"].setup({
                capabilities = ruff_cap,
                init_options = { settings = { args = {} } },
                on_attach    = on_attach,
            })
        end,
    })
end

setup_lsp_handlers()
