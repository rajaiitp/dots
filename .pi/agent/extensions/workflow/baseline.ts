import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { BaselineRef } from "./state.ts";
import { hash, stableJson } from "./state.ts";

export interface PathState {
  kind: "file" | "missing" | "symlink" | "other";
  hash?: string;
  size?: number;
  mode?: number;
  link?: string;
}

export interface RepositoryState {
  head: string;
  treeHash: string;
  statusHash: string;
  indexHash: string;
  paths: Record<string, PathState>;
  fingerprint: string;
}

interface SnapshotEntry extends PathState {
  snapshot?: string;
}

interface BaselineManifest {
  version: 1;
  cwd: string;
  initialHead: string;
  initialPaths: string[];
  entries: Record<string, SnapshotEntry>;
}

// pi-subagents may write these bookkeeping records while the read-only reviewer
// runs. They are not task artifacts and must not invalidate a review or count as
// remediation. This is deliberately exact: all other files under .pi remain in
// the workflow's baseline, verification, and review envelope.
const PI_SUBAGENT_RUNTIME_FILE = ".pi/agent/run-history.jsonl";
const PI_SUBAGENT_MISSIONS_DIR = ".pi/agent/missions/";

function isPiSubagentRuntimePath(repoPath: string): boolean {
  return repoPath === PI_SUBAGENT_RUNTIME_FILE || repoPath.startsWith(PI_SUBAGENT_MISSIONS_DIR);
}

export interface TaskDiff {
  text: string;
  hash: string;
  paths: string[];
  complete: boolean;
  reason?: string;
  currentFingerprint: string;
  initialHead: string;
  currentHead: string;
}

function stateRoot(): string {
  return process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRepoPath(cwd: string, value: string): string {
  const absolute = resolve(cwd, value);
  const normalized = relative(cwd, absolute).split(sep).join("/");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized === ".git" || normalized.startsWith(".git/")) {
    throw new Error(`Path escapes the repository: ${value}`);
  }
  return normalized;
}

async function execBuffer(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}

async function git(cwd: string, args: string[], allowCodeOne = false): Promise<Buffer> {
  const result = await execBuffer("git", args, cwd);
  if (result.code !== 0 && !(allowCodeOne && result.code === 1)) {
    throw new Error(result.stderr.toString("utf8").trim() || `git ${args.join(" ")} exited ${result.code}`);
  }
  return result.stdout;
}

async function currentHead(cwd: string): Promise<string> {
  const value = (await git(cwd, ["rev-parse", "--verify", "HEAD"])).toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/i.test(value)) throw new Error("/workflow requires a Git repository with an initial commit.");
  return value;
}

async function relevantHeadTreeHash(cwd: string): Promise<string> {
  const raw = (await git(cwd, ["ls-tree", "-r", "-z", "HEAD", "--"])).toString("utf8");
  const entries = raw.split("\0").filter(Boolean).filter((entry) => {
    const tab = entry.indexOf("\t");
    return tab >= 0 && !isPiSubagentRuntimePath(normalizeRepoPath(cwd, entry.slice(tab + 1)));
  });
  return digest(entries.join("\0"));
}

function relevantStatus(cwd: string, raw: Buffer): { paths: string[]; hash: string } {
  const fields = raw.toString("utf8").split("\0");
  const paths: string[] = [];
  const records: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const recordPaths = [record.slice(3)];
    if (status.includes("R") || status.includes("C")) recordPaths.push(fields[++index] ?? "");
    const relevant = recordPaths.filter(Boolean).map((path) => normalizeRepoPath(cwd, path)).filter((path) => !isPiSubagentRuntimePath(path));
    if (relevant.length === 0) continue;
    paths.push(...relevant);
    records.push(`${status}\0${relevant.sort().join("\0")}`);
  }
  return { paths: [...new Set(paths)].sort(), hash: digest(records.sort().join("\0")) };
}

