import type { ArtifactManifest, Finding, ReviewRecord, ReviewScope, RunState, VerificationEvidence } from "./state.ts";
import { hash, stableJson } from "./state.ts";

export interface ReviewSelection {
  scope: ReviewScope;
  fallbackReason?: string;
  base?: ReviewRecord;
}

export interface CompactEvidence {
  command: string;
  exitCode?: number;
  isError: boolean;
  outputHash: string;
  outputExcerpt: string;
  truncated: boolean;
  beforeManifestHash?: string;
  manifestHash?: string;
}

const HIGH_RISK_PATH = /(?:^|\/)(?:\.pi\/|\.agents\/|auth|oauth|security|permission|schema|migrations?|database|api|public|config|deploy)/i;
const ROUTINE_READ_COMMAND = /^\s*git\s+(?:status|diff|log|show|branch|rev-parse|ls-files)\b/i;

function sameArtifactShape(left: ArtifactManifest, right: ArtifactManifest): boolean {
  return stableJson(left.entries.map((entry) => ({ path: entry.path, kind: entry.kind, mode: entry.mode })))
    === stableJson(right.entries.map((entry) => ({ path: entry.path, kind: entry.kind, mode: entry.mode })));
}

function highRisk(run: RunState, manifest: ArtifactManifest): boolean {
  return run.needsSol || manifest.entries.some((entry) => HIGH_RISK_PATH.test(entry.path));
}

/**
 * Delta review is intentionally conservative. Failure to prove every condition
 * produces a full review, never a best-effort small packet.
 */
export function selectReviewScope(run: RunState, manifest: ArtifactManifest, enabled: boolean): ReviewSelection {
  const previous = run.reviews.at(-1);
  if (!previous) return { scope: "full", fallbackReason: "initial Terra review" };
  if (!enabled) return { scope: "full", fallbackReason: "delta reviews disabled" };
  if (previous.verdict !== "CHANGES_REQUESTED") return { scope: "full", fallbackReason: "previous Terra verdict was not changes requested" };
  if (!previous.snapshot) return { scope: "full", fallbackReason: "previous review has no immutable snapshot" };
  if (previous.taskRevision !== run.taskRevision || previous.solDesignHash !== run.solDesign?.hash || previous.terraPlanHash !== run.terraPlan?.hash) {
    return { scope: "full", fallbackReason: "task, Sol design, or Terra plan changed" };
  }
  if (highRisk(run, manifest)) return { scope: "full", fallbackReason: "high-risk task or artifact" };
  if (!sameArtifactShape(previous.snapshot.manifest, manifest)) return { scope: "full", fallbackReason: "task artifact set, type, or mode changed" };
  if (!manifest.entries.every((entry) => entry.kind === "file")) return { scope: "full", fallbackReason: "non-regular task artifact" };
  if ((previous.activeFindings ?? previous.findings).some((finding) => !finding.id || !finding.file)) return { scope: "full", fallbackReason: "prior finding has no stable file target" };
  if (run.unscopedChanges.length) return { scope: "full", fallbackReason: "unscoped repository change" };
  return { scope: "delta", base: previous };
}

/** Exact new-file line references represented by a unified diff's hunks. */
export function diffLineReferences(diff: string): Set<string> {
  const references = new Set<string>();
  let path: string | undefined;
  let line: number | undefined;
  for (const value of diff.split("\n")) {
    const file = /^diff --git a\/(.+?) b\/(.+)$/.exec(value);
    if (file) { path = file[2]; line = undefined; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(value);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!path || line === undefined || value.startsWith("---") || value.startsWith("+++")) continue;
    if (value.startsWith("-")) continue;
    references.add(`${path}:${line}`);
    line += 1;
  }
  return references;
}

export function compactEvidence(evidence: VerificationEvidence[], manifestHash: string): CompactEvidence[] {
  const latest = new Map<string, VerificationEvidence>();
  for (const item of evidence) {
    if (!item.command.trim() || ROUTINE_READ_COMMAND.test(item.command)) continue;
    latest.set(item.command.trim(), item);
  }
  return [...latest.values()]
    .sort((a, b) => a.command.localeCompare(b.command))
    .map((item) => {
      const limit = item.isError || item.exitCode !== 0 ? 2_048 : 512;
      const truncated = item.truncated === true || item.output.length > limit;
      return {
        command: item.command,
        exitCode: item.exitCode,
        isError: item.isError,
        outputHash: item.outputHash ?? hash(item.output),
        outputExcerpt: item.output.slice(0, limit),
        truncated,
        beforeManifestHash: item.beforeArtifactManifestHash,
        manifestHash: item.artifactManifestHash,
      };
    });
}

