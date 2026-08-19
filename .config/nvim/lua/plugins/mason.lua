require("mason-tool-installer").setup({
    -- Enforce external tools at startup; unlike LSP auto-install this also
    -- installs tools that have never been configured in a buffer yet.
    ensure_installed = { "prettier", "isort", "black", "eslint_d", "gopls" },
})
