import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { ArtifactManifest, ArtifactManifestEntry, BaselineRef, ReviewSnapshot } from "./state.ts";
import { hash, stableJson } from "./state.ts";

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

async function pathFingerprint(cwd: string, repoPath: string): Promise<string> {
  try {
    const info = await lstat(fileAt(cwd, repoPath));
    if (info.isSymbolicLink()) return `${repoPath}\0symlink\0${info.mode}\0${hashText(await readlink(fileAt(cwd, repoPath)))}`;
    if (!info.isFile()) return `${repoPath}\0other\0${info.mode}`;
    return `${repoPath}\0file\0${info.mode}\0${hashText(await readFile(fileAt(cwd, repoPath)))}`;
  } catch {
    return `${repoPath}\0missing`;
  }
}

/** Hash HEAD/index status and bytes of every dirty/untracked working-tree path. */
export async function repositoryFingerprint(cwd: string): Promise<string> {
  const [status, head, index] = await Promise.all([
    git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(cwd, ["rev-parse", "HEAD"]),
    git(cwd, ["diff", "--cached", "--binary", "--no-ext-diff"]),
  ]);
  const paths = await gitStatusPaths(cwd);
  const content = await Promise.all(paths.map((path) => pathFingerprint(cwd, path)));
  return hashText(`${head.code === 0 ? head.stdout.trim() : "NO_HEAD"}\0${status.stdout}\0${index.stdout}\0${content.sort().join("\0")}`);
}

