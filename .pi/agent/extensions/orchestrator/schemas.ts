import { Type } from "typebox";
import type { Finding, FindingEvidence, ReviewVerdict } from "./state.ts";

export const RoleResultSchema = Type.Object({
  kind: Type.String({ minLength: 1 }),
  summary: Type.String({ minLength: 1 }),
  body: Type.String({ minLength: 1 }),
  verdict: Type.Optional(Type.Union([
    Type.Literal("APPROVE"),
    Type.Literal("CHANGES_REQUESTED"),
    Type.Literal("BLOCKED"),
  ])),
  acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
  verificationCommands: Type.Optional(Type.Array(Type.String())),
  findings: Type.Optional(Type.Array(Type.Object({
    key: Type.String({ minLength: 1, maxLength: 160 }),
    severity: Type.String(),
    file: Type.Optional(Type.String()),
    line: Type.Optional(Type.Number()),
    message: Type.String(),
    requestedAction: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.Array(Type.Object({
      kind: Type.Union([Type.Literal("acceptance_criterion"), Type.Literal("invariant"), Type.Literal("failed_test"), Type.Literal("regression"), Type.Literal("api"), Type.Literal("security")]),
      reference: Type.String({ minLength: 1, maxLength: 500 }),
    }))),
  }))),
  coverage: Type.Optional(Type.Array(Type.String())),
  resolutions: Type.Optional(Type.Array(Type.Object({
    id: Type.String(),
    status: Type.Union([Type.Literal("fixed"), Type.Literal("open"), Type.Literal("invalidated")] ),
    note: Type.String({ minLength: 1, maxLength: 2000 }),
    evidence: Type.Array(Type.Object({
      kind: Type.Union([Type.Literal("acceptance_criterion"), Type.Literal("invariant"), Type.Literal("failed_test"), Type.Literal("regression"), Type.Literal("api"), Type.Literal("security")]),
      reference: Type.String({ minLength: 1, maxLength: 500 }),
    }), { minItems: 1, maxItems: 12 }),
    artifactPaths: Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { minItems: 1, maxItems: 64 }),
  }))),
  requiresSol: Type.Optional(Type.Boolean()),
});

export type RoleResult = {
  kind: string;
  summary: string;
  body: string;
  verdict?: ReviewVerdict;
  acceptanceCriteria?: string[];
  verificationCommands?: string[];
  findings?: Finding[];
  coverage?: string[];
  resolutions?: Array<{ id: string; status: "fixed" | "open" | "invalidated"; note: string; evidence: FindingEvidence[]; artifactPaths: string[] }>;
  requiresSol?: boolean;
};

const VALID_VERDICTS = new Set<ReviewVerdict>(["APPROVE", "CHANGES_REQUESTED", "BLOCKED"]);
const VALID_SEVERITIES = new Set<Finding["severity"]>(["critical", "high", "medium", "low", "info"]);
const VALID_EVIDENCE = new Set<FindingEvidence["kind"]>(["acceptance_criterion", "invariant", "failed_test", "regression", "api", "security"]);

