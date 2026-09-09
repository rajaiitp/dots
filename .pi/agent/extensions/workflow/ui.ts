import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowState } from "./state.ts";

export function updateWorkflowUi(ctx: ExtensionContext, state: WorkflowState): void {
  if (!state.enabled) {
    ctx.ui.setStatus("workflow", undefined);
    ctx.ui.setWidget("workflow", undefined);
    return;
  }
  const run = state.run;
  const review = run?.reviews.at(-1);
  const status = [
    "workflow:Luna/xhigh",
    run ? `· ${run.stage}` : "· ready",
    run ? `· Terra ${run.reviews.length}/3` : "",
    run?.solConsults ? `· Sol ${run.solConsults}` : "",
    review ? `· ${review.scope ?? "full"}/${review.transport ?? "single"}` : "",
    review ? `· ${review.verdict}` : "",
    run?.advisories.length ? `· ${run.advisories.length} advisory` : "",
  ].filter(Boolean).join(" ");
  ctx.ui.setStatus("workflow", ctx.ui.theme.fg(run?.stage === "blocked" ? "error" : "accent", status));
  if (run && run.stage !== "finished") {
    const lines = [
      `${ctx.ui.theme.bold("Workflow")} ${ctx.ui.theme.fg("accent", "Luna xhigh")}`,
      `Stage: ${run.stage} · Terra reviews: ${run.reviews.length} · Sol: ${run.solConsults} · Advisories: ${run.advisories.length}`,
      review ? `Latest review: ${review.scope ?? "full"}/${review.transport ?? "single"} · ${review.packetBytes ?? 0} bytes · ${review.usage?.input ?? 0}/${review.usage?.output ?? 0} tokens${review.fallbackReason ? ` · fallback: ${review.fallbackReason}` : ""}` : "Review: pending full-scope Terra review",
      ...(run.blockedReason ? [ctx.ui.theme.fg("error", `Blocked: ${run.blockedReason}`)] : []),
    ];
    ctx.ui.setWidget("workflow", lines);
  } else {
    ctx.ui.setWidget("workflow", undefined);
  }
}