async function writeManifest(ref: BaselineRef, manifest: BaselineManifest): Promise<void> {
  await writeFile(ref.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

async function loadManifest(ref: BaselineRef): Promise<BaselineManifest> {
  const value = JSON.parse(await readFile(ref.manifestPath, "utf8")) as BaselineManifest;
  if (value.version !== 1 || typeof value.cwd !== "string" || !value.paths) throw new Error("Invalid workflow baseline manifest");
  return value;
}

async function copySnapshot(cwd: string, repoPath: string, ref: BaselineRef, manifest: BaselineManifest, initialDirty = false): Promise<void> {
  if (manifest.paths[repoPath]) return;
  const source = fileAt(cwd, repoPath);
  const snapshot = join(ref.dir, "files", repoPath);
  try {
    // Never follow a working-tree symlink while creating a durable baseline.
    const info = await lstat(source);
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
  const dir = join(stateRoot(), "pi-workflow", sessionId, runId);
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
  const root = await realpath(cwd);
  const absolute = fileAt(root, repoPath);
  let cursor = dirname(absolute);
  while (true) {
    try {
      const parent = await realpath(cursor);
      const parentRelative = relative(root, parent);
      if (parentRelative === ".." || parentRelative.startsWith(`..${sep}`)) throw new Error(`Path resolves outside repository: ${rawPath}`);
      break;
    } catch (error: unknown) {
      if ((error as { code?: string }).code !== "ENOENT") throw error;
      const next = dirname(cursor);
      if (next === cursor) throw new Error(`Could not resolve a repository parent for ${rawPath}`);
      cursor = next;
    }
  }
  try {
    const info = await lstat(absolute);
    if (!info.isFile()) throw new Error(`Only regular files can be mutated through attributed file tools: ${rawPath}`);
  } catch (error: unknown) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
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

/** Exact task-local state used for review freshness and delta eligibility. */
export async function taskArtifactManifest(cwd: string, taskPaths: string[]): Promise<ArtifactManifest> {
  const entries: ArtifactManifestEntry[] = [];
  for (const path of [...new Set(taskPaths)].sort()) {
    const repoPath = normalizeRepoPath(cwd, path);
    const absolute = fileAt(cwd, repoPath);
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) {
        entries.push({ path: repoPath, kind: "symlink", mode: info.mode });
      } else if (!info.isFile()) {
        entries.push({ path: repoPath, kind: "other", mode: info.mode });
      } else {
        const content = await readFile(absolute);
        entries.push({ path: repoPath, kind: "file", hash: hashText(content), size: content.byteLength, mode: info.mode });
      }
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code === "ENOENT") entries.push({ path: repoPath, kind: "missing" });
      else throw new Error(`Could not read task artifact ${repoPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const canonical = entries.map((entry) => ({ ...entry }));
  return { version: 1, entries, hash: hash(stableJson(canonical)) };
}

export function sameArtifactManifest(left: ArtifactManifest, right: ArtifactManifest): boolean {
  return left.hash === right.hash && stableJson(left.entries) === stableJson(right.entries);
}

function snapshotFile(dir: string, repoPath: string): string {
  return join(dir, "files", repoPath);
}

/** Persist a complete immutable task snapshot only after a valid Terra review result. */
export async function createReviewSnapshot(cwd: string, ref: BaselineRef, manifest: ArtifactManifest, label: string): Promise<ReviewSnapshot> {
  if (!manifest.entries.every((entry) => entry.kind === "file" || entry.kind === "missing")) {
    throw new Error("Only regular readable artifacts and deletion tombstones may form a review snapshot.");
  }
  const id = `${label}-${manifest.hash.slice(0, 16)}`;
  const dir = join(ref.dir, "reviews", id);
  const temp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(join(temp, "files"), { recursive: true, mode: 0o700 });
  try {
    for (const entry of manifest.entries) {
      // A missing path is a deletion tombstone. It is reviewable in full scope
      // and intentionally disables delta scope via the manifest shape check.
      if (entry.kind === "missing") continue;
      const source = fileAt(cwd, entry.path);
      const target = snapshotFile(temp, entry.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
      const copied = await readFile(target);
      const copiedInfo = await stat(target);
      if (hashText(copied) !== entry.hash || copiedInfo.mode !== entry.mode) {
        throw new Error(`Task artifact ${entry.path} changed while its review snapshot was being written.`);
      }
    }
    await writeFile(join(temp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    try {
      await rename(temp, dir);
    } catch (error: unknown) {
      if (!existsSync(dir)) throw error;
      await rm(temp, { recursive: true, force: true });
    }
    return { id, dir, manifest, createdAt: Date.now() };
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    throw error;
  }
}

export async function validateReviewSnapshot(snapshot: ReviewSnapshot): Promise<{ ok: boolean; reason?: string }> {
  try {
    const stored = JSON.parse(await readFile(join(snapshot.dir, "manifest.json"), "utf8")) as ArtifactManifest;
    if (!sameArtifactManifest(stored, snapshot.manifest)) return { ok: false, reason: "Review snapshot manifest does not match persisted state." };
    for (const entry of stored.entries) {
      if (entry.kind === "missing") continue;
      if (entry.kind !== "file" || !entry.hash || !existsSync(snapshotFile(snapshot.dir, entry.path))) {
        return { ok: false, reason: "Review snapshot is incomplete or contains a non-regular artifact." };
      }
      const content = await readFile(snapshotFile(snapshot.dir, entry.path));
      if (hashText(content) !== entry.hash) return { ok: false, reason: `Review snapshot hash mismatch for ${entry.path}.` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `Review snapshot is missing or corrupt: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Diff current task files against the last immutable Terra-reviewed snapshot. */
export async function collectSnapshotDiff(cwd: string, snapshot: ReviewSnapshot): Promise<TaskDiff> {
  const valid = await validateReviewSnapshot(snapshot);
  if (!valid.ok) return { text: "", hash: hashText(""), paths: snapshot.manifest.entries.map((entry) => entry.path), complete: false, reason: valid.reason };
  const chunks: string[] = [];
  for (const entry of snapshot.manifest.entries) {
    const current = fileAt(cwd, entry.path);
    if (!existsSync(current)) return { text: "", hash: hashText(""), paths: snapshot.manifest.entries.map((item) => item.path), complete: false, reason: `Delta artifact ${entry.path} was deleted.` };
    if (await isOpaque(snapshotFile(snapshot.dir, entry.path)) || await isOpaque(current)) {
      return { text: "", hash: hashText(""), paths: snapshot.manifest.entries.map((item) => item.path), complete: false, reason: `Opaque delta artifact ${entry.path} cannot receive delta review.` };
    }
    chunks.push(await noIndexDiff(cwd, snapshotFile(snapshot.dir, entry.path), current, entry.path));
  }
  const text = chunks.filter(Boolean).join("\n");
  return { text, hash: hashText(text), paths: snapshot.manifest.entries.map((entry) => entry.path), complete: true };
}

export async function cleanupBaseline(ref: BaselineRef): Promise<void> {
  await rm(ref.dir, { recursive: true, force: true });
}

export function temporaryPacketDir(): string {
  return join(tmpdir(), "pi-workflow-");
}
