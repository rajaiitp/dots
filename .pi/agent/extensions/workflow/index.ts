import { randomUUID } from "node:crypto";
import { lstat, realpath, rename, unlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { capturePathAfterShellChange, capturePathBeforeMutation, collectSnapshotDiff, collectTaskDiff, createBaseline, createReviewSnapshot, gitStatusPaths, repositoryFingerprint, sameArtifactManifest, taskArtifactManifest, validateBaseline } from "./baseline.ts";
import { type WorkflowConfig, loadConfig, splitModelRef } from "./config.ts";
import { activeToolsForStage, boundedText, commandFromToolResult, isAllowedTool, isBehaviorBearingPath, isForbiddenShell } from "./gates.ts";
import { deltaReviewPacket, designPacket, envelopeHash, fullReviewPacket, packetBytes, reviewSynthesisPacket, shardFullReview, testPlanPacket } from "./packets.ts";
import { LUNA_WORKFLOW_PROMPT } from "./prompts.ts";
import { type RoleJob, runRole } from "./runner.ts";
import type { RoleResult } from "./schemas.ts";
import { WORKFLOW_STATE_TYPE, type ArtifactManifest, type WorkflowActivity, type WorkflowState, type ReviewRecord, type RoleArtifact, type RunState, type UsageTotals, addPath, emptyState, hash, invalidateApproval, isTerminal, newRun, restoreState, reviseTask, stateSummary, usageZero } from "./state.ts";
import { assignFindingIds, diffLineReferences, hasFreshVerification, mergeAdvisories, reviewChainHash, selectReviewScope, triageFindings } from "./review.ts";
import { updateWorkflowUi } from "./ui.ts";

const INTERNAL_PREFIX = "WORKFLOW_INTERNAL:";
const MUTATING_FILE_TOOLS = new Set(["edit", "write"]);

interface PendingMutation {
  toolName: string;
  paths: Array<{ path: string; behavior: boolean }>;
}

interface PendingShell {
  beforeHash: string;
  beforeArtifactManifestHash: string;
  beforeStatusManifest: ArtifactManifest;
}

function now(): number { return Date.now(); }

function summarizeTool(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName === "bash" || toolName === "hypa_shell") return String(input.command ?? "").split("\n", 1)[0].slice(0, 160);
  if (toolName === "edit" || toolName === "write" || toolName === "read") return String(input.path ?? "").slice(0, 160);
  if (toolName === "grep" || toolName === "hypa_grep") return String(input.pattern ?? "").slice(0, 160);
  if (toolName === "workflow_file") return `${String(input.action ?? "file")} ${String(input.path ?? "")}${input.destination ? ` → ${String(input.destination)}` : ""}`.slice(0, 160);
  return undefined;
}

async function safeProjectPath(cwd: string, rawPath: string): Promise<{ absolute: string; repoPath: string }> {
  const root = await realpath(cwd);
  const absolute = resolve(root, rawPath.replace(/^@/, ""));
  const repoPath = relative(root, absolute).split(sep).join("/");
  if (!repoPath || repoPath === "." || repoPath === ".." || repoPath.startsWith("../") || repoPath === ".git" || repoPath.startsWith(".git/")) {
    throw new Error(`Path is outside the attributable project workspace: ${rawPath}`);
  }
  const parent = await realpath(dirname(absolute));
  const parentRelative = relative(root, parent);
  if (parentRelative === ".." || parentRelative.startsWith(`..${sep}`)) throw new Error(`Path resolves outside the project workspace: ${rawPath}`);
  return { absolute, repoPath };
}

function changedManifestPaths(before: ArtifactManifest, after: ArtifactManifest): Set<string> {
  const entries = new Map<string, string>();
  for (const entry of before.entries) entries.set(entry.path, hash(entry));
  for (const entry of after.entries) {
    if (entries.get(entry.path) === hash(entry)) entries.delete(entry.path);
    else entries.set(entry.path, hash(entry));
  }
  return new Set(entries.keys());
}

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

function currentRun(state: WorkflowState): RunState {
  if (!state.enabled || !state.run) throw new Error("Enable /workflow and start a task first.");
  if (isTerminal(state.run.stage)) throw new Error("The current workflow run is terminal; send a new task to begin another run.");
  return state.run;
}

