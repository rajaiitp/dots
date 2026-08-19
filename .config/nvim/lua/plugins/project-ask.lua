-- project-ask.lua
-- :Ask <question>   — query current project via llama-server (read-only)
-- :AskAnnotate      — toggle virtual-text explanations for logical sections
-- Auto-indexes ~/Dev and ~/.config, persists context, improves in background

local M = {}

-- ── Config ────────────────────────────────────────────────────────────────────
local DATA_DIR      = vim.fn.stdpath("data") .. "/project-ask/"
local LLAMA_URL     = "http://localhost:11434/v1/chat/completions"
local MODEL         = "/Users/raja.selvarajan/llama-models/Qwen3-4B-MLX-4bit"
local ROOTS         = { vim.fn.expand("~/Dev"), vim.fn.expand("~/.config") }
local MAX_CONTEXT   = 12000
local AUTO_ANNOTATE = false   -- toggle with :AskAutoAnnotate

vim.fn.mkdir(DATA_DIR, "p")

local _nvim_ready = false
vim.api.nvim_create_autocmd("VimEnter", {
    once = true,
    callback = function() _nvim_ready = true end,
})

local function notify(msg, level)
    if not _nvim_ready then return end
    vim.notify(msg, level)
end



-- ── Highlight ─────────────────────────────────────────────────────────────────
-- No color override — link to a rose-pine managed group.
vim.api.nvim_set_hl(0, "AskAnnotation", { link = "DiagnosticWarn" })
local ns = vim.api.nvim_create_namespace("project_ask_annotations")

