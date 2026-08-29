import { createHash } from "node:crypto";
import type { TaskDiff } from "./baseline.ts";
import type { ArtifactManifest, ReviewRecord, RunState } from "./state.ts";
import { hash, stableJson } from "./state.ts";
import { compactEvidence } from "./review.ts";

const SECRET_PATTERN = /(api[_-]?key|secret|password|token)\s*[:=]\s*[^\s,;]+/gi;
const MAX_SOL_CONTEXT = 4_000;
const MAX_PLAN_CONTEXT = 6_000;
const MAX_FINDING_TEXT = 1_000;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function redacted(value: string): { text: string; changed: boolean } {
  const text = value.replace(SECRET_PATTERN, "$1: [REDACTED]");
  return { text, changed: text !== value };
}

function bounded(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n[compact artifact excerpt]`;
}

function artifact(role: RunState["solDesign"], maximum: number): Record<string, unknown> | undefined {
  if (!role) return undefined;
  return {
    summary: bounded(role.summary, 1_500),
    body: bounded(role.body, maximum),
    acceptanceCriteria: role.acceptanceCriteria?.slice(0, 32),
    verificationCommands: role.verificationCommands?.slice(0, 32),
    hash: role.hash,
  };
}

function artifactIds(diff: TaskDiff): string[] {
  return diff.paths.map((path) => `diff:${path}`);
}

function manifestEntries(manifest: ArtifactManifest): Array<Record<string, unknown>> {
  return manifest.entries.map((entry) => ({ path: entry.path, hash: entry.hash, kind: entry.kind, size: entry.size, mode: entry.mode }));
}

function reviewContext(run: RunState, manifest: ArtifactManifest): Record<string, unknown> {
  return {
    packetVersion: 2,
    task: run.task,
    taskRevision: run.taskRevision,
    solDesign: artifact(run.solDesign, MAX_SOL_CONTEXT),
    terraTestPlan: artifact(run.terraPlan, MAX_PLAN_CONTEXT),
    artifactManifestHash: manifest.hash,
    artifactManifest: manifestEntries(manifest),
    verification: compactEvidence(run.verification, manifest.hash),
  };
}

export function packetBytes(packet: unknown): number {
  return Buffer.byteLength(JSON.stringify(packet), "utf8");
}

export function designPacket(run: RunState, question?: string): Record<string, unknown> {
  return {
    packetVersion: 2,
    role: "sol_design",
    task: run.task,
    taskRevision: run.taskRevision,
    question: question?.trim() || "Design the safest implementation approach.",
    constraints: ["Luna is the only mutating worker.", "Terra must plan tests before behavior-bearing mutation."],
  };
}

export function testPlanPacket(run: RunState): Record<string, unknown> {
  return {
    packetVersion: 2,
    role: "terra_test_plan",
    task: run.task,
    taskRevision: run.taskRevision,
    solDesign: artifact(run.solDesign, MAX_SOL_CONTEXT),
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
export function fullReviewPacket(run: RunState, diff: TaskDiff, manifest: ArtifactManifest): ReviewPacketResult {
  if (!diff.complete) return { complete: false, reason: diff.reason, artifactIds: [] };
  const sanitized = redacted(diff.text);
  if (sanitized.changed) {
    return { complete: false, reason: "Potential secret material in task diff; complete review requires an explicit safe artifact.", artifactIds: diff.paths };
  }
  const artifacts = artifactIds(diff);
  return {
    complete: true,
    artifactIds: artifacts,
    packet: {
      ...reviewContext(run, manifest),
      role: "terra_review",
      artifacts,
      diff: sanitized.text,
    },
  };
}

export function deltaReviewPacket(run: RunState, diff: TaskDiff, manifest: ArtifactManifest, previous: ReviewRecord): ReviewPacketResult {
  if (!diff.complete || !previous.snapshot) return { complete: false, reason: diff.reason ?? "No immutable full-review snapshot exists.", artifactIds: [] };
  const sanitized = redacted(diff.text);
  if (sanitized.changed) return { complete: false, reason: "Potential secret material in remediation delta.", artifactIds: diff.paths };
  const artifacts = artifactIds({ ...diff, paths: diff.text ? changedArtifactPaths(diff.text, diff.paths) : [] });
  const { artifactManifest: _fullManifest, ...context } = reviewContext(run, manifest);
  return {
    complete: true,
    artifactIds: artifacts,
    packet: {
      ...context,
      role: "terra_delta_review",
      baseEnvelopeHash: previous.envelopeHash,
      baseChainHash: previous.chainHash,
      priorFindings: (previous.activeFindings ?? previous.findings).map((finding) => ({ id: finding.id, severity: finding.severity, file: finding.file, line: finding.line, message: bounded(finding.message, MAX_FINDING_TEXT), requestedAction: finding.requestedAction ? bounded(finding.requestedAction, MAX_FINDING_TEXT) : undefined })),
      priorSnapshotManifestHash: previous.snapshot.manifest.hash,
      unchangedArtifactManifestHash: manifest.hash,
      remediationArtifactManifest: manifestEntries({ ...manifest, entries: manifest.entries.filter((entry) => artifacts.includes(`diff:${entry.path}`)) }),
      priorUnchangedArtifactManifest: manifestEntries({ ...previous.snapshot.manifest, entries: previous.snapshot.manifest.entries.filter((entry) => !artifacts.includes(`diff:${entry.path}`)) }),
      unchangedArtifactManifest: manifestEntries({ ...manifest, entries: manifest.entries.filter((entry) => !artifacts.includes(`diff:${entry.path}`)) }),
      artifacts,
      diff: sanitized.text,
    },
  };
}

function changedArtifactPaths(diff: string, fallback: string[]): string[] {
  if (!diff.trim()) return [];
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) paths.add(match[2]);
  }
  return paths.size ? [...paths].sort() : fallback;
}

interface DiffSection {
  paths: string[];
  text: string;
}

function diffSections(diff: string, fallback: string[]): DiffSection[] {
  const parts = diff.split(/(?=^diff --git )/m).filter(Boolean);
  if (parts.length <= 1 && !parts[0]?.startsWith("diff --git ")) return [{ paths: fallback, text: diff }];
  return parts.map((text) => ({ paths: changedArtifactPaths(text, fallback), text }));
}

function splitSection(section: DiffSection, fits: (text: string, paths: string[], part: number, total: number) => boolean): DiffSection[] {
  if (fits(section.text, section.paths, 1, 1)) return [section];
  // Never label a partial file fragment as complete artifact coverage. Multi-file
  // changes still shard efficiently; an individually unreviewable artifact blocks
  // rather than allowing synthesis to approve context it never received.
  throw new Error(`Artifact ${section.paths.join(", ")} exceeds the specialist packet limit and cannot be reviewed atomically.`);
}

/** Legacy small helper retained for callers/tests; production sharding uses shardFullReview. */
export function chunkDiff(diff: string, maxBytes: number): string[] {
  if (Buffer.byteLength(diff, "utf8") <= maxBytes) return [diff];
  const chunks: string[] = [];
  let current = "";
  for (const line of diff.split("\n")) {
    const next = current ? `${current}\n${line}` : line;
    if (current && Buffer.byteLength(next, "utf8") > maxBytes) {
      chunks.push(current);
      current = line;
    } else current = next;
  }
  if (current) chunks.push(current);
  return chunks;
}

export interface ReviewShard {
  id: string;
  packet: Record<string, unknown>;
  artifactIds: string[];
}

/** Build bounded full-review transport packets without repeating the complete diff in every child call. */
export function shardFullReview(packet: Record<string, unknown>, limit: number): ReviewShard[] {
  const { diff, artifacts: _artifacts, artifactManifest: rawManifest, role: _role, ...context } = packet;
  const allManifest = Array.isArray(rawManifest) ? rawManifest as Array<Record<string, unknown>> : [];
  const text = String(diff ?? "");
  const fallback = Array.isArray(_artifacts) ? _artifacts.map((item) => String(item).replace(/^diff:/, "")) : [];
  const provisional = (part: string, paths: string[], index: number, total: number): Record<string, unknown> => ({
    ...context,
    role: "terra_review_shard",
    artifactManifest: allManifest.filter((entry) => paths.includes(String(entry.path))),
    artifacts: paths.map((path) => `diff:${path}`),
    shard: { index, total, artifactPaths: paths },
    diff: part,
  });
  const sections = diffSections(text, fallback);
  const pieces: DiffSection[] = [];
  for (const section of sections) {
    pieces.push(...splitSection(section, (part, paths, index, total) => packetBytes(provisional(part, paths, index, total)) <= limit));
  }
  const shards: DiffSection[] = [];
  let current: DiffSection | undefined;
  for (const piece of pieces) {
    const combined = current ? { paths: [...new Set([...current.paths, ...piece.paths])].sort(), text: `${current.text}\n${piece.text}` } : piece;
    if (current && packetBytes(provisional(combined.text, combined.paths, shards.length + 1, pieces.length)) > limit) {
      shards.push(current);
      current = piece;
    } else {
      current = combined;
    }
  }
  if (current) shards.push(current);
  return shards.map((shard, index) => {
    const packetValue = provisional(shard.text, shard.paths, index + 1, shards.length);
    if (packetBytes(packetValue) > limit) throw new Error("A full-review shard exceeds the specialist packet limit after compacting context.");
    return { id: `shard-${index + 1}`, packet: packetValue, artifactIds: shard.paths.map((path) => `diff:${path}`) };
  });
}

export function reviewSynthesisPacket(run: RunState, manifest: ArtifactManifest, artifactIds: string[], shardResults: Array<{ id: string; artifactIds: string[]; summary: string; findings: unknown; coverage: string[] }>): Record<string, unknown> {
  return {
    packetVersion: 2,
    role: "terra_review_synthesis",
    task: run.task,
    taskRevision: run.taskRevision,
    artifactManifestHash: manifest.hash,
    artifactManifest: manifestEntries(manifest),
    artifacts: artifactIds,
    verification: compactEvidence(run.verification, manifest.hash),
    shards: shardResults,
  };
}

export function envelopeHash(run: RunState, diff: TaskDiff, manifest?: ArtifactManifest): string {
  return digest({
    task: run.task,
    revision: run.taskRevision,
    sol: run.solDesign?.hash,
    plan: run.terraPlan?.hash,
    diff: diff.hash,
    paths: diff.paths,
    manifest: manifest?.hash,
    verification: compactEvidence(run.verification, manifest?.hash ?? "").map((entry) => ({ command: entry.command, exitCode: entry.exitCode, outputHash: entry.outputHash, beforeManifestHash: entry.beforeManifestHash, manifestHash: entry.manifestHash })),
    unscoped: [...run.unscopedChanges].sort(),
  });
}

export function asReviewRecord(run: RunState, verdict: ReviewRecord["verdict"], summary: string, findings: ReviewRecord["findings"], envelope: string, coverage: string[], usage?: ReviewRecord["usage"]): ReviewRecord {
  return { pass: run.reviews.length + 1, verdict, summary, findings, envelopeHash: envelope, coverage, usage, createdAt: Date.now() };
}
