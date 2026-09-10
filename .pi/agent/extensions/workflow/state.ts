import { createHash, randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const WORKFLOW_STATE_TYPE = "workflow-lite-state";
export const WORKFLOW_STATE_VERSION = 1;

export type WorkflowMode = "standard" | "design";
export type RunStage =
  | "designing"
  | "planning"
  | "implementing"
  | "verifying"
  | "reviewing"
  | "fixing"
  | "completed"
  | "completed_after_fixes"
  | "cancelled"
  | "failed";

export interface PreviousSessionSettings {
  provider?: string;
  model?: string;
  thinking?: string;
  subagentWasActive: boolean;
}

export interface BaselineRef {
  dir: string;
  manifestPath: string;
  cwd: string;
  initialHead: string;
  initialFingerprint: string;
  createdAt: number;
}

export interface PlanCheck {
  id: string;
  label: string;
  command: string;
}

export interface WorkflowPlan {
  revision: number;
  summary: string;
  acceptanceCriteria: string[];
  steps: string[];
  checks: PlanCheck[];
  createdAt: number;
}

export interface DesignRecord {
  decision: string;
  rationale: string;
  constraints: string[];
  risks: string[];
  implementationNotes: string[];
  model?: string;
  usage?: UsageTotals;
  createdAt: number;
}

export type CheckStatus = "passed" | "failed" | "timed_out" | "cancelled" | "mutated" | "not_run";

export interface CheckReceipt {
  id: string;
  label: string;
  command: string;
  status: CheckStatus;
  exitCode?: number;
  outputTail: string;
  outputTruncated: boolean;
  logPath?: string;
  durationMs: number;
  beforeFingerprint?: string;
  afterFingerprint?: string;
  changedPaths: string[];
}

export interface VerificationRecord {
  attempt: number;
  planRevision: number;
  status: "passed" | "failed" | "cancelled" | "mutated";
  checks: CheckReceipt[];
  repositoryFingerprint: string;
  startedAt: number;
  completedAt: number;
}

export type ReviewVerdict = "APPROVE" | "CHANGES_REQUESTED" | "BLOCKED";
export type FindingSeverity = "P0" | "P1" | "P2";

export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  title: string;
  evidence: string;
  smallestFix: string;
  file?: string;
  line?: number;
}

export interface ReviewRecord {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  repositoryFingerprint: string;
  model?: string;
  usage?: UsageTotals;
  createdAt: number;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns?: number;
  toolCalls?: number;
  durationMs?: number;
}

export interface RunState {
  id: string;
  goal: string;
  mode: WorkflowMode;
  stage: RunStage;
  baseline: BaselineRef;
  design?: DesignRecord;
  plan?: WorkflowPlan;
  verification?: VerificationRecord;
  /** Set immediately before the one permitted reviewer delegation is dispatched. */
  reviewStarted?: boolean;
  review?: ReviewRecord;
  startedAt: number;
  updatedAt: number;
  lastError?: string;
}

export interface WorkflowState {
  version: 1;
  run?: RunState;
  prior?: PreviousSessionSettings;
  updatedAt: number;
}

export function emptyState(): WorkflowState {
  return { version: WORKFLOW_STATE_VERSION, updatedAt: Date.now() };
}

export function newRun(goal: string, mode: WorkflowMode, baseline: BaselineRef, id = randomUUID()): RunState {
  const timestamp = Date.now();
  return {
    id,
    goal: goal.trim(),
    mode,
    stage: mode === "design" ? "designing" : "planning",
    baseline,
    startedAt: timestamp,
    updatedAt: timestamp,
  };
}

export function isTerminal(stage: RunStage): boolean {
  return stage === "completed" || stage === "completed_after_fixes" || stage === "cancelled" || stage === "failed";
}

export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

function looksLikeState(value: unknown): value is WorkflowState {
  const candidate = value as Partial<WorkflowState> | undefined;
  return Boolean(candidate && candidate.version === WORKFLOW_STATE_VERSION && typeof candidate.updatedAt === "number");
}

/** Clean cut: only the new custom entry and exact state version are restored. */
export function restoreState(entries: SessionEntry[]): WorkflowState {
  const entry = [...entries].reverse().find((item) => item.type === "custom" && item.customType === WORKFLOW_STATE_TYPE) as { data?: unknown } | undefined;
  if (!entry || !looksLikeState(entry.data)) return emptyState();
  const restored = structuredClone(entry.data);
  if (restored.run?.stage === "verifying") {
    restored.run.stage = restored.run.review?.verdict === "CHANGES_REQUESTED" ? "fixing" : "implementing";
    restored.run.lastError = "Verification was interrupted; run the complete verification suite again.";
  } else if (restored.run?.stage === "reviewing" && restored.run.reviewStarted && !restored.run.review) {
    restored.run.stage = "failed";
    restored.run.lastError = "The independent review was interrupted after dispatch and is not retried, preserving the one-review policy.";
  }
  return restored;
}

export function expectedNext(run: RunState): string {
  switch (run.stage) {
    case "designing": return "Call workflow_design.";
    case "planning": return "Call workflow_plan with acceptance criteria, steps, and final checks.";
    case "implementing": return "Implement the plan, then call workflow_verify.";
    case "verifying": return "Wait for workflow_verify to finish.";
    case "reviewing": return "Call workflow_review.";
    case "fixing": return "Address the review findings, then call workflow_verify.";
    case "completed": return "Summarize the approved implementation and verification.";
    case "completed_after_fixes": return "Summarize the remediation and note that no second independent review ran.";
    case "cancelled": return "Start a new /workflow task if more work is needed.";
    case "failed": return "Inspect the failure and start a new bounded workflow when ready.";
  }
}

export function stateSummary(state: WorkflowState): Record<string, unknown> {
  const run = state.run;
  return {
    active: Boolean(run && !isTerminal(run.stage)),
    runId: run?.id,
    goal: run?.goal,
    mode: run?.mode,
    stage: run?.stage,
    planRevision: run?.plan?.revision,
    checks: run?.verification?.checks.map((check) => ({ id: check.id, status: check.status, exitCode: check.exitCode })) ?? [],
    verification: run?.verification?.status,
    review: run?.review?.verdict,
    reviewStarted: run?.reviewStarted ?? false,
    findings: run?.review?.findings.length ?? 0,
    lastError: run?.lastError,
    next: run ? expectedNext(run) : "Start with /workflow <task>.",
  };
}