export async function gitStatusPaths(cwd: string): Promise<string[]> {
  const raw = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return relevantStatus(cwd, raw).paths;
}

async function inspectPath(cwd: string, repoPath: string): Promise<PathState> {
  const absolute = resolve(cwd, repoPath);
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      const link = await readlink(absolute);
      return { kind: "symlink", link, hash: digest(link), mode: info.mode };
    }
    if (!info.isFile()) return { kind: "other", mode: info.mode };
    const content = await readFile(absolute);
    return { kind: "file", hash: digest(content), size: content.byteLength, mode: info.mode };
  } catch (error: unknown) {
    if ((error as { code?: string }).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}

export async function captureRepositoryState(cwd: string): Promise<RepositoryState> {
  const [head, treeHash, status, index] = await Promise.all([
    currentHead(cwd),
    relevantHeadTreeHash(cwd),
    git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--", ".", `:(exclude)${PI_SUBAGENT_RUNTIME_FILE}`, `:(exclude,glob)${PI_SUBAGENT_MISSIONS_DIR}**`]),
  ]);
  const relevant = relevantStatus(cwd, status);
  const entries: Record<string, PathState> = {};
  for (const path of relevant.paths) entries[path] = await inspectPath(cwd, path);
  // Keep the raw HEAD for later path comparison, but fingerprint only its
  // non-runtime tree entries so a bookkeeping-only commit has no workflow
  // effect while every task/source tree entry remains covered.
  const state = { treeHash, statusHash: relevant.hash, indexHash: digest(index), paths: entries };
  return { head, ...state, fingerprint: hash(state) };
}

export async function repositoryFingerprint(cwd: string): Promise<string> {
  return (await captureRepositoryState(cwd)).fingerprint;
}

async function pathsBetweenHeads(cwd: string, before: string, after: string): Promise<string[]> {
  if (before === after) return [];
  // Review diffs are assembled path-by-path against the run-start tree. Do not
  // collapse a committed rename to its destination: both the old deletion and
  // new addition must be candidates for a complete task-local diff.
  const raw = (await git(cwd, ["diff", "--no-renames", "--name-only", "-z", before, after, "--"])).toString("utf8");
  return raw.split("\0").filter(Boolean).map((path) => normalizeRepoPath(cwd, path)).filter((path) => !isPiSubagentRuntimePath(path));
}

export async function changedPathsBetweenStates(cwd: string, before: RepositoryState, after: RepositoryState): Promise<string[]> {
  const paths = new Set([...Object.keys(before.paths), ...Object.keys(after.paths), ...(await pathsBetweenHeads(cwd, before.head, after.head))]);
  const changed = [...paths].filter((path) => stableJson(before.paths[path] ?? { kind: "missing" }) !== stableJson(after.paths[path] ?? { kind: "missing" }));
  if (before.fingerprint !== after.fingerprint && changed.length === 0) changed.push("(Git index or status metadata)");
  return changed.sort();
}

async function writeManifest(ref: BaselineRef, manifest: BaselineManifest): Promise<void> {
  await writeFile(ref.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

async function loadManifest(ref: BaselineRef): Promise<BaselineManifest> {
  const value = JSON.parse(await readFile(ref.manifestPath, "utf8")) as BaselineManifest;
  if (value.version !== 1 || !value.cwd || !value.initialHead || !Array.isArray(value.initialPaths) || !value.entries) {
    throw new Error("Invalid workflow baseline manifest.");
  }
  return value;
}

async function snapshotCurrentPath(cwd: string, ref: BaselineRef, manifest: BaselineManifest, repoPath: string): Promise<void> {
  const state = await inspectPath(cwd, repoPath);
  const entry: SnapshotEntry = { ...state };
  if (state.kind === "file") {
    const destination = join(ref.dir, "initial", repoPath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(resolve(cwd, repoPath), destination);
    entry.snapshot = relative(ref.dir, destination);
  }
  manifest.entries[repoPath] = entry;
}

export async function createBaseline(cwd: string, sessionId: string, runId: string): Promise<BaselineRef> {
  const root = await realpath(cwd);
  const state = await captureRepositoryState(root);
  const sessionKey = digest(sessionId).slice(0, 24);
  const dir = join(stateRoot(), "pi-workflow-lite", sessionKey, runId);
  await mkdir(join(dir, "initial"), { recursive: true, mode: 0o700 });
  const ref: BaselineRef = {
    dir,
    manifestPath: join(dir, "manifest.json"),
    cwd: root,
    initialHead: state.head,
    initialFingerprint: state.fingerprint,
    createdAt: Date.now(),
  };
  const initialPaths = Object.keys(state.paths).sort();
  const manifest: BaselineManifest = { version: 1, cwd: root, initialHead: state.head, initialPaths, entries: {} };
  for (const path of initialPaths) await snapshotCurrentPath(root, ref, manifest, path);
  await writeManifest(ref, manifest);
  return ref;
}

export async function validateBaseline(cwd: string, ref: BaselineRef): Promise<{ ok: boolean; reason?: string }> {
  if (!existsSync(ref.manifestPath)) return { ok: false, reason: "The workflow baseline is missing." };
  try {
    const manifest = await loadManifest(ref);
    if (resolve(await realpath(cwd)) !== resolve(manifest.cwd) || resolve(ref.cwd) !== resolve(manifest.cwd)) {
      return { ok: false, reason: "The workflow baseline belongs to another repository." };
    }
    if (manifest.initialHead !== ref.initialHead) return { ok: false, reason: "The workflow baseline HEAD does not match persisted state." };
    for (const entry of Object.values(manifest.entries)) {
      if (!entry.snapshot) continue;
      const snapshot = join(ref.dir, entry.snapshot);
      if (!existsSync(snapshot)) return { ok: false, reason: "A workflow baseline snapshot is missing." };
      const info = await lstat(snapshot);
      if (!info.isFile()) return { ok: false, reason: "A workflow baseline snapshot is not a regular file." };
      const content = await readFile(snapshot);
      if (entry.hash !== digest(content)) return { ok: false, reason: "A workflow baseline snapshot hash does not match its manifest." };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `The workflow baseline is corrupt: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function initialEntry(cwd: string, ref: BaselineRef, manifest: BaselineManifest, repoPath: string): Promise<{ state: SnapshotEntry; path?: string }> {
  const existing = manifest.entries[repoPath];
  if (existing) return { state: existing, path: existing.snapshot ? join(ref.dir, existing.snapshot) : undefined };

  const result = await execBuffer("git", ["show", `${manifest.initialHead}:${repoPath}`], cwd);
  if (result.code !== 0) return { state: { kind: "missing" } };
  const tree = await execBuffer("git", ["ls-tree", "-z", manifest.initialHead, "--", repoPath], cwd);
  const modeText = tree.code === 0 ? tree.stdout.toString("utf8").match(/^(\d{6})\s/)?.[1] : undefined;
  const destination = join(ref.dir, "head", repoPath);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, result.stdout, { mode: 0o600 });
  const state: SnapshotEntry = {
    kind: "file",
    hash: digest(result.stdout),
    size: result.stdout.byteLength,
    mode: modeText ? Number.parseInt(modeText, 8) : undefined,
    snapshot: relative(ref.dir, destination),
  };
  return { state, path: destination };
}

function comparable(entry: SnapshotEntry | PathState): PathState {
  return { kind: entry.kind, hash: entry.hash, size: entry.size, mode: entry.mode, link: entry.link };
}

async function emptyPath(ref: BaselineRef): Promise<string> {
  const path = join(ref.dir, "empty");
  if (!existsSync(path)) await writeFile(path, "", { mode: 0o600 });
  return path;
}

async function binary(path: string): Promise<boolean> {
  const content = await readFile(path);
  return content.subarray(0, 8192).includes(0);
}

function metadataOnlyDiff(repoPath: string, before: PathState, after: PathState): string {
  const lines = [`diff --git a/${repoPath} b/${repoPath}`];
  if (before.kind === "missing" && after.kind === "file") lines.push(`new file mode ${(after.mode ?? 0).toString(8).slice(-6)}`, "--- /dev/null", `+++ b/${repoPath}`);
  else if (before.kind === "file" && after.kind === "missing") lines.push(`deleted file mode ${(before.mode ?? 0).toString(8).slice(-6)}`, `--- a/${repoPath}`, "+++ /dev/null");
  else if (before.mode !== after.mode) lines.push(`old mode ${(before.mode ?? 0).toString(8).slice(-6)}`, `new mode ${(after.mode ?? 0).toString(8).slice(-6)}`);
  return `${lines.join("\n")}\n`;
}

async function noIndexDiff(cwd: string, oldPath: string, newPath: string, repoPath: string): Promise<string> {
  const result = await execBuffer("git", ["diff", "--no-index", "--no-ext-diff", "--", oldPath, newPath], cwd);
  if (result.code > 1) throw new Error(result.stderr.toString("utf8").trim() || `Could not create a diff for ${repoPath}.`);
  return result.stdout.toString("utf8")
    // Use replacer callbacks so `$` in a legitimate filename is not treated as
    // a JavaScript replacement pattern.
    .replace(/^diff --git .*$/m, () => `diff --git a/${repoPath} b/${repoPath}`)
    .replace(/^--- .*$/m, () => `--- a/${repoPath}`)
    .replace(/^\+\+\+ .*$/m, () => `+++ b/${repoPath}`);
}

export async function collectTaskDiff(cwd: string, ref: BaselineRef): Promise<TaskDiff> {
  const valid = await validateBaseline(cwd, ref);
  const current = await captureRepositoryState(cwd);
  if (!valid.ok) return { text: "", hash: digest(""), paths: [], complete: false, reason: valid.reason, currentFingerprint: current.fingerprint, initialHead: ref.initialHead, currentHead: current.head };
  const manifest = await loadManifest(ref);
  const candidates = new Set([...manifest.initialPaths, ...Object.keys(current.paths), ...(await pathsBetweenHeads(cwd, manifest.initialHead, current.head))].filter((path) => !isPiSubagentRuntimePath(path)));
  const empty = await emptyPath(ref);
  const chunks: string[] = [];
  const changed: string[] = [];

  for (const repoPath of [...candidates].sort()) {
    const initial = await initialEntry(cwd, ref, manifest, repoPath);
    const after = await inspectPath(cwd, repoPath);
    if (stableJson(comparable(initial.state)) === stableJson(comparable(after))) continue;
    if (![initial.state.kind, after.kind].every((kind) => kind === "file" || kind === "missing")) {
      return { text: "", hash: digest(""), paths: [...changed, repoPath], complete: false, reason: `Symlink or special-file change ${repoPath} cannot receive complete review.`, currentFingerprint: current.fingerprint, initialHead: ref.initialHead, currentHead: current.head };
    }
    const oldPath = initial.state.kind === "file" ? initial.path! : empty;
    const newPath = after.kind === "file" ? resolve(cwd, repoPath) : empty;
    if (await binary(oldPath) || await binary(newPath)) {
      return { text: "", hash: digest(""), paths: [...changed, repoPath], complete: false, reason: `Binary change ${repoPath} exceeds the review contract; split or review it manually.`, currentFingerprint: current.fingerprint, initialHead: ref.initialHead, currentHead: current.head };
    }
    let diff = await noIndexDiff(cwd, oldPath, newPath, repoPath);
    if (!diff) diff = metadataOnlyDiff(repoPath, initial.state, after);
    chunks.push(diff);
    changed.push(repoPath);
  }

  const text = chunks.join("\n");
  return { text, hash: digest(text), paths: changed, complete: true, currentFingerprint: current.fingerprint, initialHead: ref.initialHead, currentHead: current.head };
}
