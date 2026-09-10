import { randomUUID } from "node:crypto";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DesignRecord, ReviewFinding, ReviewRecord, UsageTotals } from "./state.ts";

// pi packages have separate module roots. The installed package's documented
// event contract is used directly so this local extension does not import
// package internals or rely on cross-package Node resolution.
const SUBAGENT_DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
const SUBAGENT_DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update";
const SUBAGENT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
const SUBAGENT_DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";

interface SubagentDelegationRequest {
  requestId: string;
  ownerRunId: string;
  nodeId: string;
  agent: string;
  task: string;
  context: "fresh" | "fork";
  cwd: string;
  model?: string;
  thinking?: "xhigh";
  timeoutMs?: number;
  skill?: boolean;
  artifacts?: boolean;
  result: { kind: "structured"; schema: Record<string, unknown> };
}

interface SubagentDelegationUpdate {
  requestId: string;
  ownerRunId: string;
  nodeId: string;
  runId?: string;
  currentTool?: string;
  recentOutput?: string;
  model?: string;
  toolCount?: number;
  durationMs?: number;
  tokens?: number;
}

interface SubagentDelegationUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  toolCalls: number;
  durationMs: number;
}

interface SubagentDelegationResponse {
  requestId: string;
  ownerRunId?: string;
  nodeId?: string;
  status: string;
  error?: string;
  model?: string;
  thinking?: string;
  usage?: SubagentDelegationUsage;
  result?: { kind: "text"; text: string } | { kind: "structured"; value: unknown };
}

const DESIGN_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string" },
    rationale: { type: "string" },
    constraints: { type: "array", items: { type: "string" }, maxItems: 12 },
    risks: { type: "array", items: { type: "string" }, maxItems: 12 },
    implementationNotes: { type: "array", items: { type: "string" }, maxItems: 16 },
  },
  required: ["decision", "rationale", "constraints", "risks", "implementationNotes"],
  additionalProperties: false,
} as const;

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["APPROVE", "CHANGES_REQUESTED", "BLOCKED"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          severity: { type: "string", enum: ["P0", "P1", "P2"] },
          title: { type: "string" },
          evidence: { type: "string" },
          smallestFix: { type: "string" },
          file: { type: "string" },
          line: { type: "integer", minimum: 1 },
        },
        required: ["id", "severity", "title", "evidence", "smallestFix"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "summary", "findings"],
  additionalProperties: false,
} as const;

export interface DelegationProgress {
  runId?: string;
  currentTool?: string;
  recentOutput?: string;
  model?: string;
  toolCount?: number;
  durationMs?: number;
  tokens?: number;
}

export interface DelegationResult {
  value: unknown;
  model?: string;
  thinking?: string;
  usage?: UsageTotals;
}

function bounded(value: unknown, label: string, maximum = 16_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  if (Buffer.byteLength(value, "utf8") > maximum) throw new Error(`${label} exceeds ${maximum} bytes.`);
  return value.trim();
}

function strings(value: unknown, label: string, maximumItems: number): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) throw new Error(`${label} must contain at most ${maximumItems} strings.`);
  return value.map((item, index) => bounded(item, `${label}[${index}]`, 4_000));
}

function usageFromResponse(response: SubagentDelegationResponse): UsageTotals | undefined {
  if (!("usage" in response) || !response.usage) return undefined;
  return {
    input: response.usage.input,
    output: response.usage.output,
    cacheRead: response.usage.cacheRead,
    cacheWrite: response.usage.cacheWrite,
    cost: response.usage.cost,
    turns: response.usage.turns,
    toolCalls: response.usage.toolCalls,
    durationMs: response.usage.durationMs,
  };
}

export function usageForPi(value?: UsageTotals): Usage | undefined {
  if (!value) return undefined;
  return {
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    totalTokens: value.input + value.output + value.cacheRead + value.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: value.cost },
  };
}

export function subagentsAvailable(pi: ExtensionAPI): boolean {
  return pi.getAllTools().some((tool) => tool.name === "subagent");
}