function expectedRoleModel(ctx: ExtensionContext, config: WorkflowConfig, role: "luna" | "terra" | "sol"): Model<any> {
  const { provider, model } = splitModelRef(config.models[role]);
  const candidate = ctx.modelRegistry.find(provider, model);
  if (!candidate) throw new Error(`Required ${role} model ${provider}/${model} is unavailable.`);
  if (!candidate.reasoning) throw new Error(`Required ${role} model does not support reasoning.`);
  return candidate;
}

export default function workflowExtension(pi: ExtensionAPI) {
  let config = loadConfig(process.cwd(), false);
  let state: WorkflowState = emptyState();
  let internalModelChange = false;
  let roleInFlight = false;
  let roleAbort: AbortController | undefined;
  const pendingMutations = new Map<string, PendingMutation>();
  const pendingShells = new Map<string, PendingShell>();

  function persist(ctx?: ExtensionContext): void {
    state.updatedAt = now();
    pi.appendEntry(WORKFLOW_STATE_TYPE, JSON.parse(JSON.stringify(state)));
    pi.events.emit("workflow:state", stateSummary(state));
    if (ctx) updateWorkflowUi(ctx, state);
  }

  function startActivity(toolCallId: string, toolName: string, input: Record<string, unknown>, ctx: ExtensionContext): void {
    const run = state.run;
    if (!state.enabled || !run || isTerminal(run.stage)) return;
    const activity: WorkflowActivity = {
      id: toolCallId,
      label: toolName,
      detail: summarizeTool(toolName, input),
      status: "running",
      startedAt: now(),
    };
    run.activities = [...run.activities.filter((item) => item.id !== toolCallId), activity].slice(-12);
    persist(ctx);
  }

  function finishActivity(toolCallId: string, isError: boolean, ctx: ExtensionContext): void {
    const activity = state.run?.activities.find((item) => item.id === toolCallId);
    if (!activity) return;
    activity.status = isError ? "error" : "done";
    activity.finishedAt = now();
    persist(ctx);
  }

  function applyToolPolicy(ctx: ExtensionContext): void {
    if (!state.enabled) return;
    const all = pi.getAllTools().map((tool) => tool.name);
    const idleOrTerminal = !state.run || isTerminal(state.run.stage);
    pi.setActiveTools(activeToolsForStage(Boolean(state.run?.terraPlan && !idleOrTerminal), all, idleOrTerminal));
    updateWorkflowUi(ctx, state);
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
      ctx.ui.notify(`Workflow blocked: ${state.run?.blockedReason ?? "Luna unavailable"}`, "error");
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
    } catch (error) {
      if (state.run?.id === runId && state.run.generation === generation) {
        // A specialist transport/model failure is resumable. Suppress the
        // automatic continuation so an explicit /workflow continue controls
        // whether an aborted or timed-out child is retried.
        state.run.gatedWorkStarted = true;
        state.run.nudgeCount = 2;
        persist(ctx);
      }
      throw error;
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
        run.nudgeCount = 0;
        run.stage = run.behaviorMutation ? "implementing" : run.stage;
      }
    }

    const command = commandFromToolResult(event);
    const shell = pendingShells.get(event.toolCallId);
    if (command && shell) {
      pendingShells.delete(event.toolCallId);
      const afterHash = await repositoryFingerprint(ctx.cwd);
      const paths = await gitStatusPaths(ctx.cwd);
      let afterStatusManifest: ArtifactManifest;
      try {
        afterStatusManifest = await taskArtifactManifest(ctx.cwd, paths);
      } catch {
        afterStatusManifest = { version: 1, entries: [], hash: "status-manifest-unreadable" };
        if (!run.unscopedChanges.includes("Could not capture post-command status manifest.")) {
          run.unscopedChanges.push("Could not capture post-command status manifest.");
        }
      }
      for (const path of changedManifestPaths(shell.beforeStatusManifest, afterStatusManifest)) {
        const wasAlreadyDirty = shell.beforeStatusManifest.entries.some((entry) => entry.path === path);
        if (wasAlreadyDirty) {
          // A shell command changed an already-dirty path. Existing task paths
          // remain attributable to the task; unrelated paths fail closed.
          if (!run.taskPaths.includes(path) && !run.unscopedChanges.includes(path)) run.unscopedChanges.push(path);
          continue;
        }
        try {
          const captured = await capturePathAfterShellChange(ctx.cwd, run.baseline, path);
          addPath(run.taskPaths, captured);
        } catch {
          if (!run.unscopedChanges.includes(path)) run.unscopedChanges.push(path);
        }
      }
      run.behaviorMutation = run.behaviorMutation || changedManifestPaths(shell.beforeStatusManifest, afterStatusManifest).size > 0;
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
        truncated: output.includes("[output truncated by workflow]"),
        beforeArtifactManifestHash: shell.beforeArtifactManifestHash,
        artifactManifestHash,
        beforeRepoHash: shell.beforeHash,
        afterRepoHash: afterHash,
        createdAt: now(),
      });
      run.lastRepoHash = afterHash;
      invalidateApproval(run);
      run.nudgeCount = 0;
      run.stage = "verifying";
    } else if (pending && !event.isError) {
      run.lastRepoHash = await repositoryFingerprint(ctx.cwd);
    }
    run.updatedAt = now();
    persist(ctx);
  }

  async function enable(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the current agent turn to settle before enabling /workflow.", "warning");
      return;
    }
    config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
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
      ctx.ui.notify("Workflow enabled: Luna xhigh owns implementation; Terra and Sol are isolated specialists.", "info");
    } catch (error) {
      internalModelChange = false;
      state = emptyState();
      ctx.ui.notify(`Could not enable workflow: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  async function disable(ctx: ExtensionCommandContext): Promise<void> {
    if (!state.enabled) return;
    if (!ctx.isIdle() || roleInFlight) {
      ctx.ui.notify("Wait for Luna and any specialist call to settle before disabling /workflow.", "warning");
      return;
    }
    if (state.run && !isTerminal(state.run.stage) && (state.run.behaviorMutation || state.run.terraPlan || state.run.solDesign)) {
      ctx.ui.notify("This run has gated work in progress. Use /workflow continue or /workflow abandon before disabling.", "warning");
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
    ctx.ui.notify("Workflow disabled and prior session settings restored.", "info");
  }

  async function startGoal(goal: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.isProjectTrusted()) {
      ctx.ui.notify("/workflow requires a trusted project directory.", "error");
      return;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      ctx.ui.notify("Wait for the current Pi turn and queued prompts to settle before starting /workflow.", "warning");
      return;
    }
    if (!state.enabled) await enable(ctx);
    if (!state.enabled) return;
    if (state.run && !isTerminal(state.run.stage)) {
      ctx.ui.notify(`A workflow run is already ${state.run.stage}. Use /workflow continue or /workflow abandon.`, "warning");
      return;
    }
    pi.sendUserMessage(goal);
  }

  pi.registerFlag("workflow", { description: "Enable Luna/Terra/Sol workflow mode", type: "boolean", default: false });
  pi.registerCommand("workflow", {
    description: "Start or control the active-checkout Luna/Terra/Sol workflow",
    handler: async (args, ctx) => {
      const raw = args.trim();
      const [verb = "", ...rest] = raw.split(/\s+/);
      const command = verb.toLowerCase();
      if (command === "on") return enable(ctx);
      if (command === "off") return disable(ctx);
      if (command === "status") {
        ctx.ui.notify(JSON.stringify(stateSummary(state), null, 2), state.run?.stage === "blocked" ? "error" : "info");
        return;
      }
      if (command === "continue") {
        if (!state.enabled || !state.run || isTerminal(state.run.stage)) {
          ctx.ui.notify("There is no resumable workflow run.", "warning");
          return;
        }
        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
          ctx.ui.notify("Wait for the current Pi turn to settle before continuing.", "warning");
          return;
        }
        state.run.nudgeCount = 0;
        state.run.blockedReason = undefined;
        persist(ctx);
        pi.sendUserMessage(`${INTERNAL_PREFIX} Resume the existing task from stage ${state.run.stage}. Continue with the next required implementation, verification, or review action.`, { deliverAs: "followUp" });
        return;
      }
      if (command === "abandon" || command === "cancel") {
        if (!state.run || isTerminal(state.run.stage)) {
          ctx.ui.notify("There is no active workflow run to abandon.", "warning");
          return;
        }
        state.run.stage = "blocked";
        state.run.blockedReason = "Run abandoned by the user; active-checkout changes were left intact.";
        applyToolPolicy(ctx);
        persist(ctx);
        ctx.ui.notify(state.run.blockedReason, "warning");
        return;
      }

      let goal = command === "start" ? rest.join(" ").trim() : raw;
      if (!goal) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /workflow <implementation goal>", "warning");
          return;
        }
        goal = (await ctx.ui.editor("Workflow implementation goal", ""))?.trim() ?? "";
        if (!goal) return;
      }
      await startGoal(goal, ctx);
    },
  });

  pi.registerTool({
    name: "workflow_file",
    label: "Workflow File",
    description: "Remove or move one project file with task-baseline attribution. Directories, .git, overwrites, and paths outside the project are rejected.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("remove"), Type.Literal("move")]),
      path: Type.String({ minLength: 1 }),
      destination: Type.Optional(Type.String({ minLength: 1 })),
    }),
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const source = await safeProjectPath(ctx.cwd, params.path);
      const sourceInfo = await lstat(source.absolute);
      if (!sourceInfo.isFile()) throw new Error("workflow_file operates on regular files, not directories or symlinks.");
      if (params.action === "remove") {
        await unlink(source.absolute);
        return { content: [{ type: "text", text: `Removed ${source.repoPath}` }], details: { action: params.action, paths: [source.repoPath] } };
      }
      if (!params.destination) throw new Error("A destination is required for a move.");
      const destination = await safeProjectPath(ctx.cwd, params.destination);
      try {
        await lstat(destination.absolute);
        throw new Error(`Move destination already exists: ${destination.repoPath}`);
      } catch (error: unknown) {
        if ((error as { code?: string }).code !== "ENOENT") throw error;
      }
      await rename(source.absolute, destination.absolute);
      return { content: [{ type: "text", text: `Moved ${source.repoPath} → ${destination.repoPath}` }], details: { action: params.action, paths: [source.repoPath, destination.repoPath] } };
    },
  });

  pi.registerTool({
    name: "workflow_sol_design",
    label: "Sol Design",
    description: "Run required Sol xhigh architecture design after workflow risk detection or Terra escalation. Optional consultations are rejected.",
    parameters: Type.Object({ question: Type.Optional(Type.String()) }),
    prepareArguments(args) {
      if (!args || typeof args !== "object") return args;
      const input = args as { question?: unknown };
      return typeof input.question === "string" ? { question: input.question } : {};
    },
    executionMode: "sequential",
    async execute(_id, params, signal, update, ctx) {
      void signal;
      const run = currentRun(state);
      if (run.solDesign) {
        return { content: [{ type: "text", text: run.solDesign.body }], details: { reused: true }, usage: run.solDesign.usage ? usageForPi(run.solDesign.usage) : undefined };
      }
      if (!run.needsSol) throw new Error("Sol design is not required for this run. Continue with workflow_terra_test_plan.");
      if (run.solConsults >= config.maxSolConsults) throw new Error(`Sol consultation limit (${config.maxSolConsults}) reached.`);
      run.gatedWorkStarted = true;
      const startedAt = now();
      const publishProgress = (): void => update?.({
        content: [{ type: "text", text: `Sol design running · ${Math.max(0, Math.round((now() - startedAt) / 1_000))}s elapsed` }],
        details: { role: "sol", stage: "designing", startedAt },
      });
      publishProgress();
      const timer = setInterval(publishProgress, 1_000);
      timer.unref?.();
      try {
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
        run.nudgeCount = 0;
        run.updatedAt = now();
        persist(ctx);
        return { content: [{ type: "text", text: call.result.body }], details: { role: "sol", attempts: call.attempts, elapsedMs: now() - startedAt }, usage: usageForPi(call.usage) };
      } finally {
        clearInterval(timer);
      }
    },
  });

  pi.registerTool({
    name: "workflow_terra_test_plan",
    label: "Terra Test Plan",
    description: "Require Terra xhigh to produce a test plan before behavior-bearing mutation.",
    parameters: Type.Object({ focus: Type.Optional(Type.String()) }),
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      void signal;
      const run = currentRun(state);
      if (run.needsSol && !run.solDesign) throw new Error("This task requires Sol design before Terra can plan tests.");
      run.gatedWorkStarted = true;
      run.stage = "test_planning";
      persist(ctx);
      const packet = { ...testPlanPacket(run), focus: params.focus?.trim() || undefined };
      const call = await runSpecialist(ctx, "terra_test_plan", packet);
      if (call.result.requiresSol) {
        run.needsSol = true;
        run.terraPlan = undefined;
        run.stage = "intake";
        run.nudgeCount = 0;
        run.updatedAt = now();
        applyToolPolicy(ctx);
        persist(ctx);
        return {
          content: [{ type: "text", text: `SOL_REQUIRED: ${call.result.body}\n\nCall workflow_sol_design, then request a fresh Terra test plan.` }],
          details: { role: "terra", kind: "test_plan", requiresSol: true, attempts: call.attempts },
          usage: usageForPi(call.usage),
        };
      }
      run.terraPlan = roleArtifact("terra", call.result, call.usage);
      run.stage = "implementing";
      run.nudgeCount = 0;
      run.updatedAt = now();
      applyToolPolicy(ctx);
      persist(ctx);
      return { content: [{ type: "text", text: call.result.body }], details: { role: "terra", kind: "test_plan", requiresSol: false, attempts: call.attempts }, usage: usageForPi(call.usage) };
    },
  });

  pi.registerTool({
    name: "workflow_terra_review",
    label: "Terra Review",
    description: "Have Terra xhigh review Luna's final task-local diff and verification evidence.",
    parameters: Type.Object({ focus: Type.Optional(Type.String()) }),
    executionMode: "sequential",
    async execute(_id, params, signal, _update, ctx) {
      void signal;
      const run = currentRun(state);
      run.gatedWorkStarted = true;
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
        // Missing verification is recoverable: leave the run alive so Luna can
        // execute the exact planned command and retry review. The review still
        // fails closed because no Terra call or approval is created here.
        run.stage = "verifying";
        run.blockedReason = undefined;
        persist(ctx);
        throw new Error("Terra review requires fresh successful verification for the exact current task artifacts.");
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
        // Approval was already bound to the exact task, manifest, verification,
        // and immutable review snapshot above. Finish atomically here rather
        // than requiring a second model/tool handshake that can be forgotten.
        run.stage = "finished";
        run.approvalEnvelopeHash = envelope;
        run.approvalChainHash = record.chainHash;
        run.blockedReason = undefined;
      } else if (verdict === "BLOCKED" || run.reviews.length >= config.maxReviews) {
        run.stage = "blocked";
        run.blockedReason = verdict === "BLOCKED" ? result.summary : `Terra review cap (${config.maxReviews}) reached without approval.`;
      } else {
        run.stage = "remediating";
      }
      if (result.requiresSol) run.needsSol = true;
      run.nudgeCount = 0;
      run.updatedAt = now();
      applyToolPolicy(ctx);
      persist(ctx);
      return { content: [{ type: "text", text: `${verdict}: ${result.body}${verdict === "APPROVE" ? "\n\nThe workflow is complete; summarize the implementation and verification to the user." : ""}` }], details: { pass: record.pass, verdict, completed: verdict === "APPROVE", coverage, scope, transport, fallbackReason, blockers: activeFindings.length, advisories: triage.advisories.length, packetBytes: packetSize }, usage: usageForPi(usage) };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
    state = restoreState(ctx.sessionManager.getBranch());
    for (const activity of state.run?.activities ?? []) {
      if (activity.status === "running") {
        activity.status = "blocked";
        activity.finishedAt = now();
        activity.detail = activity.detail ? `${activity.detail} · interrupted` : "interrupted";
      }
    }
    if (pi.getFlag("workflow") === true && !state.enabled) {
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
    config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
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
    return { systemPrompt: `${event.systemPrompt}\n\n${LUNA_WORKFLOW_PROMPT}` };
  });

  pi.on("tool_execution_start", (event, ctx) => {
    startActivity(event.toolCallId, event.toolName, event.args as Record<string, unknown>, ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    finishActivity(event.toolCallId, event.isError, ctx);
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    if (!state.enabled) return;
    const run = state.run;
    if (!run || isTerminal(run.stage)) {
      return { block: true, reason: "No active workflow run can accept specialist or mutation work. Send a new task first." };
    }
    const hasPlan = Boolean(run.terraPlan);
    if (!isAllowedTool(event.toolName, hasPlan)) {
      return { block: true, reason: `Workflow tool policy blocks ${event.toolName} at stage ${run.stage}.` };
    }
    if (MUTATING_FILE_TOOLS.has(event.toolName) || event.toolName === "workflow_file" || event.toolName === "bash" || event.toolName === "hypa_shell") {
      const currentHash = await repositoryFingerprint(ctx.cwd);
      if (currentHash !== run.lastRepoHash) {
        run.unscopedChanges.push("Repository changed outside an observed Luna tool call.");
        run.stage = "blocked";
        run.blockedReason = "Unscoped repository changes prevent further mutation.";
        applyToolPolicy(ctx);
        persist(ctx);
        return { block: true, reason: run.blockedReason };
      }
    }
    if (MUTATING_FILE_TOOLS.has(event.toolName)) {
      if (pendingShells.size > 0 || [...pendingMutations.values()].some((pending) => pending.toolName === "workflow_file")) {
        return { block: true, reason: "File edits cannot run in parallel with shell or workflow_file mutations." };
      }
      const input = event.input as Record<string, unknown>;
      if (typeof input.path !== "string") return { block: true, reason: "Mutation tool has no valid path." };
      const behavior = isBehaviorBearingPath(input.path);
      if (behavior && !hasPlan) return { block: true, reason: "Terra test planning is required before behavior-bearing mutation." };
      try {
        const path = await capturePathBeforeMutation(ctx.cwd, run.baseline, input.path);
        pendingMutations.set(event.toolCallId, { toolName: event.toolName, paths: [{ path, behavior }] });
      } catch (error) {
        return { block: true, reason: `Could not safely capture task baseline: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    if (event.toolName === "workflow_file") {
      if (pendingMutations.size > 0 || pendingShells.size > 0) {
        return { block: true, reason: "workflow_file must run as the only mutation in its tool batch." };
      }
      const input = event.input as Record<string, unknown>;
      if (typeof input.path !== "string") return { block: true, reason: "workflow_file has no valid source path." };
      try {
        const rawPaths = [input.path, ...(input.action === "move" && typeof input.destination === "string" ? [input.destination] : [])];
        const paths: PendingMutation["paths"] = [];
        for (const rawPath of rawPaths) {
          const safe = await safeProjectPath(ctx.cwd, rawPath);
          const path = await capturePathBeforeMutation(ctx.cwd, run.baseline, safe.repoPath);
          paths.push({ path, behavior: isBehaviorBearingPath(path) });
        }
        pendingMutations.set(event.toolCallId, { toolName: event.toolName, paths });
      } catch (error) {
        return { block: true, reason: `Could not safely capture workflow_file baseline: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    if (event.toolName === "bash" || event.toolName === "hypa_shell") {
      if (pendingMutations.size > 0 || pendingShells.size > 0) {
        return { block: true, reason: "Shell commands must run as the only mutation-capable tool in their batch." };
      }
      if (!hasPlan) return { block: true, reason: "Shell execution is disabled until Terra has written the test plan." };
      const command = String((event.input as Record<string, unknown>).command ?? "");
      const forbidden = isForbiddenShell(command);
      if (forbidden) return { block: true, reason: forbidden };
      let beforeArtifactManifestHash: string;
      try {
        // Capture even an empty task manifest. Without an explicit hash, the
        // first clean verification command can never prove that its pre- and
        // post-command artifact state was unchanged.
        beforeArtifactManifestHash = (await taskArtifactManifest(ctx.cwd, run.taskPaths)).hash;
      } catch (error) {
        return { block: true, reason: `Could not capture pre-command task manifest: ${error instanceof Error ? error.message : String(error)}` };
      }
      const beforeStatusPaths = await gitStatusPaths(ctx.cwd);
      let beforeStatusManifest: ArtifactManifest;
      try {
        beforeStatusManifest = await taskArtifactManifest(ctx.cwd, beforeStatusPaths);
      } catch (error) {
        return { block: true, reason: `Could not capture pre-command status manifest: ${error instanceof Error ? error.message : String(error)}` };
      }
      pendingShells.set(event.toolCallId, {
        beforeHash: await repositoryFingerprint(ctx.cwd),
        beforeArtifactManifestHash,
        beforeStatusManifest,
      });
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (state.enabled) await recordMutationResult(event, ctx);
  });

  pi.on("user_bash", () => {
    if (!state.enabled) return;
    return {
      result: {
        output: "Manual ! shell commands are disabled during /workflow because they bypass Luna-only change attribution.",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const run = state.run;
    if (!state.enabled || !run || isTerminal(run.stage) || roleInFlight) return;
    if (!run.gatedWorkStarted && !run.terraPlan && !run.behaviorMutation && !run.solDesign) {
      // Explanations and inert documentation changes need no specialist gate.
      run.stage = "finished";
      run.blockedReason = undefined;
      applyToolPolicy(ctx);
      persist(ctx);
      return;
    }
    if (run.nudgeCount === 0) {
      run.nudgeCount = 1;
      persist(ctx);
      pi.sendUserMessage(`${INTERNAL_PREFIX} Continue the required workflow. Use the next required implementation, verification, or review action; an exact Terra approval will finish the run automatically.`, { deliverAs: "followUp" });
      return;
    }
    // A model stopping twice is an interruption, not evidence that the task is
    // impossible. Leave every gate and artifact intact for explicit resumption.
    run.nudgeCount = 2;
    persist(ctx);
    ctx.ui.notify(`Workflow paused at ${run.stage}; use /workflow continue to resume.`, "warning");
  });
}
