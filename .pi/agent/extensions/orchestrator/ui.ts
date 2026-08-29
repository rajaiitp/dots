import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OrchestratorState } from "./state.ts";

export function updateOrchestratorUi(ctx: ExtensionContext, state: OrchestratorState): void {
  if (!state.enabled) {
    ctx.ui.setStatus("orchestrator", undefined);
    ctx.ui.setWidget("orchestrator", undefined);
    return;
  }
  const run = state.run;
  const review = run?.reviews.at(-1);
  const status = [
    "orch:Luna/xhigh",
    run ? `· ${run.stage}` : "· ready",
    run ? `· Terra ${run.reviews.length}/3` : "",
    run?.solConsults ? `· Sol ${run.solConsults}` : "",
    review ? `· ${review.scope ?? "full"}/${review.transport ?? "single"}` : "",
    review ? `· ${review.verdict}` : "",
    run?.advisories.length ? `· ${run.advisories.length} advisory` : "",
  ].filter(Boolean).join(" ");
  ctx.ui.setStatus("orchestrator", ctx.ui.theme.fg(run?.stage === "blocked" ? "error" : "accent", status));
  if (run && run.stage !== "finished") {
    const lines = [
      `${ctx.ui.theme.bold("Orchestrator")} ${ctx.ui.theme.fg("accent", "Luna xhigh")}`,
      `Stage: ${run.stage} · Terra reviews: ${run.reviews.length}/3 · Sol: ${run.solConsults}/2 · Advisories: ${run.advisories.length}`,
      review ? `Latest review: ${review.scope ?? "full"}/${review.transport ?? "single"} · ${review.packetBytes ?? 0} bytes · ${review.usage?.input ?? 0}/${review.usage?.output ?? 0} tokens${review.fallbackReason ? ` · fallback: ${review.fallbackReason}` : ""}` : "Review: pending full-scope Terra review",
      run.blockedReason ? ctx.ui.theme.fg("error", `Blocked: ${run.blockedReason}`) : `Task: ${run.task.slice(0, 140)}`,
    ];
    ctx.ui.setWidget("orchestrator", lines);
  } else {
    ctx.ui.setWidget("orchestrator", undefined);
  }
}
