import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { finished } from "node:stream/promises";
import { dirname, join } from "node:path";
import type { PlanCheck, CheckReceipt, VerificationRecord } from "./state.ts";
import { captureRepositoryState, changedPathsBetweenStates } from "./baseline.ts";

export interface VerificationOptions {
  cwd: string;
  runDir: string;
  planRevision: number;
  attempt: number;
  checks: PlanCheck[];
  commandTimeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  onProgress?: (progress: { check: PlanCheck; index: number; total: number; elapsedMs: number }) => void;
}

interface CommandResult {
  exitCode?: number;
  timedOut: boolean;
  cancelled: boolean;
  outputTail: string;
  outputTruncated: boolean;
  durationMs: number;
  logPath: string;
}

function appendTail(current: Buffer, chunk: Buffer, limit: number): { value: Buffer; truncated: boolean } {
  if (limit <= 0) return { value: Buffer.alloc(0), truncated: current.length > 0 || chunk.length > 0 };
  if (current.length + chunk.length <= limit) return { value: Buffer.concat([current, chunk]), truncated: false };
  const combined = Buffer.concat([current, chunk]);
  return { value: combined.subarray(Math.max(0, combined.length - limit)), truncated: true };
}

function utf8Tail(value: Buffer): string {
  let start = 0;
  while (start < Math.min(3, value.length) && (value[start] & 0xc0) === 0x80) start += 1;
  return value.subarray(start).toString("utf8");
}

function terminateGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals, includeExitedLeader = false): void {
  // A shell leader can exit after SIGTERM while a descendant retains its stdio
  // pipes. The hard-kill path must still target that original process group or
  // Node never receives the child's close event.
  if (!child.pid || (!includeExitedLeader && child.exitCode !== null)) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

export async function runVerificationCommand(options: {
  command: string;
  cwd: string;
  logPath: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  onElapsed?: (elapsedMs: number) => void;
}): Promise<CommandResult> {
  options.signal?.throwIfAborted();
  mkdirSync(dirname(options.logPath), { recursive: true, mode: 0o700 });
  const log = createWriteStream(options.logPath, { flags: "w", mode: 0o600 });
  const startedAt = Date.now();
  let tail = Buffer.alloc(0);
  let truncated = false;
  let timedOut = false;
  let cancelled = false;
  let settled = false;

  const child = spawn("/bin/bash", ["-lc", options.command], {
    cwd: options.cwd,
    env: process.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const consume = (source: "stdout" | "stderr", chunk: Buffer): void => {
    const prefix = Buffer.from(`[${source}] `);
    log.write(prefix);
    log.write(chunk);
    if (chunk.length === 0 || chunk[chunk.length - 1] !== 0x0a) log.write("\n");
    const next = appendTail(tail, Buffer.concat([prefix, chunk]), options.maxOutputBytes);
    tail = next.value;
    truncated ||= next.truncated;
  };
  child.stdout.on("data", (chunk: Buffer) => consume("stdout", Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => consume("stderr", Buffer.from(chunk)));

  let hardKill: NodeJS.Timeout | undefined;
  const stop = (reason: "timeout" | "cancel"): void => {
    if (settled) return;
    timedOut ||= reason === "timeout";
    cancelled ||= reason === "cancel";
    terminateGroup(child, "SIGTERM", true);
    hardKill = setTimeout(() => {
      if (!settled) terminateGroup(child, "SIGKILL", true);
    }, 2_000);
    hardKill.unref?.();
  };
  const timeout = setTimeout(() => stop("timeout"), options.timeoutMs);
  timeout.unref?.();
  const interval = setInterval(() => options.onElapsed?.(Date.now() - startedAt), 1_000);
  interval.unref?.();
  const onAbort = (): void => stop("cancel");
  options.signal?.addEventListener("abort", onAbort, { once: true });

  let exitCode: number | undefined;
  try {
    exitCode = await new Promise<number | undefined>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? undefined));
    });
  } finally {
    settled = true;
    clearTimeout(timeout);
    clearInterval(interval);
    if (hardKill) clearTimeout(hardKill);
    options.signal?.removeEventListener("abort", onAbort);
    log.end();
    await finished(log).catch(() => undefined);
  }

  return {
    exitCode,
    timedOut,
    cancelled,
    outputTail: utf8Tail(tail),
    outputTruncated: truncated,
    durationMs: Date.now() - startedAt,
    logPath: options.logPath,
  };
}

export async function runVerificationSuite(options: VerificationOptions): Promise<VerificationRecord> {
  const startedAt = Date.now();
  const receipts: CheckReceipt[] = [];
  let suiteStatus: VerificationRecord["status"] = "passed";

  for (let index = 0; index < options.checks.length; index += 1) {
    const check = options.checks[index];
    const logPath = join(options.runDir, "logs", `verify-r${options.planRevision}-a${options.attempt}-${check.id}.log`);
    if (options.signal?.aborted) {
      receipts.push({
        ...check,
        status: "cancelled",
        outputTail: "Verification was cancelled before this command started.",
        outputTruncated: false,
        logPath,
        durationMs: 0,
        changedPaths: [],
      });
      suiteStatus = "cancelled";
      break;
    }
    const before = await captureRepositoryState(options.cwd);
    options.onProgress?.({ check, index, total: options.checks.length, elapsedMs: 0 });
    let command: CommandResult;
    try {
      command = await runVerificationCommand({
        command: check.command,
        cwd: options.cwd,
        logPath,
        timeoutMs: options.commandTimeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        signal: options.signal,
        onElapsed: (elapsedMs) => options.onProgress?.({ check, index, total: options.checks.length, elapsedMs }),
      });
    } catch (error) {
      const after = await captureRepositoryState(options.cwd);
      const cancelled = options.signal?.aborted === true;
      receipts.push({
        ...check,
        status: cancelled ? "cancelled" : "failed",
        outputTail: error instanceof Error ? error.message : String(error),
        outputTruncated: false,
        logPath,
        durationMs: Date.now() - startedAt,
        beforeFingerprint: before.fingerprint,
        afterFingerprint: after.fingerprint,
        changedPaths: await changedPathsBetweenStates(options.cwd, before, after),
      });
      suiteStatus = cancelled ? "cancelled" : "failed";
      break;
    }
    const after = await captureRepositoryState(options.cwd);
    const changedPaths = await changedPathsBetweenStates(options.cwd, before, after);
    let status: CheckReceipt["status"] = "passed";
    if (command.cancelled) status = "cancelled";
    else if (command.timedOut || command.exitCode !== 0) status = command.timedOut ? "timed_out" : "failed";
    if (changedPaths.length > 0) status = "mutated";
    receipts.push({
      ...check,
      status,
      exitCode: command.exitCode,
      outputTail: command.outputTail,
      outputTruncated: command.outputTruncated,
      logPath: command.logPath,
      durationMs: command.durationMs,
      beforeFingerprint: before.fingerprint,
      afterFingerprint: after.fingerprint,
      changedPaths,
    });
    if (status !== "passed") {
      suiteStatus = status === "cancelled" ? "cancelled" : status === "mutated" ? "mutated" : "failed";
      break;
    }
  }

  const completed = await captureRepositoryState(options.cwd);
  for (const check of options.checks.slice(receipts.length)) {
    receipts.push({ ...check, status: "not_run", outputTail: "", outputTruncated: false, durationMs: 0, changedPaths: [] });
  }
  return {
    attempt: options.attempt,
    planRevision: options.planRevision,
    status: suiteStatus,
    checks: receipts,
    repositoryFingerprint: completed.fingerprint,
    startedAt,
    completedAt: Date.now(),
  };
}