function parseFindings(value: unknown): Finding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 80) throw new Error("Role findings are malformed or exceed the limit.");
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new Error(`Finding ${index + 1} is malformed.`);
    const item = raw as Record<string, unknown>;
    if (typeof item.key !== "string" || !item.key.trim() || item.key.length > 160) throw new Error(`Finding ${index + 1} has no stable semantic key.`);
    if (typeof item.severity !== "string" || !VALID_SEVERITIES.has(item.severity.toLowerCase() as Finding["severity"])) throw new Error(`Finding ${index + 1} has an invalid severity.`);
    if (typeof item.message !== "string" || !item.message.trim() || item.message.length > 2_000) throw new Error(`Finding ${index + 1} has no bounded message.`);
    if (item.file !== undefined && (typeof item.file !== "string" || item.file.length > 1_024)) throw new Error(`Finding ${index + 1} has an invalid file.`);
    if (item.line !== undefined && (!Number.isInteger(item.line) || (item.line as number) < 1)) throw new Error(`Finding ${index + 1} has an invalid line.`);
    if (item.requestedAction !== undefined && (typeof item.requestedAction !== "string" || item.requestedAction.length > 2_000)) throw new Error(`Finding ${index + 1} has an invalid requested action.`);
    const evidenceRaw = item.evidence;
    if (evidenceRaw !== undefined && (!Array.isArray(evidenceRaw) || evidenceRaw.length > 12)) throw new Error(`Finding ${index + 1} has invalid evidence.`);
    const evidence = (evidenceRaw ?? []).map((entry, evidenceIndex) => {
      if (!entry || typeof entry !== "object") throw new Error(`Finding ${index + 1} evidence ${evidenceIndex + 1} is malformed.`);
      const evidenceItem = entry as Record<string, unknown>;
      if (typeof evidenceItem.kind !== "string" || !VALID_EVIDENCE.has(evidenceItem.kind as FindingEvidence["kind"]) || typeof evidenceItem.reference !== "string" || !evidenceItem.reference.trim() || evidenceItem.reference.length > 500) {
        throw new Error(`Finding ${index + 1} evidence ${evidenceIndex + 1} is invalid.`);
      }
      return { kind: evidenceItem.kind as FindingEvidence["kind"], reference: evidenceItem.reference };
    });
    return {
      key: item.key.trim(),
      severity: item.severity.toLowerCase() as Finding["severity"],
      file: item.file as string | undefined,
      line: item.line as number | undefined,
      message: item.message,
      requestedAction: item.requestedAction as string | undefined,
      evidence,
    };
  });
}

export function parseRoleResult(value: unknown): RoleResult {
  if (!value || typeof value !== "object") throw new Error("Child returned no structured role result.");
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !raw.kind.trim() || raw.kind.length > 80) throw new Error("Role result has no valid kind.");
  if (typeof raw.summary !== "string" || !raw.summary.trim() || raw.summary.length > 2_000) throw new Error("Role result has no bounded summary.");
  if (typeof raw.body !== "string" || !raw.body.trim() || raw.body.length > 12_000) throw new Error("Role result has no bounded body.");
  const verdict = typeof raw.verdict === "string" && VALID_VERDICTS.has(raw.verdict as ReviewVerdict)
    ? raw.verdict as ReviewVerdict
    : undefined;
  const findings = parseFindings(raw.findings);
  return {
    kind: raw.kind.trim(),
    summary: raw.summary.trim(),
    body: raw.body.trim(),
    ...(verdict ? { verdict } : {}),
    acceptanceCriteria: Array.isArray(raw.acceptanceCriteria) ? raw.acceptanceCriteria.filter((value): value is string => typeof value === "string") : undefined,
    verificationCommands: Array.isArray(raw.verificationCommands) ? raw.verificationCommands.filter((value): value is string => typeof value === "string") : undefined,
    findings,
    coverage: Array.isArray(raw.coverage) && raw.coverage.length <= 2_000 ? raw.coverage.filter((value): value is string => typeof value === "string" && value.length <= 512) : undefined,
    resolutions: Array.isArray(raw.resolutions) && raw.resolutions.length <= 80
      ? raw.resolutions.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const item = value as { id?: unknown; status?: unknown; note?: unknown; evidence?: unknown; artifactPaths?: unknown };
        if (typeof item.id !== "string" || typeof item.note !== "string" || !item.note.trim() || item.note.length > 2_000 || !["fixed", "open", "invalidated"].includes(String(item.status)) || !Array.isArray(item.evidence) || item.evidence.length === 0 || item.evidence.length > 12 || !Array.isArray(item.artifactPaths) || item.artifactPaths.length === 0 || item.artifactPaths.length > 64) return [];
        const evidence = item.evidence.flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const candidate = entry as { kind?: unknown; reference?: unknown };
          if (typeof candidate.kind !== "string" || !VALID_EVIDENCE.has(candidate.kind as FindingEvidence["kind"]) || typeof candidate.reference !== "string" || !candidate.reference.trim() || candidate.reference.length > 500) return [];
          return [{ kind: candidate.kind as FindingEvidence["kind"], reference: candidate.reference }];
        });
        const artifactPaths = item.artifactPaths.filter((path): path is string => typeof path === "string" && path.length > 0 && path.length <= 1024);
        if (evidence.length !== item.evidence.length || artifactPaths.length !== item.artifactPaths.length) return [];
        return [{ id: item.id, status: item.status as "fixed" | "open" | "invalidated", note: item.note, evidence, artifactPaths }];
      })
      : undefined,
    requiresSol: raw.requiresSol === true,
  };
}
