import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { BaselineRef } from "./state.ts";

interface SnapshotEntry {
  snapshot?: string;
  absent?: boolean;
  initialDirty?: boolean;
}

interface BaselineManifest {
  version: 1;
  cwd: string;
  initialDirty: string[];
  paths: Record<string, SnapshotEntry>;
}

function stateRoot(): string {
  return process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
}

function hashText(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRepoPath(cwd: string, value: string): string {
  const absolute = resolve(cwd, value);
  const normalized = relative(cwd, absolute).split(sep).join("/");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Path escapes repository: ${value}`);
  }
  return normalized;
}

function fileAt(cwd: string, repoPath: string): string {
  return resolve(cwd, repoPath);
}

async function execFile(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}

async function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return execFile("git", args, cwd);
}

/** Includes staged, unstaged, and untracked paths without shell parsing. */
export async function gitStatusPaths(cwd: string): Promise<string[]> {
  const result = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (result.code !== 0) return [];
  const fields = result.stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (path) paths.push(normalizeRepoPath(cwd, path));
    // -z rename/copy records include the old path as the next NUL field.
    if (status.includes("R") || status.includes("C")) {
      const oldPath = fields[++i];
      if (oldPath) paths.push(normalizeRepoPath(cwd, oldPath));
    }
  }
  return [...new Set(paths)].sort();
}

export async function repositoryFingerprint(cwd: string): Promise<string> {
  const [status, head] = await Promise.all([
    git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(cwd, ["rev-parse", "HEAD"]),
  ]);
  return hashText(`${head.code === 0 ? head.stdout.trim() : "NO_HEAD"}\0${status.stdout}`);
}

async function writeManifest(ref: BaselineRef, manifest: BaselineManifest): Promise<void> {
  await writeFile(ref.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

async function loadManifest(ref: BaselineRef): Promise<BaselineManifest> {
  const value = JSON.parse(await readFile(ref.manifestPath, "utf8")) as BaselineManifest;
  if (value.version !== 1 || typeof value.cwd !== "string" || !value.paths) throw new Error("Invalid orchestrator baseline manifest");
  return value;
}

async function copySnapshot(cwd: string, repoPath: string, ref: BaselineRef, manifest: BaselineManifest, initialDirty = false): Promise<void> {
  if (manifest.paths[repoPath]) return;
  const source = fileAt(cwd, repoPath);
  const snapshot = join(ref.dir, "files", repoPath);
  try {
    const info = await stat(source);
    if (!info.isFile()) {
      manifest.paths[repoPath] = { absent: true, initialDirty };
    } else {
      await mkdir(dirname(snapshot), { recursive: true, mode: 0o700 });
      await copyFile(source, snapshot);
      manifest.paths[repoPath] = { snapshot: relative(ref.dir, snapshot), initialDirty };
    }
  } catch {
    manifest.paths[repoPath] = { absent: true, initialDirty };
  }
}

/** Creates durable copies only for intake-dirty files; clean files snapshot just before Luna changes them. */
export async function createBaseline(cwd: string, sessionId: string, runId: string): Promise<BaselineRef> {
  const dir = join(stateRoot(), "pi-orchestrator", sessionId, runId);
  await mkdir(join(dir, "files"), { recursive: true, mode: 0o700 });
  const ref: BaselineRef = {
    dir,
    manifestPath: join(dir, "manifest.json"),
    initialRepoHash: await repositoryFingerprint(cwd),
    createdAt: Date.now(),
  };
  const initialDirty = await gitStatusPaths(cwd);
  const manifest: BaselineManifest = { version: 1, cwd, initialDirty, paths: {} };
  for (const path of initialDirty) await copySnapshot(cwd, path, ref, manifest, true);
  await writeManifest(ref, manifest);
  return ref;
}

export async function validateBaseline(cwd: string, ref: BaselineRef): Promise<{ ok: boolean; reason?: string }> {
  if (!existsSync(ref.manifestPath)) return { ok: false, reason: "The task baseline artifact is missing." };
  try {
    const manifest = await loadManifest(ref);
    if (resolve(manifest.cwd) !== resolve(cwd)) return { ok: false, reason: "The task baseline belongs to another repository." };
    for (const entry of Object.values(manifest.paths)) {
      if (entry.snapshot && !existsSync(join(ref.dir, entry.snapshot))) {
        return { ok: false, reason: "A task baseline snapshot is missing." };
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `The task baseline is corrupt: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function capturePathBeforeMutation(cwd: string, ref: BaselineRef, rawPath: string): Promise<string> {
  const repoPath = normalizeRepoPath(cwd, rawPath.replace(/^@/, ""));
  const manifest = await loadManifest(ref);
  await copySnapshot(cwd, repoPath, ref, manifest);
  await writeManifest(ref, manifest);
  return repoPath;
}

/** For shell-created changes, get a clean tracked baseline from HEAD instead of post-command contents. */
export async function capturePathAfterShellChange(cwd: string, ref: BaselineRef, rawPath: string): Promise<string> {
  const repoPath = normalizeRepoPath(cwd, rawPath);
  const manifest = await loadManifest(ref);
  if (manifest.paths[repoPath]) return repoPath;
  const snapshot = join(ref.dir, "files", repoPath);
  await mkdir(dirname(snapshot), { recursive: true, mode: 0o700 });
  const head = await git(cwd, ["show", `HEAD:${repoPath}`]);
  if (head.code === 0) {
    await writeFile(snapshot, head.stdout, { mode: 0o600 });
    manifest.paths[repoPath] = { snapshot: relative(ref.dir, snapshot) };
  } else {
    manifest.paths[repoPath] = { absent: true };
  }
  await writeManifest(ref, manifest);
  return repoPath;
}

async function emptyFile(dir: string): Promise<string> {
  const path = join(dir, "empty");
  if (!existsSync(path)) await writeFile(path, "", { mode: 0o600 });
  return path;
}

async function isOpaque(path: string): Promise<boolean> {
  try {
    const value = await readFile(path);
    return value.subarray(0, 8192).includes(0);
  } catch {
    return false;
  }
}

async function noIndexDiff(cwd: string, oldPath: string, newPath: string, repoPath: string): Promise<string> {
  const result = await git(cwd, ["diff", "--no-index", "--no-ext-diff", "--", oldPath, newPath]);
  if (result.code > 1) throw new Error(result.stderr || `Could not create diff for ${repoPath}`);
  // git diff --no-index does not support --label. Replace host-specific artifact
  // paths so the reviewer sees stable repository-relative names only.
  return result.stdout
    .replace(/^diff --git .*$/m, `diff --git a/${repoPath} b/${repoPath}`)
    .replace(/^--- .*$/m, `--- a/${repoPath}`)
    .replace(/^\+\+\+ .*$/m, `+++ b/${repoPath}`);
}

export interface TaskDiff {
  text: string;
  hash: string;
  paths: string[];
  complete: boolean;
  reason?: string;
}

/** Produce a diff strictly against the per-run baseline, never against the user's pre-existing changes. */
export async function collectTaskDiff(cwd: string, ref: BaselineRef, taskPaths: string[]): Promise<TaskDiff> {
  const manifest = await loadManifest(ref);
  const empty = await emptyFile(ref.dir);
  const chunks: string[] = [];
  for (const repoPath of [...new Set(taskPaths)].sort()) {
    const entry = manifest.paths[repoPath];
    if (!entry) return { text: "", hash: hashText(""), paths: taskPaths, complete: false, reason: `No baseline captured for ${repoPath}.` };
    const oldPath = entry.snapshot ? join(ref.dir, entry.snapshot) : empty;
    const current = fileAt(cwd, repoPath);
    const currentPath = existsSync(current) ? current : empty;
    if (await isOpaque(oldPath) || await isOpaque(currentPath)) {
      return { text: "", hash: hashText(""), paths: taskPaths, complete: false, reason: `Opaque binary artifact ${repoPath} cannot receive complete review.` };
    }
    chunks.push(await noIndexDiff(cwd, oldPath, currentPath, repoPath));
  }
  const text = chunks.filter(Boolean).join("\n");
  return { text, hash: hashText(text), paths: [...new Set(taskPaths)].sort(), complete: true };
}

export async function cleanupBaseline(ref: BaselineRef): Promise<void> {
  await rm(ref.dir, { recursive: true, force: true });
}

export function temporaryPacketDir(): string {
  return join(tmpdir(), "pi-orchestrator-");
}
