#!/usr/bin/env node
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdtempSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const Module = require("node:module");

const extensionDir = __dirname;
const localNodeModules = resolve(extensionDir, "../../npm/node_modules");
process.env.NODE_PATH = [localNodeModules, process.env.NODE_PATH].filter(Boolean).join(":");
Module._initPaths();
const jitiModule = process.env.PI_JITI_MODULE || "/home/raja/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti";
if (!existsSync(jitiModule)) throw new Error("Set PI_JITI_MODULE to Pi's jiti package.");
const jiti = require(jitiModule)(join(extensionDir, "test-entry.cjs"), { interopDefault: true });
const config = jiti(join(extensionDir, "config.ts"));
const gates = jiti(join(extensionDir, "gates.ts"));
const state = jiti(join(extensionDir, "state.ts"));
const runner = jiti(join(extensionDir, "runner.ts"));
const packets = jiti(join(extensionDir, "packets.ts"));
const baseline = jiti(join(extensionDir, "baseline.ts"));

assert.equal(config.splitModelRef("openai-codex/gpt-5.6-luna").model, "gpt-5.6-luna");
assert.equal(state.needsSolDesign("migrate the auth schema"), true);
assert.equal(state.needsSolDesign("rename a local variable"), false);
assert.equal(gates.isBehaviorBearingPath("README.md"), false);
assert.equal(gates.isBehaviorBearingPath(".pi/agent/agents/reviewer.md"), true);
assert.equal(gates.isForbiddenShell("git commit -m nope").includes("metadata"), true);
assert.match(gates.isForbiddenShell("python -c 'open(\"x\", \"w\")'"), /bypasses/);
assert.match(gates.isForbiddenShell("printf x > file"), /mutation/);
assert.equal(gates.isForbiddenShell("npm test"), undefined);
assert.equal(gates.isAllowedTool("subagent", true), false);
assert.equal(gates.isAllowedTool("edit", false), true);
assert.equal(gates.isAllowedTool("hypa_shell", false), false);
assert.deepEqual(gates.activeToolsForStage(false, ["read", "edit", "hypa_shell", "orch_terra_test_plan"]), ["read", "orch_terra_test_plan", "edit"]);

const parsed = runner.parseChildOutput([
  JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-terra", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } } } }),
  JSON.stringify({ type: "tool_execution_end", toolName: "orch_role_result", result: { details: { result: { kind: "terra_review", summary: "good", body: "reviewed", verdict: "APPROVE", coverage: ["diff:a.ts"] } } } }),
].join("\n"), { provider: "openai-codex", model: "gpt-5.6-terra" });
assert.equal(parsed.result.verdict, "APPROVE");
assert.equal(parsed.usage.input, 1);
assert.throws(() => runner.parseChildOutput("not json\n", { provider: "x", model: "y" }), /malformed JSONL/);

async function baselineTest() {
  const repo = mkdtempSync(join(tmpdir(), "orch-test-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "a.ts"), "export const n = 1;\n");
  execFileSync("git", ["add", "a.ts"], { cwd: repo });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo });
  const ref = await baseline.createBaseline(repo, "test-session", "test-run");
  await baseline.capturePathBeforeMutation(repo, ref, "a.ts");
  writeFileSync(join(repo, "a.ts"), "export const n = 2;\n");
  const diff = await baseline.collectTaskDiff(repo, ref, ["a.ts"]);
  assert.equal(diff.complete, true);
  assert.match(diff.text, /-export const n = 1/);
  assert.match(diff.text, /\+export const n = 2/);
  await baseline.cleanupBaseline(ref);

  // Pre-existing user work is the task baseline, not part of Luna's diff.
  writeFileSync(join(repo, "a.ts"), "export const n = 7;\n");
  const dirty = await baseline.createBaseline(repo, "test-session", "dirty-run");
  writeFileSync(join(repo, "a.ts"), "export const n = 8;\n");
  const dirtyDiff = await baseline.collectTaskDiff(repo, dirty, ["a.ts"]);
  assert.match(dirtyDiff.text, /-export const n = 7/);
  assert.doesNotMatch(dirtyDiff.text, /-export const n = 1/);
  await baseline.cleanupBaseline(dirty);

  const refState = { dir: "x", manifestPath: "y", initialRepoHash: "z", createdAt: 1 };
  const run = state.newRun("adjust public API", refState, "repo", "run-1");
  run.reviews.push({ pass: 1, verdict: "CHANGES_REQUESTED", summary: "fix", findings: [], envelopeHash: "a", coverage: [], createdAt: 1 });
  state.reviseTask(run, "adjust public API and migration");
  assert.equal(run.reviews.length, 1, "task revisions cannot reset the Terra review cap");
  assert.equal(run.terraPlan, undefined);
  assert.equal(packets.chunkDiff("a\nb\nc", 2).length > 1, true);
}

baselineTest().then(
  () => console.log("orchestrator tests passed"),
  (error) => { console.error(error); process.exitCode = 1; },
);
