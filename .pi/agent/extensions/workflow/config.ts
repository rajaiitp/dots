import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export type RoleName = "luna" | "terra" | "sol";

export interface WorkflowConfig {
  models: Record<RoleName, string>;
  thinking: "xhigh";
  maxReviews: number;
  maxSolConsults: number;
  childTimeoutMs: number;
  maxPacketBytes: number;
  maxReviewPacketBytes: number;
  maxChildOutputBytes: number;
  maxChildOutputLines: number;
  maxRoleAttempts: number;
  enableDeltaReviews: boolean;
}

export const DEFAULT_CONFIG: WorkflowConfig = {
  models: {
    luna: "openai-codex/gpt-5.6-luna",
    terra: "openai-codex/gpt-5.6-terra",
    sol: "openai-codex/gpt-5.6-sol",
  },
  thinking: "xhigh",
  maxReviews: 3,
  maxSolConsults: 2,
  childTimeoutMs: 15 * 60 * 1000,
  maxPacketBytes: 120 * 1024,
  maxReviewPacketBytes: 96 * 1024,
  // JSON mode emits one framed event per reasoning/text delta; xhigh specialists
  // legitimately exceed a small cap before returning their bounded role result.
  maxChildOutputBytes: 2 * 1024 * 1024,
  maxChildOutputLines: 2000,
  maxRoleAttempts: 2,
  enableDeltaReviews: true,
};

function positive(value: unknown, fallback: number, minimum = 1): number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum ? value : fallback;
}

function modelRef(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[^/\s]+\/[^/\s]+$/.test(value.trim()) ? value.trim() : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Load global defaults, then an explicitly trusted project override. */
export function loadConfig(cwd: string, trustProject = true): WorkflowConfig {
  const paths = [
    join(agentDir(), "workflow.json"),
    ...(trustProject ? [join(cwd, ".pi", "workflow.json")] : []),
  ];
  let raw: Record<string, unknown> = {};
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const parsed = object(JSON.parse(readFileSync(path, "utf8")));
      raw = { ...raw, ...parsed, models: { ...object(raw.models), ...object(parsed.models) } };
    } catch {
      // A malformed optional override must not disable a safe existing session.
    }
  }
  const models = object(raw.models);
  return {
    models: {
      luna: modelRef(models.luna, DEFAULT_CONFIG.models.luna),
      terra: modelRef(models.terra, DEFAULT_CONFIG.models.terra),
      sol: modelRef(models.sol, DEFAULT_CONFIG.models.sol),
    },
    thinking: "xhigh",
    maxReviews: positive(raw.maxReviews, DEFAULT_CONFIG.maxReviews),
    maxSolConsults: positive(raw.maxSolConsults, DEFAULT_CONFIG.maxSolConsults),
    childTimeoutMs: positive(raw.childTimeoutMs, DEFAULT_CONFIG.childTimeoutMs, 5_000),
    maxPacketBytes: positive(raw.maxPacketBytes, DEFAULT_CONFIG.maxPacketBytes, 1024),
    maxReviewPacketBytes: positive(raw.maxReviewPacketBytes, DEFAULT_CONFIG.maxReviewPacketBytes, 1024),
    maxChildOutputBytes: positive(raw.maxChildOutputBytes, DEFAULT_CONFIG.maxChildOutputBytes, 1024),
    maxChildOutputLines: positive(raw.maxChildOutputLines, DEFAULT_CONFIG.maxChildOutputLines, 1),
    maxRoleAttempts: positive(raw.maxRoleAttempts, DEFAULT_CONFIG.maxRoleAttempts),
    enableDeltaReviews: bool(raw.enableDeltaReviews, DEFAULT_CONFIG.enableDeltaReviews),
  };
}

export function splitModelRef(ref: string): { provider: string; model: string } {
  const [provider, ...rest] = ref.split("/");
  return { provider, model: rest.join("/") };
}
