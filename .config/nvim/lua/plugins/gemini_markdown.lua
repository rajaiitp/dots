local M = {}

local ns = vim.api.nvim_create_namespace("gemini_markdown_answers")
local model = "gemini-3.5-flash"

local function get_api_key()
    local env_key = vim.env.GEMINI_API_KEY or vim.env.GOOGLE_API_KEY
    if env_key and env_key ~= "" then return env_key end

    local key = vim.fn.systemlist({
        "security",
        "find-generic-password",
        "-s",
        "gemini-api-key",
        "-a",
        vim.env.USER,
        "-w",
    })[1]

    if vim.v.shell_error == 0 and key and key ~= "" then return key end
    return nil
end

local function split_lines(text)
    if not text or text == "" then return { "_No response._" } end
    local lines = vim.split(text, "\n", { plain = true })
    while #lines > 0 and lines[1] == "" do
        table.remove(lines, 1)
    end
    while #lines > 0 and lines[#lines] == "" do
        table.remove(lines, #lines)
    end
    return #lines > 0 and lines or { "_No response._" }
end

local function current_prompt(buf)
    local row = vim.api.nvim_win_get_cursor(0)[1] - 1
    local line = vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or ""
    if line:match("^G>%s+") then
        return row, line:gsub("^G>%s*", "")
    end
    return nil, nil
end

local function next_prompt_row(buf, prompt_row)
    local line_count = vim.api.nvim_buf_line_count(buf)
    for row = prompt_row + 1, line_count - 1 do
        local line = vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or ""
        if line:match("^G>%s+") then return row end
    end
    return line_count
end

local function find_answer_block(buf, prompt_row)
    local stop = next_prompt_row(buf, prompt_row)
    for row = prompt_row + 1, stop - 1 do
        local line = vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or ""
        if line == "### Answer" then
            return row, stop
        end
    end
    return nil, stop
end

local function render_block(buf, prompt_row, body_lines)
    local answer_start, stop = find_answer_block(buf, prompt_row)
    local block = { "", "### Answer", "" }
    vim.list_extend(block, body_lines)
    table.insert(block, "")

    if answer_start then
        vim.api.nvim_buf_set_lines(buf, answer_start, stop, false, block)
    else
        vim.api.nvim_buf_set_lines(buf, prompt_row + 1, prompt_row + 1, false, block)
    end
end

local function build_prompt(question)
    return table.concat({
        "You are writing an answer into a markdown notebook.",
        "Return only markdown body content.",
        "Do not wrap the whole answer in triple backticks.",
        "Do not include a top-level title like '# Answer' or '### Answer'.",
        "Start with a concise direct answer, then use short headings and bullets if useful.",
        "Use inline code for commands and fenced code blocks only when necessary.",
        "Keep it polished and readable, like the Gemini browser output.",
        "",
        "Question:",
        question,
    }, "\n")
end

function M.answer_current_prompt()
    local buf = vim.api.nvim_get_current_buf()
    if vim.bo[buf].filetype ~= "markdown" then
        vim.notify("Gemini markdown answers only work in markdown buffers", vim.log.levels.WARN)
        return
    end

    local prompt_row, question = current_prompt(buf)
    if not prompt_row or question == "" then
        vim.notify("Place cursor on a line starting with 'G> '", vim.log.levels.WARN)
        return
    end

    local prompt_mark = vim.api.nvim_buf_set_extmark(buf, ns, prompt_row, 0, {})
    render_block(buf, prompt_row, { "_Generating..._" })

    local api_key = get_api_key()
    if not api_key then
        render_block(buf, prompt_row, {
            "_Gemini API key not found._",
            "",
            "Set `GEMINI_API_KEY` or save `gemini-api-key` in macOS Keychain.",
        })
        return
    end

    local payload = vim.json.encode({
        contents = {
            {
                parts = {
                    { text = build_prompt(question) },
                },
            },
        },
    })

    local cmd = {
        "python3",
        "-c",
        [[
import json, os, sys, urllib.request

model = os.environ["GEMINI_MODEL"]
api_key = os.environ["GEMINI_API_KEY"]
url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
req = urllib.request.Request(
    url,
    data=sys.stdin.buffer.read(),
    headers={
        "Content-Type": "application/json",
        "x-goog-api-key": api_key,
    },
)
try:
    with urllib.request.urlopen(req, timeout=90) as resp:
        sys.stdout.write(resp.read().decode("utf-8"))
except Exception as e:
    detail = getattr(e, "read", None)
    body = ""
    if callable(detail):
        try:
            body = detail().decode("utf-8")
        except Exception:
            body = ""
    sys.stderr.write(body or str(e))
    sys.exit(1)
        ]],
    }

    vim.system(cmd, {
        text = true,
        stdin = payload,
        env = {
            GEMINI_API_KEY = api_key,
            GEMINI_MODEL = model,
        },
    }, function(result)
        vim.schedule(function()
            local pos = vim.api.nvim_buf_get_extmark_by_id(buf, ns, prompt_mark, {})
            if not pos or #pos == 0 then return end
            local row = pos[1]
            local text

            if result.code == 0 and result.stdout and result.stdout ~= "" then
                local ok, decoded = pcall(vim.json.decode, result.stdout)
                if ok and decoded and decoded.candidates and decoded.candidates[1] and decoded.candidates[1].content and decoded.candidates[1].content.parts then
                    local parts = {}
                    for _, part in ipairs(decoded.candidates[1].content.parts) do
                        if part.text and part.text ~= "" then
                            table.insert(parts, part.text)
                        end
                    end
                    text = table.concat(parts, "\n")
                else
                    text = "_Gemini returned an unexpected response._\n\n```json\n" .. result.stdout .. "\n```"
                end
            else
                text = "_Gemini request failed._"
                if result.stderr and result.stderr ~= "" then
                    text = text .. "\n\n```text\n" .. result.stderr .. "\n```"
                end
            end

            render_block(buf, row, split_lines(text))
        end)
    end)
end

return M