-- ── Helpers ───────────────────────────────────────────────────────────────────
local function in_allowed(path)
    for _, r in ipairs(ROOTS) do
        if path:sub(1, #r) == r then return true end
    end
    return false
end

local function get_project_root()
    local path = vim.fn.expand("%:p:h")
    local markers = { ".git", "go.mod", "Cargo.toml", "pyproject.toml", "package.json", "Makefile" }
    local cur = path
    while cur ~= "/" and cur ~= "" do
        for _, m in ipairs(markers) do
            if vim.fn.isdirectory(cur .. "/" .. m) == 1
            or vim.fn.filereadable(cur .. "/" .. m) == 1 then
                return cur
            end
        end
        cur = vim.fn.fnamemodify(cur, ":h")
    end
    return path
end

local function project_id(root)   return vim.fn.sha256(root):sub(1, 16) end
local function context_path(root) return DATA_DIR .. project_id(root) .. "_context.txt" end
local function annotations_path(root, fname)
    return DATA_DIR .. project_id(root) .. "_" .. vim.fn.sha256(fname):sub(1, 8) .. "_ann.json"
end

-- Returns mtime of a path in seconds, or 0 if not found
local function file_mtime(path)
    local stat = vim.uv.fs_stat(path)
    return stat and stat.mtime.sec or 0
end

-- ── llama-server call (async, OpenAI-compatible, body via tmpfile) ───────────
local function call_qwen(prompt, callback)
    local tmp = os.tmpname()
    local fp  = io.open(tmp, "w")
    if not fp then callback("cannot open tmpfile", nil); return end
    fp:write(vim.fn.json_encode({
        model                = MODEL,
        messages             = { { role = "user", content = prompt } },
        stream               = false,
        chat_template_kwargs = { enable_thinking = false },
    }))
    fp:close()

    local chunks = {}
    vim.fn.jobstart(
        string.format("curl -s -X POST '%s' -H 'Content-Type: application/json' -d @'%s'", LLAMA_URL, tmp),
        {
            stdout_buffered = true,
            on_stdout = function(_, data)
                if data then
                    for _, l in ipairs(data) do
                        if l ~= "" then table.insert(chunks, l) end
                    end
                end
            end,
            on_exit = function()
                os.remove(tmp)
                local raw = table.concat(chunks)
                local ok, resp = pcall(vim.fn.json_decode, raw)
                if ok and resp and resp.choices and resp.choices[1] then
                    callback(nil, resp.choices[1].message.content)
                else
                    callback("parse error: " .. raw:sub(1, 80), nil)
                end
            end,
        }
    )
end

-- ── Context: read all source files in project ─────────────────────────────────
local function build_context(root)
    local exts = { "lua","py","js","ts","go","rs","sh","fish","vim","c","h","cpp","md","toml","yaml" }
    local pat   = "-name '*." .. table.concat(exts, "' -o -name '*.") .. "'"
    local cmd   = string.format(
        "find '%s' -type f \\( %s \\) "
        .. "-not -path '*/node_modules/*' -not -path '*/.git/*' "
        .. "-not -path '*/target/*' -not -path '*/dist/*' "
        .. "-not -path '*/build/*' -not -path '*/__pycache__/*' "
        .. "2>/dev/null | sort | head -200", root, pat)
    local parts = {}
    local total = 0
    for f in vim.fn.system(cmd):gmatch("[^\n]+") do
        local fp2 = io.open(f, "r")
        if fp2 then
            local content = fp2:read("*a"); fp2:close()
            local rel   = f:sub(#root + 2)
            local chunk = string.format("### %s\n%s\n", rel, content:sub(1, 2000))
            total = total + #chunk
            table.insert(parts, chunk)
            if total > 80000 then break end
        end
    end
    return table.concat(parts, "\n")
end

local loaded_contexts = {}

local function save_context(root, ctx)
    local fp = io.open(context_path(root), "w")
    if fp then fp:write(ctx); fp:close() end
end

local function load_context(root)
    if loaded_contexts[root] then return loaded_contexts[root] end
    local fp = io.open(context_path(root), "r")
    if fp then
        local ctx = fp:read("*a"); fp:close()
        loaded_contexts[root] = ctx
        return ctx
    end
    return nil
end

local indexing = {}

local function start_background_index(root)
    if indexing[root] then return end
    local stat = vim.uv.fs_stat(context_path(root))
    if stat and (os.time() - stat.mtime.sec) < 7200 then
        if not loaded_contexts[root] then load_context(root) end
        return
    end
    indexing[root] = true
    notify("[ask] Indexing " .. vim.fn.fnamemodify(root, ":t") .. "…", vim.log.levels.INFO)
    local ctx = build_context(root)
    save_context(root, ctx)
    loaded_contexts[root] = ctx
    indexing[root] = nil
    notify("[ask] Indexed " .. vim.fn.fnamemodify(root, ":t"), vim.log.levels.INFO)
    -- background summary pass
    call_qwen(
        "Summarize this project in 3-5 sentences: what it does, its main components, key patterns.\n\n"
        .. ctx:sub(1, 8000),
        function(err, summary)
            if err or not summary then return end
            local enriched = "## PROJECT SUMMARY\n" .. summary .. "\n\n" .. ctx
            save_context(root, enriched)
            loaded_contexts[root] = enriched
        end
    )
end

-- ── :Ask ─────────────────────────────────────────────────────────────────────
local function show_answer(answer)
    vim.cmd("botright new")
    local buf = vim.api.nvim_get_current_buf()
    vim.bo[buf].buftype   = "nofile"
    vim.bo[buf].bufhidden = "wipe"
    vim.bo[buf].filetype  = "markdown"
    vim.wo.wrap           = true
    vim.api.nvim_win_set_height(0, 15)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(answer, "\n"))
    vim.bo[buf].modifiable = false
    vim.keymap.set("n", "q", "<cmd>close<cr>", { buffer = buf, nowait = true })
end

function M.ask(question)
    if not question or question == "" then
        vim.notify(":Ask <question>", vim.log.levels.WARN); return
    end
    local root = get_project_root()
    if not in_allowed(root) then
        notify("[ask] Not in an allowed project folder", vim.log.levels.WARN); return
    end
    local ctx = load_context(root) or "(no context yet — indexing in background)"
    local prompt = table.concat({
        "You are a read-only coding assistant. Using ONLY the project context below,",
        "answer the question. Do NOT suggest edits or write new code.",
        "",
        "Project context:", ctx:sub(1, MAX_CONTEXT),
        "", "Question: " .. question,
    }, "\n")
    notify("[ask] Asking qwen…", vim.log.levels.INFO)
    call_qwen(prompt, function(err, ans)
        vim.schedule(function()
            if err then notify("[ask] " .. err, vim.log.levels.ERROR)
            else show_answer(ans) end
        end)
    end)
end

vim.api.nvim_create_user_command("Ask", function(o) M.ask(o.args) end, { nargs = "*" })

-- ── Annotations ───────────────────────────────────────────────────────────────
local annotated_bufs = {}

local function clear_annotations(buf)
    vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
    annotated_bufs[buf] = nil
end

local function place_one(buf, lnum, label)
    local total = vim.api.nvim_buf_line_count(buf)
    local row   = math.max(0, math.min(lnum, total - 1))
    -- match indentation of the annotated line
    local line    = vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or ""
    local indent  = line:match("^(%s*)") or ""
    vim.api.nvim_buf_set_extmark(buf, ns, row, 0, {
        virt_lines       = { { { indent .. "󰙩  " .. label, "AskAnnotation" } } },
        virt_lines_above = true,
    })
end

local function save_annotations(root, fname, annotations)
    -- delete old file first to avoid stale reads
    os.remove(annotations_path(root, fname))
    local fp = io.open(annotations_path(root, fname), "w")
    if fp then fp:write(vim.fn.json_encode(annotations)); fp:close() end
end

local function load_annotations(root, fname)
    local fp = io.open(annotations_path(root, fname), "r")
    if not fp then return nil end
    local raw = fp:read("*a"); fp:close()
    local ok, ann = pcall(vim.fn.json_decode, raw)
    return (ok and type(ann) == "table") and ann or nil
end

-- ── Treesitter section detection ──────────────────────────────────────────────
-- node types that represent logical top-level or significant sections


local FALLBACK_PATTERNS = {
    go   = { "^func ", "^type ", "^var%s+%S", "^const%s+%S", "^import " },
    fish = { "^function " },
}

local MIN_LINES = 2  -- skip single-line nodes only

-- Per-language node types verified against actual parser output
-- Each entry is a flat list of node type strings
local TS_NODE_TYPES = {
    lua        = { "function_declaration", "if_statement", "for_statement", "while_statement" },
    python     = { "function_definition", "class_definition", "decorated_definition",
                   "if_statement", "for_statement", "while_statement", "with_statement", "try_statement" },
    rust       = { "function_item", "impl_item", "struct_item", "enum_item", "mod_item", "trait_item",
                   "if_expression", "for_expression", "loop_expression", "match_expression" },
    javascript = { "function_declaration", "function_expression", "arrow_function",
                   "class_declaration", "export_statement",
                   "if_statement", "for_statement", "while_statement" },
    typescript = { "function_declaration", "function_expression", "arrow_function",
                   "class_declaration", "interface_declaration", "type_alias_declaration",
                   "export_statement", "if_statement", "for_statement", "while_statement" },
    go         = { "function_declaration", "method_declaration", "if_statement", "for_statement" },
    bash       = { "function_definition", "if_statement", "for_statement", "while_statement", "case_statement" },
    c          = { "function_definition", "struct_specifier", "enum_specifier",
                   "if_statement", "for_statement", "while_statement" },
    cpp        = { "function_definition", "class_specifier", "struct_specifier",
                   "namespace_definition", "if_statement", "for_statement", "while_statement" },
}

-- Build and cache validated queries per language (skip unknown node types gracefully)
local _query_cache = {}

function M._reset_query_cache() _query_cache = {} end

local function get_query(ft)
    if _query_cache[ft] ~= nil then return _query_cache[ft] end
    local types = TS_NODE_TYPES[ft]
    if not types then _query_cache[ft] = false; return false end

    -- Try each node type individually and keep only valid ones
    local valid = {}
    for _, t in ipairs(types) do
        local ok = pcall(vim.treesitter.query.parse, ft, "(" .. t .. ") @s")
        if ok then table.insert(valid, "(" .. t .. ") @s") end
    end
    if #valid == 0 then _query_cache[ft] = false; return false end

    local ok, query = pcall(vim.treesitter.query.parse, ft, table.concat(valid, "\n"))
    _query_cache[ft] = ok and query or false
    return _query_cache[ft]
end

local function ts_detect_sections(buf, ft, lines)
    local query = get_query(ft)
    if not query then return nil end  -- signal: use regex fallback

    local ok_parser, parser = pcall(vim.treesitter.get_parser, buf, ft)
    if not ok_parser or not parser then return nil end

    local ok_tree, trees = pcall(function() return parser:parse() end)
    if not ok_tree or not trees or not trees[1] then return nil end

    local seen     = {}
    local sections = {}
    for _, node in query:iter_captures(trees[1]:root(), buf) do
        local row_start, _, row_end, _ = node:range()
        local size = row_end - row_start
        if size >= MIN_LINES and not seen[row_start] then
            seen[row_start] = true
            local raw = (lines[row_start + 1] or ""):gsub("^%s+", ""):sub(1, 120)
            local body_lines = {}
            for i = row_start + 1, math.min(row_end, row_start + 40) do
                if lines[i] then table.insert(body_lines, lines[i]) end
            end
            table.insert(sections, {
                line = row_start,
                raw  = raw,
                body = table.concat(body_lines, "\n"),
            })
        end
    end
    table.sort(sections, function(a, b) return a.line < b.line end)
    return sections
end

local function fallback_detect_sections(lines, ft)
    local patterns = FALLBACK_PATTERNS[ft] or {}
    local sections = {}
    for i, l in ipairs(lines) do
        local stripped = l:gsub("^%s+", "")
        if #patterns > 0 then
            for _, pat in ipairs(patterns) do
                if stripped:match(pat) then
                    -- collect body until next match or 40 lines
                    local body_lines = {}
                    for j = i + 1, math.min(#lines, i + 40) do
                        local jl = lines[j]:gsub("^%s+", "")
                        local hit = false
                        for _, p2 in ipairs(patterns) do
                            if jl:match(p2) then hit = true; break end
                        end
                        if hit then break end
                        table.insert(body_lines, lines[j])
                    end
                    if #body_lines >= MIN_LINES then
                        table.insert(sections, {
                            line = i - 1,
                            raw  = stripped:sub(1, 120),
                            body = table.concat(body_lines, "\n"),
                        })
                    end
                    break
                end
            end
        else
            -- unknown filetype: sample every ~25 non-blank lines
            if stripped ~= "" and (i - 1) % 25 == 0 then
                local body_lines = {}
                for j = i + 1, math.min(#lines, i + 25) do
                    if lines[j] and lines[j]:gsub("^%s+", "") ~= "" then
                        table.insert(body_lines, lines[j])
                    end
                end
                table.insert(sections, {
                    line = i - 1,
                    raw  = stripped:sub(1, 120),
                    body = table.concat(body_lines, "\n"),
                })
            end
        end
    end
    return sections
end

-- ── Parallel explanation ───────────────────────────────────────────────────────
local function explain_sections_parallel(sections, buf, root, bname)
    local total     = #sections
    local done      = 0
    local results   = {}   -- keyed by index

    local function on_all_done()
        -- build ordered annotation list
        local annotations = {}
        for i = 1, total do
            if results[i] then
                table.insert(annotations, { line = sections[i].line, label = results[i] })
            end
        end
        if #annotations > 0 then
            save_annotations(root, bname, annotations)
            vim.schedule(function()
                -- clear and redraw all at once
                vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
                for _, a in ipairs(annotations) do
                    place_one(buf, a.line, a.label)
                end
                annotated_bufs[buf] = true
                notify("[ask] " .. #annotations .. " sections annotated", vim.log.levels.INFO)
            end)
        end
    end

    for i, s in ipairs(sections) do
        local snippet = (s.raw .. "\n" .. s.body):sub(1, 600)
        local prompt  = "Explain what this code does in one sentence, max 12 words. Plain text only, no code.\n\n" .. snippet

        call_qwen(prompt, function(err, result)
            local explanation
            if err or not result then
                explanation = s.raw:sub(1, 60)
            else
                explanation = result
                    :gsub("\n.*", "")
                    :gsub("^[%s`*_#]+", "")
                    :gsub("[%s`*_]+$", "")
                if explanation:match("^[%s]*[{(%[]") or explanation:match("[=;{}].*[=;{}]") then
                    explanation = s.raw:gsub("{.*", ""):gsub("%s+$", ""):sub(1, 60)
                end
            end
            results[i] = explanation
            done = done + 1
            if done == total then on_all_done() end
        end)
    end
end

-- ── Main annotate ─────────────────────────────────────────────────────────────
local function annotate_buffer(buf)
    local bname = vim.api.nvim_buf_get_name(buf)
    local root  = get_project_root()
    local fname = vim.fn.fnamemodify(bname, ":t")
    local ft    = vim.bo[buf].filetype

    -- clear any stale annotations first
    vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
    annotated_bufs[buf] = nil

    local lines = vim.api.nvim_buf_get_lines(buf, 0, -1, false)
    if #lines == 0 then return end

    -- detect sections: treesitter first, fallback to regex
    local sections = ts_detect_sections(buf, ft, lines)
                  or fallback_detect_sections(lines, ft)

    if #sections == 0 then
        notify("[ask] No sections detected in " .. fname, vim.log.levels.WARN); return
    end

    notify("[ask] Explaining " .. #sections .. " sections in " .. fname .. "…", vim.log.levels.INFO)
    explain_sections_parallel(sections, buf, root, bname)
end

-- ── Restore cached annotations or re-annotate if file changed ─────────────────
local restore_pending = {}   -- buf → true (debounce guard)

local function restore_or_refresh(buf)
    if restore_pending[buf] then return end
    local bname = vim.api.nvim_buf_get_name(buf)
    if bname == "" then return end
    local ft = vim.bo[buf].filetype
    if ft == "" or ft == "neo-tree" then return end

    local root  = get_project_root()
    if not in_allowed(root) then return end

    local ann_path  = annotations_path(root, bname)
    local cached    = load_annotations(root, bname)
    local src_mtime = file_mtime(bname)
    local ann_mtime = file_mtime(ann_path)

    if cached and #cached > 0 then
        -- show immediately from cache
        vim.api.nvim_buf_clear_namespace(buf, ns, 0, -1)
        for _, a in ipairs(cached) do place_one(buf, a.line, a.label) end
        annotated_bufs[buf] = true

        -- only background-refresh if source file is newer than cache AND auto-annotate is on
        if AUTO_ANNOTATE and src_mtime > ann_mtime then
            notify("[ask] File changed, refreshing annotations…", vim.log.levels.INFO)
            restore_pending[buf] = true
            vim.defer_fn(function()
                restore_pending[buf] = nil
                if vim.api.nvim_buf_is_valid(buf) then
                    annotate_buffer(buf)
                end
            end, 500)
        end
        return
    end

    -- no cache: only auto-annotate if explicitly enabled
    if not AUTO_ANNOTATE then return end

    restore_pending[buf] = true
    vim.defer_fn(function()
        restore_pending[buf] = nil
        if vim.api.nvim_buf_is_valid(buf) then
            annotate_buffer(buf)
        end
    end, 500)
end

-- ── Toggle annotate ───────────────────────────────────────────────────────────
function M.toggle_annotate()
    local buf = vim.api.nvim_get_current_buf()
    if annotated_bufs[buf] then
        clear_annotations(buf)
        notify("[ask] Annotations cleared", vim.log.levels.INFO)
    else
        annotate_buffer(buf)
    end
end

-- ── Clean & reindex ───────────────────────────────────────────────────────────

-- Delete cached annotations for current file and re-annotate fresh
function M.reindex_file()
    local buf   = vim.api.nvim_get_current_buf()
    local bname = vim.api.nvim_buf_get_name(buf)
    local root  = get_project_root()
    local ann   = annotations_path(root, bname)
    os.remove(ann)
    clear_annotations(buf)
    notify("[ask] Cache cleared for " .. vim.fn.fnamemodify(bname, ":t") .. " — re-annotating…", vim.log.levels.INFO)
    annotate_buffer(buf)
end

-- Delete all annotation caches for current project and prompt to reindex
function M.reindex_project()
    local root = get_project_root()
    local pid  = project_id(root)
    -- confirm before wiping
    vim.ui.select({ "Yes", "No" }, {
        prompt = "Clear all annotations for " .. vim.fn.fnamemodify(root, ":t") .. "?",
    }, function(choice)
        if choice ~= "Yes" then return end
        -- delete all ann files for this project
        local pattern = DATA_DIR .. pid .. "_*_ann.json"
        local handle  = vim.uv.fs_scandir(DATA_DIR)
        local deleted = 0
        while handle do
            local name, _ = vim.uv.fs_scandir_next(handle)
            if not name then break end
            if name:sub(1, #pid) == pid and name:match("_ann%.json$") then
                os.remove(DATA_DIR .. name)
                deleted = deleted + 1
            end
        end
        -- also wipe context cache to force re-index
        os.remove(context_path(root))
        loaded_contexts[root] = nil
        -- clear all annotated bufs in this project
        for b in pairs(annotated_bufs) do
            local bn = vim.api.nvim_buf_get_name(b)
            if bn:sub(1, #root) == root then
                clear_annotations(b)
            end
        end
        notify(string.format("[ask] Cleared %d annotation files + context for %s",
            deleted, vim.fn.fnamemodify(root, ":t")), vim.log.levels.INFO)
        -- re-index project context in background
        start_background_index(root)
    end)
end

-- Clean cache only (no re-annotate)
function M.clean_file()
    local buf   = vim.api.nvim_get_current_buf()
    local bname = vim.api.nvim_buf_get_name(buf)
    local root  = get_project_root()
    os.remove(annotations_path(root, bname))
    clear_annotations(buf)
    notify("[ask] Annotation cache cleared for " .. vim.fn.fnamemodify(bname, ":t"), vim.log.levels.INFO)
end

function M.clean_project()
    local root = get_project_root()
    local pid  = project_id(root)
    local handle = vim.uv.fs_scandir(DATA_DIR)
    local deleted = 0
    while handle do
        local name, _ = vim.uv.fs_scandir_next(handle)
        if not name then break end
        if name:sub(1, #pid) == pid and name:match("_ann%.json$") then
            os.remove(DATA_DIR .. name)
            deleted = deleted + 1
        end
    end
    for b in pairs(annotated_bufs) do
        local bn = vim.api.nvim_buf_get_name(b)
        if bn:sub(1, #root) == root then clear_annotations(b) end
    end
    notify(string.format("[ask] Cleared %d annotation caches for %s",
        deleted, vim.fn.fnamemodify(root, ":t")), vim.log.levels.INFO)
end

-- ── Commands & keymaps ────────────────────────────────────────────────────────
vim.api.nvim_create_user_command("AskAnnotate",       M.toggle_annotate,  {})
vim.api.nvim_create_user_command("AskCleanFile",      M.clean_file,       {})
vim.api.nvim_create_user_command("AskCleanProject",   M.clean_project,    {})
vim.api.nvim_create_user_command("AskReindexFile",    M.reindex_file,     {})
vim.api.nvim_create_user_command("AskReindexProject", M.reindex_project,  {})
vim.api.nvim_create_user_command("AskAutoAnnotate", function()
    AUTO_ANNOTATE = not AUTO_ANNOTATE
    notify("[ask] Auto-annotate " .. (AUTO_ANNOTATE and "ON" or "OFF"), vim.log.levels.INFO)
end, {})

vim.keymap.set("n", "<leader>aa", M.toggle_annotate,   { desc = "Ask: toggle annotations" })
vim.keymap.set("n", "<leader>af", M.reindex_file,      { desc = "Ask: reindex current file" })
vim.keymap.set("n", "<leader>ap", M.reindex_project,   { desc = "Ask: reindex project" })

vim.api.nvim_create_autocmd("BufWipeout", {
    callback = function(ev) clear_annotations(ev.buf) end,
})

-- ── BufEnter: index project + restore/auto-annotate ──────────────────────────
local index_pending = {}   -- root → true
vim.api.nvim_create_autocmd("BufEnter", {
    callback = function()
        if not _nvim_ready then return end   -- never run before VimEnter
        local root = get_project_root()
        if not in_allowed(root) then return end
        if index_pending[root] then return end
        index_pending[root] = true
        vim.defer_fn(function()
            index_pending[root] = nil
            start_background_index(root)
        end, 3000)
    end,
})

-- ── Background improvement loop (every 5 min) ─────────────────────────────────
local _improve_timer   = nil
local _improving       = {}   -- root → true (in-flight guard)

local function improve_project(root)
    if _improving[root] then return end
    local ctx = load_context(root)
    if not ctx or #ctx < 100 then return end
    _improving[root] = true

    -- ask qwen to deepen its summary based on current context
    local prompt = table.concat({
        "You are a code analyst. Given this project context, write an improved, more detailed summary.",
        "Focus on: architecture, data flow, key abstractions, and non-obvious patterns.",
        "Be concise but precise. Max 10 sentences. Plain text only.",
        "",
        ctx:sub(1, 10000),
    }, "\n")

    call_qwen(prompt, function(err, summary)
        _improving[root] = nil   -- release guard regardless of outcome
        if err or not summary or #summary < 20 then return end
        local base     = ctx:gsub("^## PROJECT SUMMARY.-\n\n", "")
        local enriched = "## PROJECT SUMMARY\n" .. summary .. "\n\n" .. base
        save_context(root, enriched)
        loaded_contexts[root] = enriched
        vim.schedule(function()
            vim.notify("[ask] Project understanding updated: " .. vim.fn.fnamemodify(root, ":t"), vim.log.levels.INFO)
        end)
    end)
end

-- Manual trigger: :AskImprove to deepen project understanding
vim.api.nvim_create_user_command("AskImprove", function()
    local root = get_project_root()
    if in_allowed(root) then
        improve_project(root)
    else
        vim.notify("[ask] Not in an allowed project root", vim.log.levels.WARN)
    end
end, { desc = "Ask: Improve project understanding" })

-- No auto-timer — use :AskImprove manually
vim.api.nvim_create_autocmd("VimEnter", {
    once     = true,
    callback = function() end,
})

return M
