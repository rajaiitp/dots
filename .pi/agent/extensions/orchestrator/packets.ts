import { createHash } from "node:crypto";
import type { TaskDiff } from "./baseline.ts";
import type { ReviewRecord, RunState } from "./state.ts";

const SECRET_PATTERN = /(api[_-]?key|secret|password|token)\s*[:=]\s*[^\s,;]+/gi;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function redacted(value: string): { text: string; changed: boolean } {
  const text = value.replace(SECRET_PATTERN, "$1: [REDACTED]");
  return { text, changed: text !== value };
}

export function designPacket(run: RunState, question?: string): Record<string, unknown> {
  return {
    packetVersion: 1,
    role: "sol_design",
    task: run.task,
    taskRevision: run.taskRevision,
    question: question?.trim() || "Design the safest implementation approach.",
    constraints: ["Luna is the only mutating worker.", "Terra must plan tests before behavior-bearing mutation."],
  };
}

export function testPlanPacket(run: RunState): Record<string, unknown> {
  return {
    packetVersion: 1,
    role: "terra_test_plan",
    task: run.task,
    taskRevision: run.taskRevision,
    solDesign: run.solDesign ? { summary: run.solDesign.summary, body: run.solDesign.body, hash: run.solDesign.hash } : undefined,
    existingChanges: run.taskPaths,
  };
}

export interface ReviewPacketResult {
  packet?: Record<string, unknown>;
  complete: boolean;
  reason?: string;
  artifactIds: string[];
}

/** Redaction changes the artifact, so approval is forbidden rather than silently reviewing an altered diff. */
export function reviewPacket(run: RunState, diff: TaskDiff): ReviewPacketResult {
  if (!diff.complete) return { complete: false, reason: diff.reason, artifactIds: [] };
  const sanitized = redacted(diff.text);
  if (sanitized.changed) {
    return { complete: false, reason: "Potential secret material in task diff; complete review requires an explicit safe artifact.", artifactIds: diff.paths };
  }
  const artifactIds = diff.paths.map((path) => `diff:${path}`);
  return {
    complete: true,
    artifactIds,
    packet: {
      packetVersion: 1,
      role: "terra_review",
      task: run.task,
      taskRevision: run.taskRevision,
      solDesign: run.solDesign ? { summary: run.solDesign.summary, body: run.solDesign.body, hash: run.solDesign.hash } : undefined,
      terraTestPlan: run.terraPlan ? { summary: run.terraPlan.summary, body: run.terraPlan.body, hash: run.terraPlan.hash } : undefined,
      verification: run.verification.map((evidence) => ({
        tool: evidence.toolName,
        command: evidence.command,
        exitCode: evidence.exitCode,
        isError: evidence.isError,
        output: evidence.output,
        beforeRepoHash: evidence.beforeRepoHash,
        afterRepoHash: evidence.afterRepoHash,
      })),
      artifacts: artifactIds,
      diff: sanitized.text,
    },
  };
}

export function reviewSynthesisPacket(run: RunState, artifactIds: string[], shardResults: Array<{ summary: string; body: string; findings: unknown }>): Record<string, unknown> {
  return {
    packetVersion: 1,
    role: "terra_review_synthesis",
    task: run.task,
    taskRevision: run.taskRevision,
    artifactIds,
    verification: run.verification,
    shardResults,
  };
}

export function envelopeHash(run: RunState, diff: TaskDiff): string {
  return hash({
    task: run.task,
    revision: run.taskRevision,
    sol: run.solDesign?.hash,
    plan: run.terraPlan?.hash,
    diff: diff.hash,
    paths: diff.paths,
    verification: run.verification.map((entry) => ({
      command: entry.command,
      exitCode: entry.exitCode,
      before: entry.beforeRepoHash,
      after: entry.afterRepoHash,
    })),
    unscoped: [...run.unscopedChanges].sort(),
  });
}

export function chunkDiff(diff: string, maxBytes: number): string[] {
  if (Buffer.byteLength(diff, "utf8") <= maxBytes) return [diff];
  const chunks: string[] = [];
  let current = "";
  for (const line of diff.split("\n")) {
    const next = current ? `${current}\n${line}` : line;
    if (Buffer.byteLength(next, "utf8") > maxBytes && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function asReviewRecord(run: RunState, verdict: ReviewRecord["verdict"], summary: string, findings: ReviewRecord["findings"], envelope: string, coverage: string[], usage?: ReviewRecord["usage"]): ReviewRecord {
  return { pass: run.reviews.length + 1, verdict, summary, findings, envelopeHash: envelope, coverage, usage, createdAt: Date.now() };
}
