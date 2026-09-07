#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { spawn } from "node:child_process";

const PACKAGE_ROOT = "/home/raja/Projects/pi-workbench/packages/pi-review-workbench";
const CLI = join(PACKAGE_ROOT, "bin", "pi-change-stack.mjs");
const PRIVATE_TUICR = "/home/raja/Projects/pi-workbench/vendor/tuicr/dist/tuicr-single-prompt";
const STATE_ROOT = join(process.env.XDG_STATE_HOME || join(process.env.HOME || ".", ".local", "state"), "pi-review-workbench", "ordinary");
const execFileAsync = promisify(execFile);

function fail(message) {
  process.stderr.write(`tuicr: ${message}\n`);
  process.exitCode = 1;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sessionIdFromPath(value) {
  const name = String(value || "").split("/").pop() || "";
  return name.match(/_([0-9a-f-]{36})\.jsonl$/i)?.[1];
}

async function readAgentIdentity(paneId) {
  try {
    const { stdout } = await execFileAsync("herdr", ["agent", "get", paneId], { maxBuffer: 1024 * 1024 });
    const response = JSON.parse(stdout);
    const agent = response?.result?.agent;
    return {
      sessionId: sessionIdFromPath(agent?.agent_session?.value),
      sourceRepository: agent?.cwd,
    };
  } catch {
    return {};
  }
}

function validState(state) {
  return state?.version === 1
    && typeof state.sessionId === "string"
    && typeof state.paneId === "string"
    && typeof state.runId === "string"
    && state.run
    && typeof state.sourceRepository === "string"
    && typeof state.run.sourceRepository === "string";
}

async function resolveState(paneId) {
  const identity = await readAgentIdentity(paneId);
  let sourceRepository;
  try {
    sourceRepository = (await execFileAsync("git", ["-C", process.cwd(), "rev-parse", "--show-toplevel"], { maxBuffer: 1024 * 1024 })).stdout.trim();
  } catch {
    sourceRepository = identity.sourceRepository;
  }

  const candidates = [];
  try {
    candidates.push(JSON.parse(await readFile(join(STATE_ROOT, `${digest(paneId)}.json`), "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (identity.sessionId) {
    try {
      for (const entry of await readdir(STATE_ROOT)) {
        if (!entry.endsWith(".json")) continue;
        try { candidates.push(JSON.parse(await readFile(join(STATE_ROOT, entry), "utf8"))); } catch {}
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const matches = new Map();
  for (const candidate of candidates) {
    if (!validState(candidate)) continue;
    if (identity.sessionId && candidate.sessionId !== identity.sessionId) continue;
    if (sourceRepository && candidate.sourceRepository !== sourceRepository) continue;
    matches.set(candidate.runId, candidate);
  }
  if (matches.size > 1) throw new Error("multiple private prompt histories match the focused Pi session");
  const state = matches.values().next().value;
  if (!state) throw new Error("no private prompt history is ready for the focused Pi session; reload Pi and wait for it to start");
  return state;
}

async function main() {
  const paneId = process.env.HERDR_ACTIVE_PANE_ID || process.env.HERDR_PANE_ID;
  if (!paneId) return fail("Herdr did not provide the active Pi pane identity.");

  let state;
  try {
    state = await resolveState(paneId);
  } catch (error) {
    return fail(error?.code === "ENOENT"
      ? "no private prompt history is ready for the focused Pi session"
      : `could not resolve private prompt history: ${error.message}`);
  }

  const dataRoot = resolve(process.env.XDG_DATA_HOME || join(process.env.HOME || ".", ".local", "share"));
  const runRoot = resolve(join(dataRoot, "pi-review-workbench", "change-control", "runs", state.runId));
  const staging = resolve(state.run.stagingDirectory || "");
  const privateGit = resolve(state.run.privateGitDirectory || "");
  if (!staging.startsWith(`${runRoot}/`) || !privateGit.startsWith(`${runRoot}/`)) {
    return fail("private history paths are outside the recorded run.");
  }
  const tuicr = process.env.TUICR_BIN || PRIVATE_TUICR;
  try {
    await access(staging);
    await access(privateGit);
    await access(tuicr);
  } catch {
    return fail("private staging is unavailable; start a new Pi session.");
  }

  const range = await new Promise((resolveRange) => {
    const child = spawn(process.execPath, [CLI, "review-range", state.runId], {
      cwd: staging,
      env: { ...process.env, XDG_DATA_HOME: dataRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => resolveRange({ error }));
    child.once("close", (code) => {
      if (code !== 0) return resolveRange({ error: new Error(stderr.trim() || `history lookup exited with code ${code}`) });
      try { resolveRange({ value: JSON.parse(stdout) }); } catch (error) { resolveRange({ error }); }
    });
  });
  if (range.error) return fail(`private prompt history lookup failed: ${range.error.message}`);

  if (!range.value?.firstOid || !range.value?.latestOid || !range.value?.baseOid) {
    return fail("no settled prompt snapshots exist yet; complete one Pi prompt first.");
  }
  // The dedicated build keeps each synthetic prompt independently selectable,
  // including zero-change rows and histories whose latest tree equals baseline.
  // -w is required to activate its private single-prompt mode; the private
  // staging worktree remains the only working tree it can read.
  const args = [
    "-w", "--no-update-check", "--single-prompt",
    "-r", `${range.value.firstOid}^..${range.value.latestOid}`,
    "--single-prompt-baseline", range.value.baseOid,
  ];
  const child = spawn(tuicr, args, {
    cwd: staging,
    env: { ...process.env, XDG_DATA_HOME: dataRoot },
    stdio: "inherit",
  });
  child.once("error", (error) => {
    process.stderr.write(`tuicr: could not start ${tuicr}: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
