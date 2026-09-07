import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ENTRY_TYPE = "ordinary-tuicr-state";
const PACKAGE_ROOT = "/home/raja/Projects/pi-workbench/packages/pi-review-workbench";
const COORDINATOR_MODULE = pathToFileURL(join(PACKAGE_ROOT, "change-control", "coordinator.mjs")).href;
const STATE_ROOT = join(process.env.XDG_STATE_HOME || join(process.env.HOME || ".", ".local", "state"), "pi-review-workbench", "ordinary");

function enabled(): boolean {
  // Ordinary prompt history is intentionally available to normal Pi TUI
  // sessions too. Herdr supplies pane identity when available; the session
  // identity remains the canonical fallback when it does not.
  return process.env.PI_REVIEW_WORKBENCH_ENABLED !== "1";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function locatorPath(paneId: string): string {
  return join(STATE_ROOT, `${digest(paneId)}.json`);
}

function summarize(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n");
}

async function readJson(path: string): Promise<any | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function command(pi: ExtensionAPI, binary: string, args: string[], options: any = {}): Promise<{ stdout: string; stderr: string }> {
  const result = await pi.exec(binary, args, options);
  if (result.killed || options.signal?.aborted) throw new Error(`${binary} was aborted.`);
  if (result.code !== 0) throw new Error(String(result.stderr || result.stdout || `${binary} exited with code ${result.code}`).trim());
  return { stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}

async function gitText(pi: ExtensionAPI, cwd: string, args: string[], options: any = {}): Promise<string> {
  return (await command(pi, "git", ["-C", cwd, ...args], options)).stdout.trim();
}

async function sourceRoot(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string> {
  return resolve(await gitText(pi, cwd, ["rev-parse", "--show-toplevel"], { signal }));
}

async function loadCoordinator(pi: ExtensionAPI): Promise<any> {
  // Pi reloads this extension in-process. Bust Node's file-module cache so
  // coordinator fixes are active immediately after /reload rather than
  // leaving a stale capture implementation attached to the new handlers.
  const { ChangeControlCoordinator } = await import(`${COORDINATOR_MODULE}?reload=${Date.now()}`);
  return new ChangeControlCoordinator({
    runner: { exec: (binary: string, args: string[], options: any = {}) => pi.exec(binary, args, options) },
  });
}

function branchState(ctx: ExtensionContext): any | undefined {
  const entries = ctx.sessionManager.getBranch();
  return [...entries].reverse().find((entry: any) => entry.type === "custom" && entry.customType === ENTRY_TYPE)?.data?.state;
}

function validState(value: any, sessionId: string, sourceRepository: string): boolean {
  return Boolean(value)
    && value.version === 1
    && value.sessionId === sessionId
    && typeof value.paneId === "string"
    && value.paneId.length > 0
    && typeof value.runId === "string"
    && value.run
    && value.run.sourceRepository === sourceRepository
    && typeof value.run.stagingDirectory === "string"
    && typeof value.run.privateGitDirectory === "string";
}

async function existingState(
  ctx: ExtensionContext,
  coordinator: any,
  sessionId: string,
  sourceRepository: string,
  paneId: string,
): Promise<any | undefined> {
  const candidates = [branchState(ctx), await readJson(locatorPath(paneId))];
  try {
    for (const entry of await readdir(STATE_ROOT)) {
      if (!entry.endsWith(".json")) continue;
      candidates.push(await readJson(join(STATE_ROOT, entry)));
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const matches = new Map<string, any>();
  for (const candidate of candidates) {
    if (!validState(candidate, sessionId, sourceRepository)) continue;
    try {
      const current = await coordinator.getRun(candidate.runId);
      if (current.run.sourceRepository === sourceRepository) {
        matches.set(candidate.runId, { ...candidate, run: current.run });
      }
    } catch {
      // Stale or incomplete private state is never guessed or repaired in place.
    }
  }
  if (matches.size > 1) {
    throw new Error("multiple private prompt histories match this Pi session and repository");
  }
  return matches.values().next().value;
}

async function ensureState(pi: ExtensionAPI, ctx: ExtensionContext): Promise<any> {
  const sessionId = ctx.sessionManager.getSessionId();
  const repo = await sourceRoot(pi, ctx.cwd, ctx.signal);
  const paneId = process.env.HERDR_PANE_ID || `ordinary-session-${digest(`${sessionId}:${repo}`).slice(0, 32)}`;
  const coordinator = await loadCoordinator(pi);
  const restored = await existingState(ctx, coordinator, sessionId, repo, paneId);
  if (restored) {
    restored.pendingPrompts = Array.isArray(restored.pendingPrompts) ? restored.pendingPrompts : [];
    restored.activePrompt = restored.activePrompt && typeof restored.activePrompt.summary === "string"
      ? restored.activePrompt
      : undefined;
    restored.nextPromptToken = Number.isSafeInteger(restored.nextPromptToken)
      ? restored.nextPromptToken
      : Number(restored.lastCapturedSequence) || 0;
    return { state: restored, coordinator };
  }

  const runId = `ordinary-${digest(`${sessionId}:${repo}`).slice(0, 32)}`;
  const created = await coordinator.createRun({ sourceRepository: repo, runId });
  const state = {
    version: 1,
    sessionId,
    paneId,
    sourceRepository: repo,
    runId,
    run: created.run,
    lastCapturedSequence: 0,
    nextPromptToken: 0,
    pendingPrompts: [],
    activePrompt: undefined,
    updatedAt: Date.now(),
  };
  await writeJsonAtomic(locatorPath(paneId), state);
  pi.appendEntry(ENTRY_TYPE, { state });
  return { state, coordinator };
}

async function persistState(pi: ExtensionAPI, state: any, appendEntry = true): Promise<void> {
  state.updatedAt = Date.now();
  await writeJsonAtomic(locatorPath(state.paneId), state);
  if (appendEntry) pi.appendEntry(ENTRY_TYPE, { state });
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export default function ordinaryTuicr(pi: ExtensionAPI): void {
  if (!enabled()) return;

  let runtimePromise: Promise<any> | undefined;
  let operation: Promise<void> = Promise.resolve();
  let historyUnavailable = false;

  const runtime = (ctx: ExtensionContext): Promise<any> => {
    if (historyUnavailable) return Promise.reject(new Error("Private prompt history is unavailable for this session."));
    runtimePromise ??= ensureState(pi, ctx).catch((error) => {
      historyUnavailable = true;
      throw error;
    });
    return runtimePromise;
  };

  const notifyError = (ctx: ExtensionContext, prefix: string, error: unknown): void => {
    ctx.ui.notify(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, "error");
  };

  const serialize = async (ctx: ExtensionContext, prefix: string, work: () => Promise<void>): Promise<void> => {
    operation = operation.then(work).catch((error) => notifyError(ctx, prefix, error));
    await operation;
  };

  const capturePrompt = async (
    state: any,
    coordinator: any,
    prompt: any,
    ctx: ExtensionContext,
    boundary: string,
  ): Promise<void> => {
    if (prompt.capturedSnapshotId) return;
    let result: any;
    let reason = "unstable";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(75);
      result = await coordinator.captureSnapshot(state.runId, {
        kind: "prompt",
        label: prompt.summary,
        boundary,
        force: true,
        mirrorSource: true,
        sourceRepository: state.sourceRepository,
        stabilizationMs: 75,
      });
      if (result.created) break;
      reason = result.reason || reason;
      if (reason !== "unstable") break;
    }
    if (!result?.created) throw new Error(`snapshot was not created (${reason}) after 3 attempts`);
    state.lastCapturedSequence = Number.isSafeInteger(state.lastCapturedSequence)
      ? state.lastCapturedSequence + 1
      : 1;
    prompt.capturedSnapshotId = result.snapshot.snapshotId;
    await persistState(pi, state);
    ctx.ui.setStatus("ordinary-tuicr", ctx.ui.theme.fg("dim", `tuicr: ${state.lastCapturedSequence} private prompt snapshot(s) · Ctrl+T`));
  };

  const takePendingPrompt = (state: any, deliveredSummary: string): any | undefined => {
    const pending = Array.isArray(state.pendingPrompts) ? state.pendingPrompts : [];
    let index = pending.findIndex((item: any) => item.summary === deliveredSummary);
    if (index < 0 && pending.length > 0) {
      const priorities = state.activePrompt ? ["steer", "followUp", "direct"] : ["direct", "steer", "followUp"];
      for (const mode of priorities) {
        index = pending.findIndex((item: any) => item.mode === mode);
        if (index >= 0) break;
      }
    }
    if (index < 0) return undefined;
    return pending.splice(index, 1)[0];
  };

  pi.registerCommand("undo", {
    description: "Select a prompt and restore private staging to its state",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      try {
        const { state, coordinator } = await runtime(ctx);
        const requested = args.trim();
        let targetSnapshotId: string | null | undefined;
        if (!requested) {
          const timeline = await coordinator.timeline(state.runId);
          const prompts = timeline.snapshots.filter((item: any) => item.kind === "prompt");
          if (prompts.length === 0) {
            ctx.ui.notify("No settled prompts are available to undo.", "warning");
            return;
          }
          const reversePrompts = [...prompts].reverse();
          const options = [
            ...reversePrompts.map((item: any, index: number) => `${index + 1}. ${item.snapshotId === timeline.cursorSnapshotId ? "[current] " : ""}${item.label ?? "(prompt)"}`),
            "0. Baseline (before the first prompt)",
          ];
          const choice = await ctx.ui.select("Undo private staging to the state after which prompt?", options);
          if (!choice) return;
          const selected = options.indexOf(choice);
          if (selected < 0) throw new Error("The undo selection was not recognized.");
          targetSnapshotId = selected === reversePrompts.length ? null : reversePrompts[selected].snapshotId;
        } else if (requested === "previous") {
          targetSnapshotId = undefined;
        } else if (requested === "base" || requested === "baseline" || requested === "0") {
          targetSnapshotId = null;
        } else {
          const prompts = (await coordinator.timeline(state.runId)).snapshots.filter((item: any) => item.kind === "prompt");
          const target = /^\d+$/.test(requested)
            ? [...prompts].reverse()[Number(requested) - 1]
            : prompts.find((item: any) => item.snapshotId === requested);
          if (!target) throw new Error(`Unknown prompt target '${requested}'. Use /undo with no argument to select one.`);
          targetSnapshotId = target.snapshotId;
        }
        const result = await coordinator.undo(state.runId, { targetSnapshotId });
        const destination = result.targetSnapshotId ?? "the baseline";
        ctx.ui.notify(result.applied ? `Private staging restored to ${destination}.` : `Private undo: ${result.reason}.`, result.applied ? "info" : "warning");
      } catch (error) { notifyError(ctx, "Private undo failed", error); }
    },
  });

  pi.registerCommand("changes", {
    description: "Show private per-prompt tuicr history status",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        const { state, coordinator } = await runtime(ctx);
        const timeline = await coordinator.timeline(state.runId);
        const prompts = timeline.snapshots.filter((item: any) => item.kind === "prompt");
        const promptList = [...prompts].reverse().map((item: any, index: number) => `${item.snapshotId === timeline.cursorSnapshotId ? "▶" : " "}${index + 1}: ${item.label ?? "(prompt)"}`).join(" | ");
        ctx.ui.notify(`${timeline.snapshots.length} private snapshot(s); ${prompts.length} prompt snapshot(s).${promptList ? ` Prompts — ${promptList}` : ""} Use /undo <number> to restore the state after that prompt. Press Ctrl+T to open tuicr.`, "info");
      } catch (error) { notifyError(ctx, "Private history unavailable", error); }
    },
  });

  pi.on("input", async (event: any, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || historyUnavailable || event.source === "extension" || typeof event.text !== "string") return;
    const summary = summarize(event.text);
    if (!summary) return;
    await serialize(ctx, "Private prompt queue failed", async () => {
      const { state } = await runtime(ctx);
      state.nextPromptToken = Number.isSafeInteger(state.nextPromptToken) ? state.nextPromptToken + 1 : 1;
      state.pendingPrompts = Array.isArray(state.pendingPrompts) ? state.pendingPrompts : [];
      state.pendingPrompts.push({
        token: state.nextPromptToken,
        summary,
        mode: event.streamingBehavior === "steer" || event.streamingBehavior === "followUp"
          ? event.streamingBehavior
          : "direct",
        queuedAt: Date.now(),
      });
      await persistState(pi, state);
    });
  });

  pi.on("message_start", async (event: any, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || historyUnavailable) return;
    if (event.message?.role === "assistant") {
      await serialize(ctx, "Private prompt lifecycle failed", async () => {
        const { state } = await runtime(ctx);
        if (!state.activePrompt || state.activePrompt.sawAgentActivity) return;
        state.activePrompt.sawAgentActivity = true;
        await persistState(pi, state, false);
      });
      return;
    }
    if (event.message?.role !== "user") return;
    const deliveredSummary = summarize(messageText(event.message));
    await serialize(ctx, "Private prompt boundary failed", async () => {
      const { state, coordinator } = await runtime(ctx);
      const nextPrompt = takePendingPrompt(state, deliveredSummary);
      if (!nextPrompt) return;

      const previousPrompt = state.activePrompt;
      if (previousPrompt?.sawAgentActivity) {
        try {
          await capturePrompt(state, coordinator, previousPrompt, ctx, "pi-next-prompt-delivered");
        } catch (error) {
          state.failedPrompts = Array.isArray(state.failedPrompts) ? state.failedPrompts : [];
          state.failedPrompts.push({ ...previousPrompt, error: error instanceof Error ? error.message : String(error), failedAt: Date.now() });
          state.failedPrompts = state.failedPrompts.slice(-20);
          notifyError(ctx, "Private prompt snapshot failed", error);
        }
        state.activePrompt = nextPrompt;
      } else if (previousPrompt) {
        // Multiple queued messages delivered before any assistant work cannot
        // be attributed separately. Preserve the text as one explicit batch
        // instead of inventing a zero-diff prompt boundary.
        state.activePrompt = {
          ...previousPrompt,
          summary: `${previousPrompt.summary} + ${nextPrompt.summary}`.slice(0, 160),
          batchedPromptTokens: [...(previousPrompt.batchedPromptTokens ?? [previousPrompt.token]), nextPrompt.token],
        };
        ctx.ui.notify("Prompt history combined messages delivered in one batch; use one-at-a-time queue mode for per-prompt diffs.", "warning");
      } else {
        state.activePrompt = nextPrompt;
      }
      await persistState(pi, state);
    });
  });

  pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    void runtime(ctx).then(() => {
      ctx.ui.setStatus("ordinary-tuicr", ctx.ui.theme.fg("dim", "tuicr: private prompt history ready · Ctrl+T"));
    }).catch((error) => {
      ctx.ui.setStatus("ordinary-tuicr", ctx.ui.theme.fg("warning", `tuicr: private history unavailable (${error instanceof Error ? error.message : String(error)})`));
    });
  });

  pi.on("agent_settled", async (_event: any, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui" || historyUnavailable) return;
    await serialize(ctx, "Private prompt snapshot failed", async () => {
      const { state, coordinator } = await runtime(ctx);
      if (state.activePrompt) {
        await capturePrompt(state, coordinator, state.activePrompt, ctx, "pi-agent-settled");
        state.activePrompt = undefined;
      }
      // A fully settled run has no Pi queue left. Any records not delivered as
      // user messages were dequeued/cancelled and must not label a later turn.
      state.pendingPrompts = [];
      await persistState(pi, state);
    });
  });

  pi.on("session_shutdown", async (_event: any, ctx: ExtensionContext) => {
    await operation.catch(() => undefined);
    ctx.ui.setStatus("ordinary-tuicr", undefined);
  });
}
