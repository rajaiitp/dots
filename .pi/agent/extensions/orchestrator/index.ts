import { randomUUID } from "node:crypto";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { capturePathAfterShellChange, capturePathBeforeMutation, collectSnapshotDiff, collectTaskDiff, createBaseline, createReviewSnapshot, gitStatusPaths, repositoryFingerprint, sameArtifactManifest, taskArtifactManifest, validateBaseline, validateReviewSnapshot } from "./baseline.ts";
import { type OrchestratorConfig, loadConfig, splitModelRef } from "./config.ts";
import { activeToolsForStage, boundedText, commandFromToolResult, isAllowedTool, isBehaviorBearingPath, isForbiddenShell } from "./gates.ts";
import { deltaReviewPacket, designPacket, envelopeHash, fullReviewPacket, packetBytes, reviewSynthesisPacket, shardFullReview, testPlanPacket } from "./packets.ts";
import { LUNA_ORCHESTRATION_PROMPT } from "./prompts.ts";
import { type RoleJob, runRole } from "./runner.ts";
import type { RoleResult } from "./schemas.ts";
import { ORCH_STATE_TYPE, type OrchestratorState, type ReviewRecord, type RoleArtifact, type RunState, type UsageTotals, addPath, emptyState, hash, invalidateApproval, isTerminal, newRun, restoreState, reviseTask, stateSummary, usageZero } from "./state.ts";
import { assignFindingIds, diffLineReferences, hasFreshVerification, mergeAdvisories, reviewChainHash, selectReviewScope, triageFindings } from "./review.ts";
import { updateOrchestratorUi } from "./ui.ts";

const INTERNAL_PREFIX = "ORCH_INTERNAL:";
const MUTATING_FILE_TOOLS = new Set(["edit", "write"]);

interface PendingMutation {
  paths: Array<{ path: string; behavior: boolean }>;
}

interface PendingShell {
  beforeHash: string;
  beforeArtifactManifestHash?: string;
}

function now(): number { return Date.now(); }

function usageForPi(value: UsageTotals): Usage {
  return {
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    totalTokens: value.input + value.output + value.cacheRead + value.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: value.cost },
  };
}

function roleArtifact(role: "sol" | "terra", output: RoleResult, usage: UsageTotals): RoleArtifact {
  return {
    role,
    kind: output.kind,
    summary: output.summary,
    body: output.body,
    acceptanceCriteria: role === "terra" && output.kind === "terra_test_plan"
      ? output.acceptanceCriteria?.map((criterion, index) => /^AC-\d+\s*:/.test(criterion) ? criterion : `AC-${index + 1}: ${criterion}`)
      : output.acceptanceCriteria,
    verificationCommands: output.verificationCommands,
    hash: hash(output),
    usage,
    createdAt: now(),
  };
}

function currentRun(state: OrchestratorState): RunState {
  if (!state.enabled || !state.run) throw new Error("Enable /orch and start a task first.");
  if (isTerminal(state.run.stage)) throw new Error("The current orchestrator run is terminal; send a new task to begin another run.");
  return state.run;
}

function expectedRoleModel(ctx: ExtensionContext, config: OrchestratorConfig, role: "luna" | "terra" | "sol"): Model<any> {
  const { provider, model } = splitModelRef(config.models[role]);
  const candidate = ctx.modelRegistry.find(provider, model);
  if (!candidate) throw new Error(`Required ${role} model ${provider}/${model} is unavailable.`);
  if (!candidate.reasoning) throw new Error(`Required ${role} model does not support reasoning.`);
  return candidate;
}

