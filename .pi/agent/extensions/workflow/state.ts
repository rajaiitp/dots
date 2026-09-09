import { createHash, randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const WORKFLOW_STATE_TYPE = "workflow-state";
export const WORKFLOW_STATE_VERSION = 5;

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
export type ReviewScope = "full" | "delta";
export type ReviewTransport = "single" | "sharded";

export interface ArtifactManifestEntry {
  path: string;
  hash?: string;
  size?: number;
  mode?: number;
  kind: "file" | "missing" | "symlink" | "other";
}

export interface ArtifactManifest {
  version: 1;
  entries: ArtifactManifestEntry[];
  hash: string;
}

/** Immutable post-review copy used solely to derive a later remediation delta. */
export interface ReviewSnapshot {
  id: string;
  dir: string;
  manifest: ArtifactManifest;
  createdAt: number;
}

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
  acceptanceCriteria?: string[];
  verificationCommands?: string[];
  hash: string;
  usage?: UsageTotals;
  createdAt: number;
}

export interface FindingEvidence {
  kind: "acceptance_criterion" | "invariant" | "failed_test" | "regression" | "api" | "security";
  reference: string;
}

export interface Finding {
  /** Model-supplied semantic key; stable across line shifts and wording edits. */
  key: string;
  id?: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  file?: string;
  line?: number;
  message: string;
  requestedAction?: string;
  evidence?: FindingEvidence[];
}

export interface FindingResolution {
  id: string;
  status: "fixed" | "open" | "invalidated";
  note: string;
  evidence: FindingEvidence[];
  artifactPaths: string[];
}

export interface ReviewRecord {
  pass: number;
  verdict: ReviewVerdict;
  summary: string;
  findings: Finding[];
  /** Every unresolved actionable finding carried into the next remediation pass. */
  activeFindings?: Finding[];
  advisories?: Finding[];
  resolutions?: FindingResolution[];
  envelopeHash: string;
  coverage: string[];
  scope?: ReviewScope;
  transport?: ReviewTransport;
  fallbackReason?: string;
  baseEnvelopeHash?: string;
  snapshot?: ReviewSnapshot;
  chainHash?: string;
  packetBytes?: number;
  taskRevision?: number;
  solDesignHash?: string;
  terraPlanHash?: string;
  usage?: UsageTotals;
  createdAt: number;
}

export interface VerificationEvidence {
  toolName: string;
  command: string;
  exitCode?: number;
  isError: boolean;
  output: string;
  outputHash?: string;
  truncated?: boolean;
  beforeArtifactManifestHash?: string;
  artifactManifestHash?: string;
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

export type ActivityStatus = "running" | "done" | "error" | "blocked";

/** TUI-only recent activity. Persisted as custom entries, never added to model context. */
export interface WorkflowActivity {
  id: string;
  label: string;
  detail?: string;
  status: ActivityStatus;
  startedAt: number;
  finishedAt?: number;
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
  advisories: Finding[];
  taskPaths: string[];
  docsOnlyPaths: string[];
  behaviorMutation: boolean;
  gatedWorkStarted: boolean;
  unscopedChanges: string[];
  verification: VerificationEvidence[];
  lastRepoHash: string;
  lastEnvelopeHash?: string;
  approvalEnvelopeHash?: string;
  approvalChainHash?: string;
  nudgeCount: number;
  activities: WorkflowActivity[];
  blockedReason?: string;
}

export interface WorkflowState {
  version: number;
  enabled: boolean;
  prior?: PreviousSessionSettings;
  run?: RunState;
  updatedAt: number;
}

export function emptyState(): WorkflowState {
  return { version: WORKFLOW_STATE_VERSION, enabled: false, updatedAt: Date.now() };
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
    advisories: [],
    taskPaths: [],
    docsOnlyPaths: [],
    behaviorMutation: false,
    gatedWorkStarted: false,
    unscopedChanges: [],
    verification: [],
    lastRepoHash: repoHash,
    nudgeCount: 0,
    activities: [],
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
  run.advisories = [];
  run.verification = [];
  run.approvalEnvelopeHash = undefined;
  run.approvalChainHash = undefined;
  run.nudgeCount = 0;
  run.blockedReason = undefined;
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

function looksLikeState(value: unknown): value is WorkflowState {
  const state = value as Partial<WorkflowState> | undefined;
  return !!state && [1, 2, 3, 4, WORKFLOW_STATE_VERSION].includes(Number(state.version)) && typeof state.enabled === "boolean";
}

/** Active-branch restoration prevents state from another /tree branch leaking in. */
export function restoreState(entries: SessionEntry[]): WorkflowState {
  const latest = [...entries]
    .reverse()
    .find((entry) => entry.type === "custom" && entry.customType === WORKFLOW_STATE_TYPE) as
      | { data?: unknown }
      | undefined;
  if (!latest || !looksLikeState(latest.data)) return emptyState();
  const restored = latest.data as WorkflowState;
  const priorVersion = restored.version;
  if (priorVersion < WORKFLOW_STATE_VERSION) {
    restored.version = WORKFLOW_STATE_VERSION;
    if (restored.run) {
      restored.run.advisories ??= [];
      restored.run.activities ??= [];
      restored.run.gatedWorkStarted ??= Boolean(restored.run.behaviorMutation || restored.run.terraPlan || restored.run.solDesign);
    }
    for (const review of restored.run?.reviews ?? []) {
      review.scope ??= "full";
      review.transport ??= "single";
      review.advisories ??= [];
    }
    // V1 approvals cannot prove the snapshot/chain invariants introduced in V2.
    // Require one fresh full review instead of leaving the run unfinishable.
    if (priorVersion === 1 && (restored.run?.approvalEnvelopeHash || restored.run?.stage === "approved")) {
      restored.run.approvalEnvelopeHash = undefined;
      restored.run.approvalChainHash = undefined;
      restored.run.reviews = [];
      restored.run.stage = "implementing";
      restored.run.blockedReason = undefined;
    }
  }
  return restored;
}

export function stateSummary(state: WorkflowState): Record<string, unknown> {
  const run = state.run;
  return {
    enabled: state.enabled,
    runId: run?.id,
    stage: run?.stage,
    taskRevision: run?.taskRevision,
    reviewPass: run?.reviews.length ?? 0,
    reviewScope: run?.reviews.at(-1)?.scope,
    reviewTransport: run?.reviews.at(-1)?.transport,
    reviewPacketBytes: run?.reviews.at(-1)?.packetBytes,
    reviewFallback: run?.reviews.at(-1)?.fallbackReason,
    advisories: run?.advisories.length ?? 0,
    solConsults: run?.solConsults ?? 0,
    approved: Boolean(run?.approvalEnvelopeHash),
    blocked: run?.blockedReason,
    recentActivity: run?.activities.slice(-5),
  };
}
