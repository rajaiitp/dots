import { extname, basename, normalize } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";

export const READ_ONLY_TOOLS = new Set([
  "read", "grep", "find", "ls",
  "hypa_read", "hypa_grep", "hypa_find", "hypa_ls",
  "ask_user", "todo", "web_search", "source_check", "fetch_content", "get_search_content", "recall",
  "workflow_sol_design", "workflow_terra_test_plan", "workflow_terra_review",
]);

export const MUTATION_TOOLS = new Set(["edit", "write", "bash", "hypa_shell", "workflow_file"]);

/** Tools retained while /workflow is enabled but no run can safely accept role work. */
export const IDLE_OR_TERMINAL_TOOLS = new Set([...READ_ONLY_TOOLS].filter((name) => !name.startsWith("workflow_")));

export function activeToolsForStage(hasTerraPlan: boolean, allTools: string[], idleOrTerminal = false): string[] {
  if (idleOrTerminal) return allTools.filter((name) => IDLE_OR_TERMINAL_TOOLS.has(name));
  const knownSafe = allTools.filter((name) => READ_ONLY_TOOLS.has(name));
  // edit/write stay available so inert documentation can bypass Terra. Their
  // per-path gate still denies every behavior-bearing target before execution.
  const fileTools = allTools.filter((name) => name === "edit" || name === "write");
  const plannedTools = hasTerraPlan
    ? allTools.filter((name) => name === "bash" || name === "hypa_shell" || name === "workflow_file")
    : [];
  return [...new Set([...knownSafe, ...fileTools, ...plannedTools])];
}

export function isAllowedTool(name: string, hasTerraPlan: boolean): boolean {
  return READ_ONLY_TOOLS.has(name)
    || name === "edit"
    || name === "write"
    || (hasTerraPlan && (name === "bash" || name === "hypa_shell" || name === "workflow_file"));
}

const BEHAVIORAL_MARKDOWN = new Set([
  "agents.md", "agents.override.md", "claude.md", "system.md", "append_system.md",
]);

/** Ordinary docs are exempt; agent/skill/prompt/config Markdown is executable behavior. */
export function isBehaviorBearingPath(rawPath: string): boolean {
  const path = normalize(rawPath.replace(/^@/, "")).replace(/\\/g, "/");
  const lower = path.toLowerCase();
  const name = basename(lower);
  if (lower.includes("/.pi/") || lower.startsWith(".pi/") || lower.includes("/.agents/") || lower.startsWith(".agents/")) return true;
  if (BEHAVIORAL_MARKDOWN.has(name)) return true;
  if ([".md", ".mdx", ".txt", ".rst", ".adoc"].includes(extname(lower))) return false;
  return true;
}

export function isForbiddenShell(command: string): string | undefined {
  const value = command.trim();
  if (!value) return "Empty shell command is not allowed.";
  // Permit only explicitly read-only Git commands. All index/HEAD/config mutation
  // is outside the task-local baseline model and therefore fail-closed.
  for (const match of value.matchAll(/\bgit\s+([^;&|\n]+)/gim)) {
    if (!/^(?:status|diff|log|show|branch|rev-parse|ls-files)(?:\s|$)|^config\s+--get(?:\s|$)/i.test(match[1])) {
      return "Git repository metadata changes are blocked in workflow mode.";
    }
  }
  if (/\bjj\b/i.test(value)) return "JJ commands are blocked in workflow mode.";
  if (/\b(sudo|su|doas|shutdown|reboot|poweroff|kill|killall|pkill)\b/i.test(value)) return "Privileged or process-control shell commands are blocked.";
  // File-descriptor joins and /dev/null redirections are observational; remove
  // them before detecting background jobs or file-writing redirections.
  const audited = value
    .replace(/\d*>\s*&\d+/g, "")
    .replace(/(?:\d*>>?|\d*<)\s*\/dev\/null\b/g, "");
  if (/(^|[^&])&(?![&>])/.test(audited) || /\bnohup\b|\bdisown\b/i.test(audited)) return "Background commands are blocked because their mutations cannot be attributed.";
  if (/\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh)\b/i.test(value)) return "Remote code execution is blocked.";
  if (/(?:^|[;&|]\s*)(?:sh|bash|zsh|fish|eval)\b|\b(?:python|python3|node)\s+(?:-c|-e)\b/i.test(value)) return "Inline interpreter or shell execution bypasses are blocked.";
  if (/(?:^|\s)(?:rm|mv|cp|mkdir|touch|chmod|chown|ln|tee)\b|\bsed\s+-i\b|\bperl\s+-pi\b|(?:^|[^<])>(?!>)/i.test(audited)) return "Direct shell mutation is blocked; use edit/write or workflow_file so paths are attributed.";
  if (/\bcd\s+-(?=\s|$)|(?:^|[\s"'=])(?:\.\.(?=\/|\s|$)|~(?=\/|\s|$)|\$(?:HOME|\{HOME\})(?=\/|\s|$)|\/(?!dev\/null\b))/.test(value)) return "Shell paths outside the repository are blocked; use repository-relative paths.";
  return undefined;
}

export function commandFromToolResult(event: ToolResultEvent): { command: string; exitCode?: number } | undefined {
  if (event.toolName === "bash") {
    const details = event.details as { exitCode?: number } | undefined;
    return { command: String(event.input.command ?? ""), exitCode: details?.exitCode };
  }
  if (event.toolName === "hypa_shell") {
    const details = event.details as { command?: string; exitCode?: number } | undefined;
    return { command: String(details?.command ?? event.input.command ?? ""), exitCode: details?.exitCode };
  }
  return undefined;
}

export function boundedText(parts: Array<{ type: string; text?: string }>, max = 12_000): string {
  const text = parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
  return text.length <= max ? text : `${text.slice(0, max)}\n[output truncated by workflow]`;
}