export default function orchestratorExtension(pi: ExtensionAPI) {
  let config = loadConfig(process.cwd());
  let state: OrchestratorState = emptyState();
  let internalModelChange = false;
  let roleInFlight = false;
  let roleAbort: AbortController | undefined;
  const pendingMutations = new Map<string, PendingMutation>();
  const pendingShells = new Map<string, PendingShell>();

  function persist(ctx?: ExtensionContext): void {
    state.updatedAt = now();
    pi.appendEntry(ORCH_STATE_TYPE, JSON.parse(JSON.stringify(state)));
    pi.events.emit("orch:state", stateSummary(state));
    if (ctx) updateOrchestratorUi(ctx, state);
  }

  function applyToolPolicy(ctx: ExtensionContext): void {
    if (!state.enabled) return;
    const all = pi.getAllTools().map((tool) => tool.name);
    const idleOrTerminal = !state.run || isTerminal(state.run.stage);
    pi.setActiveTools(activeToolsForStage(Boolean(state.run?.terraPlan && !idleOrTerminal), all, idleOrTerminal));
    updateOrchestratorUi(ctx, state);
  }

  async function enforceLuna(ctx: ExtensionContext): Promise<boolean> {
    if (!state.enabled) return true;
    const luna = expectedRoleModel(ctx, config, "luna");
    internalModelChange = true;
    try {
      if (ctx.model?.provider !== luna.provider || ctx.model.id !== luna.id) {
        const selected = await pi.setModel(luna);
        if (!selected) throw new Error("Luna authentication is unavailable.");
      }
      pi.setThinkingLevel(config.thinking);
      if (pi.getThinkingLevel() !== config.thinking) throw new Error("Luna could not be set to xhigh reasoning.");
      return true;
    } catch (error) {
      if (state.run) {
        state.run.stage = "blocked";
        state.run.blockedReason = error instanceof Error ? error.message : String(error);
      }
      persist(ctx);
      ctx.ui.notify(`Orchestrator blocked: ${state.run?.blockedReason ?? "Luna unavailable"}`, "error");
      return false;
    } finally {
      internalModelChange = false;
    }
  }

  async function startRun(task: string, ctx: ExtensionContext): Promise<RunState> {
    const runId = randomUUID();
    const baseline = await createBaseline(ctx.cwd, ctx.sessionManager.getSessionId(), runId);
    const repoHash = await repositoryFingerprint(ctx.cwd);
    state.run = newRun(task, baseline, repoHash, runId);
    applyToolPolicy(ctx);
    persist(ctx);
    return state.run;
  }

  async function prepareRunForPrompt(prompt: string, ctx: ExtensionContext): Promise<void> {
    if (!state.enabled || !prompt.trim() || prompt.startsWith(INTERNAL_PREFIX)) return;
    if (!state.run || isTerminal(state.run.stage)) {
      await startRun(prompt, ctx);
      return;
    }
    // A fresh user message is a task revision once planning or work has begun.
    reviseTask(state.run, prompt);
    applyToolPolicy(ctx);
    persist(ctx);
  }

  async function runSpecialist(ctx: ExtensionContext, job: RoleJob, packet: unknown) {
    if (roleInFlight) throw new Error("A specialist call is already in progress.");
    const runId = state.run?.id;
    const generation = state.run?.generation;
    const run = state.run;
    const beforeRepoHash = run ? await repositoryFingerprint(ctx.cwd) : undefined;
    const beforeManifest = run && run.taskPaths.length > 0 ? await taskArtifactManifest(ctx.cwd, run.taskPaths) : undefined;
    roleInFlight = true;
    roleAbort = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, roleAbort.signal]) : roleAbort.signal;
    try {
      const result = await runRole(pi, ctx.cwd, config, job, packet, signal);
      if (state.run?.id !== runId || state.run?.generation !== generation) {
        throw new Error("Discarded stale specialist result after session or task replacement.");
      }
      if (beforeRepoHash && state.run && await repositoryFingerprint(ctx.cwd) !== beforeRepoHash) {
        state.run.stage = "blocked";
        state.run.blockedReason = "Repository changed while an isolated specialist was running.";
        persist(ctx);
        throw new Error(state.run.blockedReason);
      }
      if (beforeManifest && state.run) {
        const afterManifest = await taskArtifactManifest(ctx.cwd, state.run.taskPaths);
        if (!sameArtifactManifest(beforeManifest, afterManifest)) {
          state.run.stage = "blocked";
          state.run.blockedReason = "Task artifacts changed while an isolated specialist was running.";
          persist(ctx);
          throw new Error(state.run.blockedReason);
        }
      }
      return result;
    } finally {
      roleInFlight = false;
      roleAbort = undefined;
    }
  }

  async function recordMutationResult(event: ToolResultEvent, ctx: ExtensionContext): Promise<void> {
    const run = state.run;
    if (!run) return;
    const pending = pendingMutations.get(event.toolCallId);
    if (pending) {
      pendingMutations.delete(event.toolCallId);
      if (!event.isError) {
        for (const item of pending.paths) {
          if (item.behavior) {
            addPath(run.taskPaths, item.path);
            run.behaviorMutation = true;
          } else {
            addPath(run.docsOnlyPaths, item.path);
          }
        }
        invalidateApproval(run);
        run.stage = run.behaviorMutation ? "implementing" : run.stage;
      }
    }

    const command = commandFromToolResult(event);
    const shell = pendingShells.get(event.toolCallId);
    if (command && shell) {
      pendingShells.delete(event.toolCallId);
      const afterHash = await repositoryFingerprint(ctx.cwd);
      const paths = await gitStatusPaths(ctx.cwd);
      for (const path of paths) {
        try {
          const captured = await capturePathAfterShellChange(ctx.cwd, run.baseline, path);
          addPath(run.taskPaths, captured);
        } catch {
          if (!run.unscopedChanges.includes(path)) run.unscopedChanges.push(path);
        }
      }
      run.behaviorMutation = run.behaviorMutation || paths.length > 0;
      const output = boundedText(event.content);
      let artifactManifestHash: string | undefined;
      try {
        artifactManifestHash = (await taskArtifactManifest(ctx.cwd, run.taskPaths)).hash;
      } catch {
        // A later review will fail closed when its current manifest cannot be read.
      }
      run.verification.push({
        toolName: event.toolName,
        command: command.command,
        exitCode: command.exitCode,
        isError: event.isError,
        output,
        outputHash: hash(output),
        truncated: output.includes("[output truncated by orchestrator]"),
        beforeArtifactManifestHash: shell.beforeArtifactManifestHash,
        artifactManifestHash,
        beforeRepoHash: shell.beforeHash,
        afterRepoHash: afterHash,
        createdAt: now(),
      });
      run.lastRepoHash = afterHash;
      invalidateApproval(run);
      run.stage = "verifying";
    } else if (pending && !event.isError) {
      run.lastRepoHash = await repositoryFingerprint(ctx.cwd);
    }
    run.updatedAt = now();
    persist(ctx);
  }

  async function enable(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the current agent turn to settle before enabling /orch.", "warning");
      return;
    }
    config = loadConfig(ctx.cwd);
    try {
      const luna = expectedRoleModel(ctx, config, "luna");
      expectedRoleModel(ctx, config, "terra");
      expectedRoleModel(ctx, config, "sol");
      state = {
        ...emptyState(),
        enabled: true,
        prior: {
          provider: ctx.model?.provider,
          model: ctx.model?.id,
          thinking: pi.getThinkingLevel(),
          tools: pi.getActiveTools(),
        },
        updatedAt: now(),
      };
      internalModelChange = true;
      const selected = await pi.setModel(luna);
      pi.setThinkingLevel(config.thinking);
      internalModelChange = false;
      if (!selected || pi.getThinkingLevel() !== config.thinking) throw new Error("Could not activate Luna at xhigh.");
      applyToolPolicy(ctx);
      persist(ctx);
      ctx.ui.notify("Orchestrator enabled: Luna xhigh owns implementation; Terra and Sol are isolated specialists.", "info");
    } catch (error) {
      internalModelChange = false;
      state = emptyState();
      ctx.ui.notify(`Could not enable orchestrator: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  async function disable(ctx: ExtensionCommandContext): Promise<void> {
    if (!state.enabled) return;
    if (!ctx.isIdle() || roleInFlight) {
      ctx.ui.notify("Wait for Luna and any specialist call to settle before disabling /orch.", "warning");
      return;
    }
    if (state.run && !isTerminal(state.run.stage) && (state.run.behaviorMutation || state.run.terraPlan)) {
      ctx.ui.notify("This run has gated work in progress. Call orch_finish or report it blocked before disabling.", "warning");
      return;
    }
    const prior = state.prior;
    state = emptyState();
    if (prior?.provider && prior.model) {
      const model = ctx.modelRegistry.find(prior.provider, prior.model);
      if (model) {
        internalModelChange = true;
        await pi.setModel(model);
        internalModelChange = false;
      }
    }
    if (prior?.thinking) pi.setThinkingLevel(prior.thinking as never);
    if (prior?.tools?.length) pi.setActiveTools(prior.tools);
    persist(ctx);
    ctx.ui.notify("Orchestrator disabled and prior session settings restored.", "info");
  }

  pi.registerFlag("orch", { description: "Enable Luna/Terra/Sol orchestrator mode", type: "boolean", default: false });
  pi.registerCommand("orch", {
    description: "Enable, disable, or inspect automatic Luna/Terra/Sol orchestration",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (!command || command === "on") return enable(ctx);
      if (command === "off") return disable(ctx);
      if (command === "status") {
        ctx.ui.notify(JSON.stringify(stateSummary(state), null, 2), state.run?.stage === "blocked" ? "error" : "info");
        return;
      }
      ctx.ui.notify("Usage: /orch [on|off|status]", "warning");
    },
  });

  pi.registerTool({
    name: "orch_sol_design",
    label: "Sol Design",
    description: "Consult Sol xhigh for an architecture or complex-problem design before implementation.",
    parameters: Type.Object({ question: Type.Optional(Type.String()), escalation: Type.Optional(Type.Boolean()) }),
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      void signal;
      const run = currentRun(state);
      if (run.solDesign && !params.escalation) {
        return { content: [{ type: "text", text: run.solDesign.body }], details: { reused: true }, usage: run.solDesign.usage ? usageForPi(run.solDesign.usage) : undefined };
      }
      if (run.solConsults >= config.maxSolConsults) throw new Error(`Sol consultation limit (${config.maxSolConsults}) reached.`);
      run.stage = "designing";
      persist(ctx);
      const call = await runSpecialist(ctx, "sol_design", designPacket(run, params.question));
      const replacesExistingPlan = Boolean(run.terraPlan);
      run.solConsults += 1;
      run.solDesign = roleArtifact("sol", call.result, call.usage);
      if (replacesExistingPlan) {
        // A late architectural decision changes the test assumptions. Force a
        // fresh Terra plan and discard approvals rather than reusing stale work.
        run.terraPlan = undefined;
        // Preserve review history: the three-pass cap is per run, not per plan.
        run.approvalEnvelopeHash = undefined;
        applyToolPolicy(ctx);
      }
      run.stage = "intake";
      run.updatedAt = now();
      persist(ctx);
      return { content: [{ type: "text", text: call.result.body }], details: { role: "sol", attempts: call.attempts }, usage: usageForPi(call.usage) };
    },
  });

  pi.registerTool({
    name: "orch_terra_test_plan",
    label: "Terra Test Plan",
    description: "Require Terra xhigh to produce a test plan before behavior-bearing mutation.",
    parameters: Type.Object({ focus: Type.Optional(Type.String()) }),
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      void signal;
      const run = currentRun(state);
      if (run.needsSol && !run.solDesign) throw new Error("This task requires Sol design before Terra can plan tests.");
      run.stage = "test_planning";
      persist(ctx);
      const packet = { ...testPlanPacket(run), focus: params.focus?.trim() || undefined };
      const call = await runSpecialist(ctx, "terra_test_plan", packet);
      run.terraPlan = roleArtifact("terra", call.result, call.usage);
      run.stage = "implementing";
      run.updatedAt = now();
      applyToolPolicy(ctx);
      persist(ctx);
      return { content: [{ type: "text", text: call.result.body }], details: { role: "terra", kind: "test_plan", attempts: call.attempts }, usage: usageForPi(call.usage) };
    },
  });

  pi.registerTool({
    name: "orch_terra_review",
    label: "Terra Review",
    description: "Have Terra xhigh review Luna's final task-local diff and verification evidence.",
    parameters: Type.Object({ focus: Type.Optional(Type.String()) }),
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      void signal;
      const run = currentRun(state);
      if (!run.behaviorMutation) throw new Error("No behavior-bearing Luna mutation requires Terra review.");
      if (!run.terraPlan) throw new Error("Terra test planning is required before review.");
      if (run.needsSol && !run.solDesign) throw new Error("A required Sol design is missing.");
      if (run.reviews.length >= config.maxReviews) {
        run.stage = "blocked";
        run.blockedReason = `Terra review cap (${config.maxReviews}) reached without approval.`;
        persist(ctx);
        throw new Error(run.blockedReason);
      }
      const baseline = await validateBaseline(ctx.cwd, run.baseline);
      if (!baseline.ok) throw new Error(baseline.reason);
      const repoHash = await repositoryFingerprint(ctx.cwd);
      if (repoHash !== run.lastRepoHash) {
        run.unscopedChanges.push("Repository changed outside an observed Luna tool call.");
        run.stage = "blocked";
        run.blockedReason = "Unscoped repository changes prevent safe review.";
        persist(ctx);
        throw new Error(run.blockedReason);
      }
      const fullDiff = await collectTaskDiff(ctx.cwd, run.baseline, run.taskPaths);
      const manifest = await taskArtifactManifest(ctx.cwd, run.taskPaths);
      if (manifest.entries.some((entry) => entry.kind === "symlink" || entry.kind === "other")) {
        run.stage = "blocked";
        run.blockedReason = "Terra review requires readable regular artifacts or deletion tombstones; symlink and special-file changes are blocked.";
        persist(ctx);
        throw new Error(run.blockedReason);
      }
      if (!hasFreshVerification(run, manifest.hash)) {
        run.stage = "blocked";
        run.blockedReason = "Terra review requires fresh successful verification for the exact current task artifacts.";
        persist(ctx);
        throw new Error(run.blockedReason);
      }

      const focus = params.focus?.trim() || undefined;
      if (focus && Buffer.byteLength(focus, "utf8") > 2_000) throw new Error("Terra review focus exceeds the 2,000-byte packet budget.");
      const selection = selectReviewScope(run, manifest, config.enableDeltaReviews);
      let scope = selection.scope;
      let fallbackReason = selection.fallbackReason;
      let review = fullReviewPacket(run, fullDiff, manifest);
      if (scope === "delta" && selection.base) {
        const delta = await collectSnapshotDiff(ctx.cwd, selection.base.snapshot!);
        const candidate = deltaReviewPacket(run, delta, manifest, selection.base);
        const findingPaths = new Set(selection.base.findings.map((finding) => finding.file).filter((path): path is string => Boolean(path)));
        const changedPaths = candidate.artifactIds.map((id) => id.replace(/^diff:/, ""));
        // A no-op or unrelated change cannot substantiate a claimed remediation.
        if (!candidate.complete || !candidate.packet || changedPaths.length === 0 || changedPaths.some((path) => !findingPaths.has(path))) {
          scope = "full";
          fallbackReason = candidate.reason ?? "remediation delta is empty or outside prior Terra findings";
        } else {
          review = candidate;
        }
      }
      if (!review.complete || !review.packet) {
        run.stage = "blocked";
        run.blockedReason = review.reason ?? "Terra cannot receive a complete review packet.";
        persist(ctx);
        throw new Error(run.blockedReason);
      }

      const envelope = envelopeHash(run, fullDiff, manifest);
      run.lastEnvelopeHash = envelope;
      run.stage = "reviewing";
      persist(ctx);

      const packetLimit = Math.min(config.maxPacketBytes, config.maxReviewPacketBytes);
      const reviewPayload = (packet: Record<string, unknown>): Record<string, unknown> => ({ ...packet, ...(focus ? { focus } : {}), envelopeHash: envelope });
      const shardLimit = packetLimit - packetBytes({ ...(focus ? { focus } : {}), envelopeHash: envelope }) - 128;
      if (shardLimit < 1_024) throw new Error("Terra review metadata leaves no safe space for a diff shard.");
      const addUsage = (target: UsageTotals, extra: UsageTotals): void => {
        target.input += extra.input; target.output += extra.output; target.cacheRead += extra.cacheRead; target.cacheWrite += extra.cacheWrite; target.cost += extra.cost;
      };
      let result: RoleResult;
      let transport: "single" | "sharded" = "single";
      let packetSize = packetBytes(reviewPayload(review.packet));
      const usage = usageZero();
      if (packetSize <= packetLimit) {
        const call = await runSpecialist(ctx, scope === "delta" ? "terra_delta_review" : "terra_review", reviewPayload(review.packet));
        result = call.result;
        addUsage(usage, call.usage);
      } else {
        // Delta packets must stay compact; full review can use lossless shard transport.
        if (scope === "delta") {
          scope = "full";
          fallbackReason = "remediation packet exceeded the compact review limit";
          review = fullReviewPacket(run, fullDiff, manifest);
          if (!review.complete || !review.packet) throw new Error(review.reason ?? "Could not build full-review fallback.");
        }
        transport = "sharded";
        const shards = shardFullReview(review.packet, shardLimit);
        if (shards.length === 0) throw new Error("Full review produced no reviewable shards.");
        packetSize = 0;
        const shardResults: Array<{ id: string; artifactIds: string[]; summary: string; findings: unknown; coverage: string[] }> = [];
        for (const shard of shards) {
          const shardPayload = reviewPayload(shard.packet);
          if (packetBytes(shardPayload) > packetLimit) throw new Error(`Terra shard ${shard.id} exceeds the specialist packet limit after metadata.`);
          packetSize += packetBytes(shardPayload);
          const call = await runSpecialist(ctx, "terra_review_shard", shardPayload);
          addUsage(usage, call.usage);
          const coverage = call.result.coverage ?? [];
          if (!shard.artifactIds.every((id) => coverage.includes(id))) throw new Error(`Terra shard ${shard.id} did not confirm its complete artifact coverage.`);
          shardResults.push({ id: shard.id, artifactIds: shard.artifactIds, summary: call.result.summary, findings: call.result.findings ?? [], coverage });
        }
        const synthesisPacket = reviewPayload(reviewSynthesisPacket(run, manifest, review.artifactIds, shardResults));
        if (packetBytes(synthesisPacket) > packetLimit) throw new Error("Terra review synthesis exceeds the specialist packet limit.");
        packetSize += packetBytes(synthesisPacket);
        const synthesis = await runSpecialist(ctx, "terra_review_synthesis", synthesisPacket);
        addUsage(usage, synthesis.usage);
        result = synthesis.result;
      }
      if (!result.verdict) throw new Error("Terra review returned no valid verdict.");
      const coverage = result.coverage ?? [];
      if (!review.artifactIds.every((id) => coverage.includes(id))) {
        run.stage = "blocked";
        run.blockedReason = "Terra did not confirm complete artifact coverage.";
        persist(ctx);
        throw new Error(run.blockedReason);
      }
      const afterManifest = await taskArtifactManifest(ctx.cwd, run.taskPaths);
      if (!sameArtifactManifest(manifest, afterManifest)) {
        run.stage = "blocked";
        run.blockedReason = "Task artifacts changed while Terra was reviewing; the verdict is stale.";
        persist(ctx);
        throw new Error(run.blockedReason);
      }
      const priorFindings = selection.base?.activeFindings ?? selection.base?.findings ?? [];
      if (scope === "delta" && selection.base) {
        const previousIds = new Set(priorFindings.map((finding) => finding.id).filter(Boolean));
        const priorById = new Map(priorFindings.filter((finding): finding is typeof finding & { id: string } => Boolean(finding.id)).map((finding) => [finding.id, finding]));
        const resolutions = result.resolutions ?? [];
        const resolvedIds = new Set(resolutions.map((resolution) => resolution.id));
        const changedPaths = new Set(review.artifactIds.map((id) => id.replace(/^diff:/, "")));
        const scopedDiffReferences = diffLineReferences(String(review.packet?.diff ?? ""));
        const concreteResolutionEvidence = (resolution: NonNullable<RoleResult["resolutions"]>[number]): boolean => resolution.evidence.some((evidence) => {
          if (evidence.kind === "acceptance_criterion") return (run.terraPlan?.acceptanceCriteria ?? []).some((criterion) => criterion.startsWith(`${evidence.reference}:`) || criterion === evidence.reference);
          if (evidence.kind === "invariant") return Boolean(run.solDesign?.body.includes(evidence.reference));
          if (evidence.kind === "failed_test") return run.verification.some((entry) => (entry.isError || entry.exitCode !== 0) && entry.beforeArtifactManifestHash === manifest.hash && entry.artifactManifestHash === manifest.hash && entry.output.includes(evidence.reference));
          return scopedDiffReferences.has(evidence.reference);
        });
        if (![...previousIds].every((id) => resolvedIds.has(id)) || [...resolvedIds].some((id) => !previousIds.has(id)) || resolutions.some((resolution) => {
          const prior = priorById.get(resolution.id);
          return !prior || !resolution.note.trim() || resolution.evidence.length === 0 || !concreteResolutionEvidence(resolution) || resolution.artifactPaths.some((path) => !changedPaths.has(path)) || (prior.file !== undefined && !resolution.artifactPaths.includes(prior.file));
        })) {
          run.stage = "blocked";
          run.blockedReason = "Delta review did not resolve every prior Terra blocker.";
          persist(ctx);
          throw new Error(run.blockedReason);
        }
      }
      const previous = run.reviews.at(-1);
      const pass = run.reviews.length + 1;
      const triage = triageFindings(assignFindingIds(pass, result.findings ?? []), {
        acceptanceCriteria: run.terraPlan?.acceptanceCriteria ?? [],
        solDesign: run.solDesign?.body,
        artifactPaths: manifest.entries.map((entry) => entry.path),
        diffReferences: diffLineReferences(String(review.packet?.diff ?? "")),
        failedTestOutput: run.verification
          .filter((evidence) => (evidence.isError || evidence.exitCode !== 0) && evidence.beforeArtifactManifestHash === manifest.hash && evidence.artifactManifestHash === manifest.hash)
          .map((evidence) => evidence.output),
      });
      const openPrior = scope === "delta"
        ? priorFindings.filter((finding) => result.resolutions?.some((resolution) => resolution.id === finding.id && resolution.status === "open"))
        : [];
      const activeById = new Map<string, typeof triage.blockers[number]>();
      for (const finding of [...openPrior, ...triage.blockers]) if (finding.id) activeById.set(finding.id, finding);
      // Invalidating a prior blocker is rare and cannot be safely accepted from a
      // delta alone. Carry a synthetic blocker that forces the next pass full.
      if (scope === "delta" && result.resolutions?.some((resolution) => resolution.status === "invalidated")) {
        const revalidation = assignFindingIds(pass, [{
          key: "revalidate-invalidated-terra-finding",
          severity: "high",
          message: "Terra invalidated a prior blocker; a complete review is required before approval.",
          requestedAction: "Run a complete Terra review of the current task artifacts.",
          evidence: [{ kind: "invariant", reference: "full-review-required" }],
        }])[0];
        activeById.set(revalidation.id, revalidation);
      }
      const activeFindings = [...activeById.values()].sort((left, right) => String(left.id).localeCompare(String(right.id)));
      const verdict = result.verdict === "BLOCKED" ? "BLOCKED" : activeFindings.length > 0 ? "CHANGES_REQUESTED" : "APPROVE";
      const advisories = mergeAdvisories(run.advisories, triage.advisories, activeFindings);
      run.advisories = advisories;
      const snapshot = await createReviewSnapshot(ctx.cwd, run.baseline, manifest, `pass-${pass}`);
      const record: ReviewRecord = {
        pass,
        verdict,
        summary: result.summary,
        findings: triage.blockers,
        activeFindings,
        advisories: triage.advisories,
        resolutions: result.resolutions,
        envelopeHash: envelope,
        coverage,
        scope,
        transport,
        fallbackReason,
        baseEnvelopeHash: scope === "delta" ? selection.base?.envelopeHash : undefined,
        snapshot,
        taskRevision: run.taskRevision,
        solDesignHash: run.solDesign?.hash,
        terraPlanHash: run.terraPlan?.hash,
        packetBytes: packetSize,
        usage,
        createdAt: now(),
      };
      record.chainHash = reviewChainHash(previous, record);
      run.reviews.push(record);
      if (verdict === "APPROVE") {
        run.stage = "approved";
        run.approvalEnvelopeHash = envelope;
        run.approvalChainHash = record.chainHash;
      } else if (verdict === "BLOCKED" || run.reviews.length >= config.maxReviews) {
        run.stage = "blocked";
        run.blockedReason = verdict === "BLOCKED" ? result.summary : `Terra review cap (${config.maxReviews}) reached without approval.`;
      } else {
        run.stage = "remediating";
      }
      if (result.requiresSol) run.needsSol = true;
      run.updatedAt = now();
      persist(ctx);
      return { content: [{ type: "text", text: `${verdict}: ${result.body}` }], details: { pass: record.pass, verdict, coverage, scope, transport, fallbackReason, blockers: activeFindings.length, advisories: triage.advisories.length, packetBytes: packetSize }, usage: usageForPi(usage) };
    },
  });

  pi.registerTool({
    name: "orch_finish",
    label: "Finish Orchestrated Run",
    description: "Validate the final Terra approval envelope and terminate a successful orchestrated run.",
    parameters: Type.Object({ summary: Type.Optional(Type.String()) }),
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      void signal;
      const run = state.enabled ? state.run : undefined;
      if (!run) throw new Error("Enable /orch and start a task first.");
      if (run.stage === "blocked") {
        return {
          content: [{ type: "text", text: `Orchestrated run is blocked: ${run.blockedReason ?? "No reason recorded."}` }],
          details: { runId: run.id, blocked: true },
          terminate: true,
        };
      }
      if (run.stage === "finished") throw new Error("This orchestrated run is already finished.");
      const baseline = await validateBaseline(ctx.cwd, run.baseline);
      if (!baseline.ok) throw new Error(baseline.reason);
      const currentHash = await repositoryFingerprint(ctx.cwd);
      if (currentHash !== run.lastRepoHash) throw new Error("Repository changed after the last observed Luna tool result; approval is stale.");
      if (run.behaviorMutation) {
        if (!run.terraPlan) throw new Error("Missing Terra test plan.");
        if (run.verification.length === 0) throw new Error("No observed Luna verification command was recorded.");
        if (run.needsSol && !run.solDesign) throw new Error("Missing required Sol design.");
        if (run.unscopedChanges.length) throw new Error("Unscoped changes prevent safe finish.");
        const diff = await collectTaskDiff(ctx.cwd, run.baseline, run.taskPaths);
        if (!diff.complete) throw new Error(diff.reason);
        const manifest = await taskArtifactManifest(ctx.cwd, run.taskPaths);
        if (!hasFreshVerification(run, manifest.hash)) throw new Error("Verification is stale for the current task artifacts.");
        const approval = run.reviews.at(-1);
        if (!approval?.snapshot || !(await validateReviewSnapshot(approval.snapshot)).ok) throw new Error("The final Terra review snapshot is missing or corrupt.");
        if (!sameArtifactManifest(approval.snapshot.manifest, manifest)) throw new Error("Task artifacts changed after Terra approval.");
        const envelope = envelopeHash(run, diff, manifest);
        if (run.stage !== "approved" || run.approvalEnvelopeHash !== envelope || !run.approvalChainHash) {
          throw new Error("Terra has not approved the exact current task, design, plan, diff, and verification envelope.");
        }
      }
      run.stage = "finished";
      run.updatedAt = now();
      persist(ctx);
      const advisorySummary = run.advisories.length
        ? `\n\nAdvisories (non-blocking):\n${run.advisories.slice(0, 20).map((finding) => `- [${finding.severity}] ${finding.message}`).join("\n")}${run.advisories.length > 20 ? "\n- [more advisories omitted]" : ""}`
        : "";
      return { content: [{ type: "text", text: `${params.summary?.trim() || "Orchestrated run finished with the required review evidence."}${advisorySummary}` }], details: { runId: run.id, behaviorMutation: run.behaviorMutation, advisories: run.advisories.length }, terminate: true };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd);
    state = restoreState(ctx.sessionManager.getBranch());
    if (pi.getFlag("orch") === true && !state.enabled) {
      // Flag startup has no command context, but session is idle by definition.
      const fake = ctx as ExtensionCommandContext;
      await enable(fake);
      return;
    }
    if (!state.enabled) return;
    if (state.run && !isTerminal(state.run.stage)) {
      const baseline = await validateBaseline(ctx.cwd, state.run.baseline);
      const repo = await repositoryFingerprint(ctx.cwd);
      if (!baseline.ok) {
        state.run.stage = "blocked";
        state.run.blockedReason = baseline.reason;
      } else if (repo !== state.run.lastRepoHash) {
        state.run.unscopedChanges.push("Repository changed while the session was inactive.");
        state.run.stage = "blocked";
        state.run.blockedReason = "Repository changed outside observed Luna work while this session was inactive.";
      }
    }
    applyToolPolicy(ctx);
    await enforceLuna(ctx);
    persist(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    state = restoreState(ctx.sessionManager.getBranch());
    config = loadConfig(ctx.cwd);
    if (!state.enabled) return;
    applyToolPolicy(ctx);
    await enforceLuna(ctx);
    persist(ctx);
  });

  pi.on("session_shutdown", () => {
    roleAbort?.abort(new Error("Parent session shutting down."));
    if (state.run && !isTerminal(state.run.stage)) state.run.generation += 1;
  });

  pi.on("model_select", async (_event, ctx) => {
    if (state.enabled && !internalModelChange) await enforceLuna(ctx);
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    if (state.enabled && !internalModelChange) await enforceLuna(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await prepareRunForPrompt(event.prompt, ctx);
    if (!state.enabled) return;
    await enforceLuna(ctx);
    return { systemPrompt: `${event.systemPrompt}\n\n${LUNA_ORCHESTRATION_PROMPT}` };
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    if (!state.enabled) return;
    const run = state.run;
    if (!run || isTerminal(run.stage)) {
      return { block: true, reason: "No active orchestrator run can accept specialist or mutation work. Send a new task first." };
    }
    const hasPlan = Boolean(run.terraPlan);
    if (!isAllowedTool(event.toolName, hasPlan)) {
      return { block: true, reason: `Orchestrator tool policy blocks ${event.toolName} at stage ${run.stage}.` };
    }
    if (MUTATING_FILE_TOOLS.has(event.toolName)) {
      const input = event.input as Record<string, unknown>;
      if (typeof input.path !== "string") return { block: true, reason: "Mutation tool has no valid path." };
      const behavior = isBehaviorBearingPath(input.path);
      if (behavior && !hasPlan) return { block: true, reason: "Terra test planning is required before behavior-bearing mutation." };
      try {
        const path = await capturePathBeforeMutation(ctx.cwd, run.baseline, input.path);
        pendingMutations.set(event.toolCallId, { paths: [{ path, behavior }] });
      } catch (error) {
        return { block: true, reason: `Could not safely capture task baseline: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    if (event.toolName === "bash" || event.toolName === "hypa_shell") {
      if (!hasPlan) return { block: true, reason: "Shell execution is disabled until Terra has written the test plan." };
      const command = String((event.input as Record<string, unknown>).command ?? "");
      const forbidden = isForbiddenShell(command);
      if (forbidden) return { block: true, reason: forbidden };
      let beforeArtifactManifestHash: string | undefined;
      if (run.taskPaths.length > 0) {
        try {
          beforeArtifactManifestHash = (await taskArtifactManifest(ctx.cwd, run.taskPaths)).hash;
        } catch (error) {
          return { block: true, reason: `Could not capture pre-command task manifest: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
      pendingShells.set(event.toolCallId, { beforeHash: await repositoryFingerprint(ctx.cwd), beforeArtifactManifestHash });
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (state.enabled) await recordMutationResult(event, ctx);
  });

  pi.on("user_bash", () => {
    if (!state.enabled) return;
    return {
      result: {
        output: "Manual ! shell commands are disabled during /orch because they bypass Luna-only change attribution.",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const run = state.run;
    if (!state.enabled || !run || isTerminal(run.stage) || roleInFlight) return;
    if (!run.terraPlan && !run.behaviorMutation) return;
    if (run.nudgeCount === 0) {
      run.nudgeCount = 1;
      persist(ctx);
      pi.sendUserMessage(`${INTERNAL_PREFIX} Continue the required orchestrator workflow. Use the next required role tool or call orch_finish; do not end with an unverified claim.`, { deliverAs: "followUp" });
      return;
    }
    run.stage = "blocked";
    run.blockedReason = "Luna did not call orch_finish after the bounded orchestration reminder.";
    persist(ctx);
    ctx.ui.notify(run.blockedReason, "error");
  });
}
