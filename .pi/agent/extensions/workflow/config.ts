import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface WorkflowConfig {
  version: 1;
  models: {
    writer: string;
    reviewer: string;
    designer: string;
  };
  thinking: "xhigh";
  maxChecks: number;
  commandTimeoutMs: number;
  specialistTimeoutMs: number;
  maxReviewBytes: number;
  maxCommandOutputBytes: number;
}

export const DEFAULT_CONFIG: WorkflowConfig = {
  version: 1,
  models: {
    writer: "openai-codex/gpt-5.6-luna",
    reviewer: "openai-codex/gpt-5.6-terra",
    designer: "openai-codex/gpt-5.6-sol",
  },
  thinking: "xhigh",
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
const MODEL_KEYS = new Set(["writer", "reviewer", "designer"]);

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
  if (raw.version !== 1) throw new Error("workflow.json version must be 1; legacy workflow configuration is not migrated.");
  if (raw.thinking !== undefined && raw.thinking !== "xhigh") throw new Error("workflow.json thinking must be xhigh.");
  const models = object(raw.models ?? DEFAULT_CONFIG.models, "workflow.json models");
  exactKeys(models, MODEL_KEYS, "workflow.json models");

  return {
    version: 1,
    models: {
      writer: modelRef(models.writer ?? DEFAULT_CONFIG.models.writer, "models.writer"),
      reviewer: modelRef(models.reviewer ?? DEFAULT_CONFIG.models.reviewer, "models.reviewer"),
      designer: modelRef(models.designer ?? DEFAULT_CONFIG.models.designer, "models.designer"),
    },
    thinking: "xhigh",
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
