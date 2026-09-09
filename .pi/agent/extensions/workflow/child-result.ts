import { resolve, relative, sep } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RoleResultSchema } from "./schemas.ts";

const ROOT = resolve(process.cwd());
const SECRET_SEGMENTS = /(^|\/)(?:\.env(?:\.|$)|auth\.json|credentials?|secrets?)(?:\/|$)/i;

function pathAllowed(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const raw = value.replace(/^@/, "");
  const target = resolve(ROOT, raw);
  const rel = relative(ROOT, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !SECRET_SEGMENTS.test(rel.replace(/\\/g, "/"));
}

/** Loaded only by isolated role children. It prevents tool expansion and emits one authoritative result. */
export default function childResult(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (event.toolName === "workflow_role_result") return;
    if (!["read", "grep", "find", "ls"].includes(event.toolName)) {
      return { block: true, reason: "Isolated specialist tool policy permits read/search only." };
    }
    const input = event.input as Record<string, unknown>;
    if ("path" in input && !pathAllowed(input.path)) {
      return { block: true, reason: "Specialists may read only non-secret paths inside the repository." };
    }
  });

  pi.registerTool({
    name: "workflow_role_result",
    label: "Workflow Role Result",
    description: "Return the mandatory structured specialist result as the final action.",
    parameters: RoleResultSchema,
    executionMode: "sequential",
    async execute(_id, params) {
      return {
        content: [{ type: "text", text: params.summary }],
        details: { result: params },
        terminate: true,
      };
    },
  });
}
