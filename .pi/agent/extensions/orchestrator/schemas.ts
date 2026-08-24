import { Type } from "typebox";
import type { Finding, ReviewVerdict } from "./state.ts";

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
    severity: Type.Optional(Type.String()),
    file: Type.Optional(Type.String()),
    line: Type.Optional(Type.Number()),
    message: Type.String(),
    requestedAction: Type.Optional(Type.String()),
  }))),
  coverage: Type.Optional(Type.Array(Type.String())),
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
  requiresSol?: boolean;
};

const VALID_VERDICTS = new Set<ReviewVerdict>(["APPROVE", "CHANGES_REQUESTED", "BLOCKED"]);
const VALID_SEVERITIES = new Set<Finding["severity"]>(["critical", "high", "medium", "low", "info"]);

export function parseRoleResult(value: unknown): RoleResult {
  if (!value || typeof value !== "object") throw new Error("Child returned no structured role result.");
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !raw.kind.trim()) throw new Error("Role result has no kind.");
  if (typeof raw.summary !== "string" || !raw.summary.trim()) throw new Error("Role result has no summary.");
  if (typeof raw.body !== "string" || !raw.body.trim()) throw new Error("Role result has no body.");
  const verdict = typeof raw.verdict === "string" && VALID_VERDICTS.has(raw.verdict as ReviewVerdict)
    ? raw.verdict as ReviewVerdict
    : undefined;
  const findings = Array.isArray(raw.findings)
    ? raw.findings.filter((item): item is Finding => {
        if (!item || typeof item !== "object" || typeof (item as Record<string, unknown>).message !== "string") return false;
        const severity = String((item as Record<string, unknown>).severity ?? "medium").toLowerCase() as Finding["severity"];
        return VALID_SEVERITIES.has(severity);
      }).map((item) => ({
        severity: (String((item as Record<string, unknown>).severity ?? "medium").toLowerCase() as Finding["severity"]),
        file: typeof (item as Record<string, unknown>).file === "string" ? (item as Record<string, unknown>).file as string : undefined,
        line: typeof (item as Record<string, unknown>).line === "number" ? (item as Record<string, unknown>).line as number : undefined,
        message: (item as Record<string, unknown>).message as string,
        requestedAction: typeof (item as Record<string, unknown>).requestedAction === "string" ? (item as Record<string, unknown>).requestedAction as string : undefined,
      }))
    : [];
  return {
    kind: raw.kind.trim(),
    summary: raw.summary.trim(),
    body: raw.body.trim(),
    ...(verdict ? { verdict } : {}),
    acceptanceCriteria: Array.isArray(raw.acceptanceCriteria) ? raw.acceptanceCriteria.filter((value): value is string => typeof value === "string") : undefined,
    verificationCommands: Array.isArray(raw.verificationCommands) ? raw.verificationCommands.filter((value): value is string => typeof value === "string") : undefined,
    findings,
    coverage: Array.isArray(raw.coverage) ? raw.coverage.filter((value): value is string => typeof value === "string") : undefined,
    requiresSol: raw.requiresSol === true,
  };
}