/** Required checks must have succeeded against the exact artifact manifest under review. */
export function hasFreshVerification(run: RunState, manifestHash: string): boolean {
  const evidence = compactEvidence(run.verification, manifestHash);
  // A reliable zero exit code remains authoritative even if verbose output was
  // excerpted; the truncation flag is still shown to Terra for judgment.
  const successful = evidence.filter((item) => !item.isError && item.exitCode === 0 && item.manifestHash === manifestHash && item.beforeManifestHash === manifestHash);
  if (successful.length === 0) return false;
  const required = run.terraPlan?.verificationCommands?.map((command) => command.trim()).filter(Boolean) ?? [];
  return required.every((command) => successful.some((item) => item.command === command));
}

export interface FindingTriageContext {
  acceptanceCriteria: string[];
  solDesign?: string;
  artifactPaths: string[];
  diffReferences: Set<string>;
  failedTestOutput: string[];
}

export interface FindingTriage {
  blockers: Finding[];
  advisories: Finding[];
}

function concreteMediumEvidence(finding: Finding, context: FindingTriageContext): boolean {
  return (finding.evidence ?? []).some((evidence) => {
    if (evidence.kind === "acceptance_criterion") return context.acceptanceCriteria.some((criterion) => criterion.startsWith(`${evidence.reference}:`) || criterion === evidence.reference);
    if (evidence.kind === "invariant") return Boolean(context.solDesign && context.solDesign.includes(evidence.reference));
    if (evidence.kind === "failed_test") return context.failedTestOutput.some((output) => output.includes(evidence.reference));
    return context.diffReferences.has(evidence.reference);
  });
}

/** Stable IDs make an unchanged finding idempotent across remediation deltas. */
export function assignFindingIds(_pass: number, findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.map((finding) => {
    if (!finding.key?.trim()) throw new Error("Terra finding has no stable semantic key.");
    const id = `T-${hash({ key: finding.key.trim() }).slice(0, 12)}`;
    if (seen.has(id)) throw new Error("Terra returned duplicate finding IDs.");
    seen.add(id);
    return { ...finding, id };
  });
}

/** Product-balanced policy: medium requires concrete evidence; low/info never reopen work. */
export function triageFindings(findings: Finding[], context: FindingTriageContext): FindingTriage {
  const blockers: Finding[] = [];
  const advisories: Finding[] = [];
  for (const finding of findings) {
    if (finding.severity === "critical" || finding.severity === "high") blockers.push(finding);
    else if (finding.severity === "medium" && concreteMediumEvidence(finding, context)) blockers.push(finding);
    else advisories.push(finding);
  }
  return { blockers, advisories };
}

/** Last observation for an advisory ID wins; a blocker of the same ID removes it. */
export function mergeAdvisories(existing: Finding[], incoming: Finding[], blockers: Finding[]): Finding[] {
  const blocked = new Set(blockers.map((finding) => finding.id));
  const merged = new Map<string, Finding>();
  for (const finding of [...existing, ...incoming]) {
    if (finding.id && !blocked.has(finding.id)) merged.set(finding.id, finding);
  }
  return [...merged.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

export function reviewChainHash(previous: ReviewRecord | undefined, record: Pick<ReviewRecord, "envelopeHash" | "verdict" | "scope" | "coverage" | "resolutions" | "activeFindings" | "advisories">): string {
  return hash({
    previous: previous?.chainHash,
    envelope: record.envelopeHash,
    verdict: record.verdict,
    scope: record.scope,
    coverage: [...record.coverage].sort(),
    resolutions: record.resolutions?.map((resolution) => ({ ...resolution })).sort((left, right) => left.id.localeCompare(right.id)),
    activeFindings: record.activeFindings?.map((finding) => ({ id: finding.id, key: finding.key, file: finding.file, line: finding.line, message: finding.message })).sort((left, right) => String(left.id).localeCompare(String(right.id))),
    advisories: record.advisories?.map((finding) => ({ id: finding.id, severity: finding.severity, message: finding.message })).sort((left, right) => String(left.id).localeCompare(String(right.id))),
  });
}
