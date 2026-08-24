import { randomUUID } from "node:crypto";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { capturePathAfterShellChange, capturePathBeforeMutation, collectTaskDiff, createBaseline, gitStatusPaths, repositoryFingerprint, validateBaseline } from "./baseline.ts";
import { type OrchestratorConfig, loadConfig, splitModelRef } from "./config.ts";
import { activeToolsForStage, boundedText, commandFromToolResult, isAllowedTool, isBehaviorBearingPath, isForbiddenShell } from "./gates.ts";
import { chunkDiff, designPacket, envelopeHash, reviewPacket, reviewSynthesisPacket, testPlanPacket } from "./packets.ts";
import { LUNA_ORCHESTRATION_PROMPT } from "./prompts.ts";
import { type RoleJob, runRole } from "./runner.ts";
import type { RoleResult } from "./schemas.ts";
import { ORCH_STATE_TYPE, type OrchestratorState, type RoleArtifact, type RunState, type UsageTotals, addPath, emptyState, hash, invalidateApproval, isTerminal, newRun, restoreState, reviseTask, stateSummary, usageZero } from "./state.ts";
import { updateOrchestratorUi } from "./ui.ts";

const INTERNAL_PREFIX = "ORCH_INTERNAL:";
const MUTATING_FILE_TOOLS = new Set(["edit", "write"]);

interface PendingMutation {
  paths: Array<{ path: string; behavior: boolean }>;
}

interface PendingShell {
  beforeHash: string;
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
  return { role, kind: output.kind, summary: output.summary, body: output.body, hash: hash(output), usage, createdAt: now() };
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
    pi.setActiveTools(activeToolsForStage(Boolean(state.run?.terraPlan && !isTerminal(state.run.stage)), all));
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
    roleInFlight = true;
    roleAbort = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, roleAbort.signal]) : roleAbort.signal;
    try {
      const result = await runRole(pi, ctx.cwd, config, job, packet, signal);
      if (state.run?.id !== runId || state.run?.generation !== generation) {
        throw new Error("Discarded stale specialist result after session or task replacement.");
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
      run.verification.push({
        toolName: event.toolName,
        command: command.command,
        exitCode: command.exitCode,
        isError: event.isError,
        output: boundedText(event.content),
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
        version: 1,
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
      const diff = await collectTaskDiff(ctx.cwd, run.baseline, run.taskPaths);
      const review = reviewPacket(run, diff);
      if (!review.complete || !review.packet) {
        run.stage = "blocked";
        run.blockedReason = review.reason ?? "Terra cannot receive a complete review packet.";
        persist(ctx);
        throw new Error(run.blockedReason);
      }
      const envelope = envelopeHash(run, diff);
      run.lastEnvelopeHash = envelope;
      run.stage = "reviewing";
      persist(ctx);

      let result: RoleResult;
      let usage = usageZero();
      const chunks = chunkDiff(String(review.packet.diff ?? ""), config.maxReviewPacketBytes);
      if (chunks.length === 1) {
        const call = await runSpecialist(ctx, "terra_review", { ...review.packet, focus: params.focus?.trim() || undefined, envelopeHash: envelope });
        result = call.result;
        usage = call.usage;
      } else {
        const shardResults: Array<{ summary: string; body: string; findings: unknown }> = [];
        for (let index = 0; index < chunks.length; index++) {
          const call = await runSpecialist(ctx, "terra_review_shard", {
            ...review.packet,
            diff: chunks[index],
            shard: { index: index + 1, total: chunks.length },
            focus: params.focus?.trim() || undefined,
          });
          usage.input += call.usage.input; usage.output += call.usage.output; usage.cacheRead += call.usage.cacheRead; usage.cacheWrite += call.usage.cacheWrite; usage.cost += call.usage.cost;
          shardResults.push({ summary: call.result.summary, body: call.result.body, findings: call.result.findings ?? [] });
        }
        const synthesis = await runSpecialist(ctx, "terra_review_synthesis", reviewSynthesisPacket(run, review.artifactIds, shardResults));
        usage.input += synthesis.usage.input; usage.output += synthesis.usage.output; usage.cacheRead += synthesis.usage.cacheRead; usage.cacheWrite += synthesis.usage.cacheWrite; usage.cost += synthesis.usage.cost;
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
      const record = {
        pass: run.reviews.length + 1,
        verdict: result.verdict,
        summary: result.summary,
        findings: result.findings ?? [],
        envelopeHash: envelope,
        coverage,
        usage,
        createdAt: now(),
      };
      run.reviews.push(record);
      if (result.verdict === "APPROVE") {
        run.stage = "approved";
        run.approvalEnvelopeHash = envelope;
      } else if (result.verdict === "BLOCKED" || run.reviews.length >= config.maxReviews) {
        run.stage = "blocked";
        run.blockedReason = result.verdict === "BLOCKED" ? result.summary : `Terra review cap (${config.maxReviews}) reached without approval.`;
      } else {
        run.stage = "remediating";
      }
      if (result.requiresSol) run.needsSol = true;
      run.updatedAt = now();
      persist(ctx);
      return { content: [{ type: "text", text: `${result.verdict}: ${result.body}` }], details: { pass: record.pass, verdict: result.verdict, coverage }, usage: usageForPi(usage) };
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
        const envelope = envelopeHash(run, diff);
        if (run.stage !== "approved" || run.approvalEnvelopeHash !== envelope) {
          throw new Error("Terra has not approved the exact current task, design, plan, diff, and verification envelope.");
        }
      }
      run.stage = "finished";
      run.updatedAt = now();
      persist(ctx);
      return { content: [{ type: "text", text: params.summary?.trim() || "Orchestrated run finished with the required review evidence." }], details: { runId: run.id, behaviorMutation: run.behaviorMutation }, terminate: true };
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
    const run = currentRun(state);
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
      pendingShells.set(event.toolCallId, { beforeHash: await repositoryFingerprint(ctx.cwd) });
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
