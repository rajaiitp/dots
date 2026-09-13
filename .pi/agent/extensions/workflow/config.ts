import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RoleThinking = "low" | "medium" | "high" | "xhigh";

export interface WorkflowConfig {
  version: 2;
  models: {
    design: string;
    implementation: string;
    review1: string;
    review2: string;
  };
  thinking: {
    design: RoleThinking;
    implementation: RoleThinking;
    review1: RoleThinking;
    review2: RoleThinking;
  };
  maxChecks: number;
  commandTimeoutMs: number;
  specialistTimeoutMs: number;
  maxReviewBytes: number;
  maxCommandOutputBytes: number;
}

export const DEFAULT_CONFIG: WorkflowConfig = {
  version: 2,
  models: {
    design: "openai-codex/gpt-5.6-sol",
    implementation: "openai-codex/gpt-5.6-sol",
    review1: "openai-codex/gpt-5.6-sol",
    review2: "openai-codex/gpt-5.6-sol",
  },
  thinking: {
    design: "xhigh",
    implementation: "low",
    review1: "high",
    review2: "medium",
  },
  maxChecks: 8,
  commandTimeoutMs: 15 * 60 * 1000,
  specialistTimeoutMs: 15 * 60 * 1000,
  maxReviewBytes: 256 * 1024,
  maxCommandOutputBytes: 50 * 1024,
};

const TOP_LEVEL_KEYS = new Set([
  "version",
  "models",
  "thinking",
  "maxChecks",
  "commandTimeoutMs",
  "specialistTimeoutMs",
  "maxReviewBytes",
  "maxCommandOutputBytes",
]);
const ROLE_KEYS = new Set(["design", "implementation", "review1", "review2"]);
const THINKING_LEVELS = new Set<RoleThinking>(["low", "medium", "high", "xhigh"]);

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unsupported fields: ${unknown.join(", ")}.`);
}

function modelRef(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(value.trim())) {
    throw new Error(`${label} must be a provider/model reference.`);
  }
  return value.trim();
}

function thinkingLevel(value: unknown, label: string): RoleThinking {
  if (typeof value !== "string" || !THINKING_LEVELS.has(value as RoleThinking)) {
    throw new Error(`${label} must be low, medium, high, or xhigh.`);
  }
  return value as RoleThinking;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

export function loadConfig(): WorkflowConfig {
  const path = join(agentDir(), "workflow.json");
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const raw = object(parsed, "workflow.json");
  exactKeys(raw, TOP_LEVEL_KEYS, "workflow.json");
  if (raw.version !== 2) throw new Error("workflow.json version must be 2; earlier workflow configuration is not migrated.");
  const models = object(raw.models ?? DEFAULT_CONFIG.models, "workflow.json models");
  const thinking = object(raw.thinking ?? DEFAULT_CONFIG.thinking, "workflow.json thinking");
  exactKeys(models, ROLE_KEYS, "workflow.json models");
  exactKeys(thinking, ROLE_KEYS, "workflow.json thinking");

  return {
    version: 2,
    models: {
      design: modelRef(models.design ?? DEFAULT_CONFIG.models.design, "models.design"),
      implementation: modelRef(models.implementation ?? DEFAULT_CONFIG.models.implementation, "models.implementation"),
      review1: modelRef(models.review1 ?? DEFAULT_CONFIG.models.review1, "models.review1"),
      review2: modelRef(models.review2 ?? DEFAULT_CONFIG.models.review2, "models.review2"),
    },
    thinking: {
      design: thinkingLevel(thinking.design ?? DEFAULT_CONFIG.thinking.design, "thinking.design"),
      implementation: thinkingLevel(thinking.implementation ?? DEFAULT_CONFIG.thinking.implementation, "thinking.implementation"),
      review1: thinkingLevel(thinking.review1 ?? DEFAULT_CONFIG.thinking.review1, "thinking.review1"),
      review2: thinkingLevel(thinking.review2 ?? DEFAULT_CONFIG.thinking.review2, "thinking.review2"),
    },
    maxChecks: boundedInteger(raw.maxChecks ?? DEFAULT_CONFIG.maxChecks, "maxChecks", 1, 16),
    commandTimeoutMs: boundedInteger(raw.commandTimeoutMs ?? DEFAULT_CONFIG.commandTimeoutMs, "commandTimeoutMs", 1_000, 2_147_483_647),
    specialistTimeoutMs: boundedInteger(raw.specialistTimeoutMs ?? DEFAULT_CONFIG.specialistTimeoutMs, "specialistTimeoutMs", 5_000, 2_147_483_647),
    maxReviewBytes: boundedInteger(raw.maxReviewBytes ?? DEFAULT_CONFIG.maxReviewBytes, "maxReviewBytes", 16 * 1024, 1024 * 1024),
    maxCommandOutputBytes: boundedInteger(raw.maxCommandOutputBytes ?? DEFAULT_CONFIG.maxCommandOutputBytes, "maxCommandOutputBytes", 4 * 1024, 1024 * 1024),
  };
}

export function splitModelRef(ref: string): { provider: string; model: string } {
  const [provider, ...rest] = ref.split("/");
  return { provider, model: rest.join("/") };
}
