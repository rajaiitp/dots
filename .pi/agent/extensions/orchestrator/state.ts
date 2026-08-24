import { createHash, randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const ORCH_STATE_TYPE = "orchestrator-state";
export const ORCH_STATE_VERSION = 1;

export type RunStage =
  | "intake"
  | "designing"
  | "test_planning"
  | "implementing"
  | "verifying"
  | "reviewing"
  | "remediating"
  | "approved"
  | "blocked"
  | "finished";

export type ReviewVerdict = "APPROVE" | "CHANGES_REQUESTED" | "BLOCKED";

export interface PreviousSessionSettings {
  provider?: string;
  model?: string;
  thinking?: string;
  tools: string[];
}

export interface RoleArtifact {
  role: "sol" | "terra";
  kind: string;
  summary: string;
  body: string;
  hash: string;
  usage?: UsageTotals;
  createdAt: number;
}

export interface Finding {
  severity: "critical" | "high" | "medium" | "low" | "info";
  file?: string;
  line?: number;
  message: string;
  requestedAction?: string;
}

export interface ReviewRecord {
  pass: number;
  verdict: ReviewVerdict;
  summary: string;
  findings: Finding[];
  envelopeHash: string;
  coverage: string[];
  usage?: UsageTotals;
  createdAt: number;
}

export interface VerificationEvidence {
  toolName: string;
  command: string;
  exitCode?: number;
  isError: boolean;
  output: string;
  beforeRepoHash: string;
  afterRepoHash: string;
  createdAt: number;
}

export interface BaselineRef {
  dir: string;
  manifestPath: string;
  initialRepoHash: string;
  createdAt: number;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface RunState {
  id: string;
  generation: number;
  task: string;
  taskRevision: number;
  stage: RunStage;
  startedAt: number;
  updatedAt: number;
  baseline: BaselineRef;
  needsSol: boolean;
  solConsults: number;
  solDesign?: RoleArtifact;
  terraPlan?: RoleArtifact;
  reviews: ReviewRecord[];
  taskPaths: string[];
  docsOnlyPaths: string[];
  behaviorMutation: boolean;
  unscopedChanges: string[];
  verification: VerificationEvidence[];
  lastRepoHash: string;
  lastEnvelopeHash?: string;
  approvalEnvelopeHash?: string;
  nudgeCount: number;
  blockedReason?: string;
}

export interface OrchestratorState {
  version: number;
  enabled: boolean;
  prior?: PreviousSessionSettings;
  run?: RunState;
  updatedAt: number;
}

export function emptyState(): OrchestratorState {
  return { version: ORCH_STATE_VERSION, enabled: false, updatedAt: Date.now() };
}

export function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

/** Deterministic JSON is required because Terra approval binds to this envelope. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function newRun(task: string, baseline: BaselineRef, repoHash: string, runId = randomUUID()): RunState {
  const now = Date.now();
  return {
    id: runId,
    generation: 1,
    task: task.trim(),
    taskRevision: 1,
    stage: "intake",
    startedAt: now,
    updatedAt: now,
    baseline,
    needsSol: needsSolDesign(task),
    solConsults: 0,
    reviews: [],
    taskPaths: [],
    docsOnlyPaths: [],
    behaviorMutation: false,
    unscopedChanges: [],
    verification: [],
    lastRepoHash: repoHash,
    nudgeCount: 0,
  };
}

export function isTerminal(stage: RunStage): boolean {
  return stage === "blocked" || stage === "finished";
}

export function currentApproval(run: RunState): ReviewRecord | undefined {
  return run.reviews.at(-1)?.verdict === "APPROVE" ? run.reviews.at(-1) : undefined;
}

export function invalidateApproval(run: RunState): void {
  run.approvalEnvelopeHash = undefined;
  if (run.stage === "approved") run.stage = "implementing";
}

export function reviseTask(run: RunState, task: string): void {
  run.task = task.trim();
  run.taskRevision += 1;
  run.generation += 1;
  run.needsSol = needsSolDesign(run.task);
  run.solDesign = undefined;
  run.terraPlan = undefined;
  // Preserve review history so a task revision cannot bypass the per-run cap.
  run.verification = [];
  run.approvalEnvelopeHash = undefined;
  run.stage = "intake";
  run.updatedAt = Date.now();
}

export function needsSolDesign(task: string): boolean {
  return /\b(api|public contract|schema|migration|database|auth(?:entication)?|security|permission|oauth|concurren|race condition|lifecycle|deploy(?:ment)?|architecture|distributed|multi[- ]?service|breaking change)\b/i.test(task);
}

export function addPath(list: string[], path: string): void {
  if (!list.includes(path)) list.push(path);
}

export function usageZero(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addUsage(target: UsageTotals, extra?: Partial<UsageTotals>): UsageTotals {
  if (!extra) return target;
  target.input += extra.input ?? 0;
  target.output += extra.output ?? 0;
  target.cacheRead += extra.cacheRead ?? 0;
  target.cacheWrite += extra.cacheWrite ?? 0;
  target.cost += extra.cost ?? 0;
  return target;
}

function looksLikeState(value: unknown): value is OrchestratorState {
  const state = value as Partial<OrchestratorState> | undefined;
  return !!state && state.version === ORCH_STATE_VERSION && typeof state.enabled === "boolean";
}

/** Active-branch restoration prevents state from another /tree branch leaking in. */
export function restoreState(entries: SessionEntry[]): OrchestratorState {
  const latest = [...entries]
    .reverse()
    .find((entry) => entry.type === "custom" && entry.customType === ORCH_STATE_TYPE) as
      | { data?: unknown }
      | undefined;
  if (!latest || !looksLikeState(latest.data)) return emptyState();
  return latest.data;
}

export function stateSummary(state: OrchestratorState): Record<string, unknown> {
  const run = state.run;
  return {
    enabled: state.enabled,
    runId: run?.id,
    stage: run?.stage,
    taskRevision: run?.taskRevision,
    reviewPass: run?.reviews.length ?? 0,
    solConsults: run?.solConsults ?? 0,
    approved: Boolean(run?.approvalEnvelopeHash),
    blocked: run?.blockedReason,
  };
}
