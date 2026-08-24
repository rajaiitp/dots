import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { temporaryPacketDir } from "./baseline.ts";
import type { OrchestratorConfig, RoleName } from "./config.ts";
import { splitModelRef } from "./config.ts";
import type { RoleResult } from "./schemas.ts";
import { parseRoleResult } from "./schemas.ts";
import type { UsageTotals } from "./state.ts";
import { usageZero } from "./state.ts";
import { SOL_PROMPT, TERRA_REVIEW_PROMPT, TERRA_SHARD_PROMPT, TERRA_SYNTHESIS_PROMPT, TERRA_TEST_PLAN_PROMPT } from "./prompts.ts";

export type RoleJob = "sol_design" | "terra_test_plan" | "terra_review" | "terra_review_shard" | "terra_review_synthesis";

export interface RoleCallResult {
  result: RoleResult;
  usage: UsageTotals;
  attempts: number;
  provider: string;
  model: string;
}

interface PiExec {
  exec(command: string, args: string[], options?: { cwd?: string; signal?: AbortSignal; timeout?: number }): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
}

function promptFor(job: RoleJob): string {
  switch (job) {
    case "sol_design": return SOL_PROMPT;
    case "terra_test_plan": return TERRA_TEST_PLAN_PROMPT;
    case "terra_review": return TERRA_REVIEW_PROMPT;
    case "terra_review_shard": return TERRA_SHARD_PROMPT;
    case "terra_review_synthesis": return TERRA_SYNTHESIS_PROMPT;
  }
}

function roleFor(job: RoleJob): RoleName {
  return job === "sol_design" ? "sol" : "terra";
}

function limit(value: string, maxBytes: number, maxLines: number): string {
  const lines = value.split("\n").slice(0, maxLines);
  let result = lines.join("\n");
  while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, Math.floor(result.length * 0.9));
  return result;
}

function accumulateUsage(target: UsageTotals, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const value = usage as Record<string, unknown>;
  target.input += typeof value.input === "number" ? value.input : 0;
  target.output += typeof value.output === "number" ? value.output : 0;
  target.cacheRead += typeof value.cacheRead === "number" ? value.cacheRead : 0;
  target.cacheWrite += typeof value.cacheWrite === "number" ? value.cacheWrite : 0;
  const cost = value.cost as Record<string, unknown> | undefined;
  target.cost += typeof cost?.total === "number" ? cost.total : 0;
}

/** Strictly parse JSONL records: malformed child stdout is a protocol failure, never a best-effort review. */
export function parseChildOutput(stdout: string, expected: { provider: string; model: string }): { result: RoleResult; usage: UsageTotals } {
  const usage = usageZero();
  let structured: unknown;
  let sawExpectedAssistant = false;
  for (const rawLine of stdout.split("\n")) {
    if (!rawLine.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(rawLine) as Record<string, unknown>;
    } catch {
      throw new Error("Specialist child emitted malformed JSONL.");
    }
    const message = event.message as Record<string, unknown> | undefined;
    if (message && (event.type === "message_end" || event.type === "agent_end")) {
      if (message.role === "assistant") {
        accumulateUsage(usage, message.usage);
        if (message.provider === expected.provider && message.model === expected.model) sawExpectedAssistant = true;
      }
      if (message.role === "toolResult" && message.toolName === "orch_role_result") {
        const details = message.details as Record<string, unknown> | undefined;
        structured = details?.result;
        accumulateUsage(usage, message.usage);
      }
    }
    if (event.type === "tool_execution_end" && event.toolName === "orch_role_result") {
      const result = event.result as Record<string, unknown> | undefined;
      const details = result?.details as Record<string, unknown> | undefined;
      structured = details?.result ?? structured;
      accumulateUsage(usage, result?.usage);
    }
  }
  if (!sawExpectedAssistant) throw new Error(`Specialist did not confirm ${expected.provider}/${expected.model}.`);
  return { result: parseRoleResult(structured), usage };
}

function childExtensionPath(): string {
  return fileURLToPath(new URL("./child-result.ts", import.meta.url));
}

export async function runRole(
  pi: PiExec,
  cwd: string,
  config: OrchestratorConfig,
  job: RoleJob,
  packet: unknown,
  signal?: AbortSignal,
): Promise<RoleCallResult> {
  const role = roleFor(job);
  const ref = config.models[role];
  const expected = splitModelRef(ref);
  const packetText = JSON.stringify(packet, null, 2);
  if (Buffer.byteLength(packetText, "utf8") > config.maxPacketBytes) {
    throw new Error(`Specialist packet exceeds ${config.maxPacketBytes} bytes.`);
  }
  const tempDir = await mkdtemp(temporaryPacketDir());
  const packetPath = join(tempDir, "packet.json");
  await writeFile(packetPath, packetText, { encoding: "utf8", mode: 0o600 });
  let lastError: Error | undefined;
  try {
    for (let attempt = 1; attempt <= config.maxRoleAttempts; attempt++) {
      const args = [
        "--offline", "--mode", "json", "-p", "--no-session", "--no-approve",
        "--no-context-files", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
        "--provider", expected.provider, "--model", expected.model, "--thinking", config.thinking,
        "--tools", "read,grep,find,ls,orch_role_result",
        "--extension", childExtensionPath(),
        "--append-system-prompt", promptFor(job),
        `@${packetPath}`,
      ];
      const execution = await pi.exec("pi", args, { cwd, signal, timeout: config.childTimeoutMs });
      try {
        if (execution.killed) throw new Error("Specialist child timed out or was aborted.");
        if (execution.code !== 0) throw new Error(limit(execution.stderr || execution.stdout || `Specialist exited ${execution.code}`, config.maxChildOutputBytes, config.maxChildOutputLines));
        const parsed = parseChildOutput(execution.stdout, expected);
        return { ...parsed, attempts: attempt, provider: expected.provider, model: expected.model };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (signal?.aborted) throw lastError;
      }
    }
    throw lastError ?? new Error("Specialist did not return a result.");
  } finally {
    await rm(dirname(packetPath), { recursive: true, force: true });
  }
}