export async function delegateStructured(options: {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  ownerRunId: string;
  nodeId: string;
  agent: string;
  task: string;
  model: string;
  thinking: "xhigh";
  timeoutMs: number;
  schema: Record<string, unknown>;
  signal?: AbortSignal;
  onProgress?: (progress: DelegationProgress) => void;
}): Promise<DelegationResult> {
  if (!subagentsAvailable(options.pi)) throw new Error("pi-subagents is not active. Enable the pinned package extension and reload Pi.");
  options.signal?.throwIfAborted();
  const requestId = randomUUID();
  const request: SubagentDelegationRequest = {
    requestId,
    ownerRunId: options.ownerRunId,
    nodeId: options.nodeId,
    agent: options.agent,
    task: options.task,
    context: "fresh",
    cwd: options.ctx.cwd,
    model: options.model,
    thinking: options.thinking,
    timeoutMs: options.timeoutMs,
    skill: false,
    artifacts: false,
    result: { kind: "structured", schema: options.schema },
  };

  return new Promise<DelegationResult>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      unsubscribeResponse();
      unsubscribeUpdate();
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const cancel = (): void => {
      options.pi.events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { requestId, ownerRunId: options.ownerRunId, nodeId: options.nodeId });
    };
    const onAbort = (): void => {
      cancel();
      fail(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Specialist call cancelled."));
    };
    const unsubscribeUpdate = options.pi.events.on(SUBAGENT_DELEGATION_UPDATE_EVENT, (payload: unknown) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      const update = payload as SubagentDelegationUpdate;
      if (update.requestId !== requestId || update.ownerRunId !== options.ownerRunId || update.nodeId !== options.nodeId) return;
      options.onProgress?.({
        runId: update.runId,
        currentTool: update.currentTool,
        recentOutput: update.recentOutput,
        model: update.model,
        toolCount: update.toolCount,
        durationMs: update.durationMs,
        tokens: update.tokens,
      });
    });
    const unsubscribeResponse = options.pi.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload: unknown) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      const response = payload as SubagentDelegationResponse;
      if (response.requestId !== requestId) return;
      // A completed structured result is authoritative only when it carries the
      // complete identity tuple. A requestId by itself is not sufficient: it can
      // collide with another event producer in the same Pi process.
      if (response.ownerRunId !== options.ownerRunId || response.nodeId !== options.nodeId) return;
      if (settled) return;
      if (response.status !== "completed" || !("result" in response) || response.result?.kind !== "structured") {
        fail(new Error(response.error || `Specialist ended with status ${response.status}.`));
        return;
      }
      settled = true;
      cleanup();
      resolve({ value: response.result.value, model: response.model, thinking: response.thinking, usage: usageFromResponse(response) });
    });
    const timeout = setTimeout(() => {
      cancel();
      fail(new Error(`Specialist exceeded ${options.timeoutMs}ms.`));
    }, Math.min(options.timeoutMs + 1_000, 2_147_483_647));
    timeout.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      options.pi.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
    } catch (error) {
      fail(error);
    }
  });
}

export async function runDesign(options: Omit<Parameters<typeof delegateStructured>[0], "schema">): Promise<DesignRecord> {
  const result = await delegateStructured({ ...options, schema: DESIGN_SCHEMA as unknown as Record<string, unknown> });
  const value = result.value as Record<string, unknown>;
  return {
    decision: bounded(value?.decision, "design.decision"),
    rationale: bounded(value?.rationale, "design.rationale"),
    constraints: strings(value?.constraints, "design.constraints", 12),
    risks: strings(value?.risks, "design.risks", 12),
    implementationNotes: strings(value?.implementationNotes, "design.implementationNotes", 16),
    model: result.model,
    usage: result.usage,
    createdAt: Date.now(),
  };
}

export async function runReview(options: Omit<Parameters<typeof delegateStructured>[0], "schema"> & { repositoryFingerprint: string }): Promise<ReviewRecord> {
  const result = await delegateStructured({ ...options, schema: REVIEW_SCHEMA as unknown as Record<string, unknown> });
  const value = result.value as Record<string, unknown>;
  const verdict = value?.verdict;
  if (verdict !== "APPROVE" && verdict !== "CHANGES_REQUESTED" && verdict !== "BLOCKED") throw new Error("review.verdict is invalid.");
  if (!Array.isArray(value.findings) || value.findings.length > 50) throw new Error("review.findings must be a bounded array.");
  const findings: ReviewFinding[] = value.findings.map((raw, index) => {
    const finding = raw as Record<string, unknown>;
    const severity = finding.severity;
    if (severity !== "P0" && severity !== "P1" && severity !== "P2") throw new Error(`review.findings[${index}].severity is invalid.`);
    const line = finding.line;
    if (line !== undefined && (typeof line !== "number" || !Number.isInteger(line) || line < 1)) throw new Error(`review.findings[${index}].line is invalid.`);
    return {
      id: bounded(finding.id, `review.findings[${index}].id`, 200),
      severity,
      title: bounded(finding.title, `review.findings[${index}].title`, 2_000),
      evidence: bounded(finding.evidence, `review.findings[${index}].evidence`, 8_000),
      smallestFix: bounded(finding.smallestFix, `review.findings[${index}].smallestFix`, 4_000),
      file: finding.file === undefined ? undefined : bounded(finding.file, `review.findings[${index}].file`, 1_000),
      line: line as number | undefined,
    };
  });
  return {
    verdict,
    summary: bounded(value.summary, "review.summary", 8_000),
    findings,
    repositoryFingerprint: options.repositoryFingerprint,
    model: result.model,
    usage: result.usage,
    createdAt: Date.now(),
  };
}
