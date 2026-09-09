#!/usr/bin/env node
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const Module = require("node:module");

const extensionDir = __dirname;
const localNodeModules = resolve(extensionDir, "../../npm/node_modules");
process.env.NODE_PATH = [localNodeModules, process.env.NODE_PATH].filter(Boolean).join(":");
Module._initPaths();
const jitiModule = process.env.PI_JITI_MODULE || "/home/raja/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti";
if (!existsSync(jitiModule)) throw new Error("Set PI_JITI_MODULE to Pi's jiti package.");
const jiti = require(jitiModule)(__filename, { interopDefault: true });
const config = jiti(join(extensionDir, "config.ts"));
const gates = jiti(join(extensionDir, "gates.ts"));
const state = jiti(join(extensionDir, "state.ts"));
const runner = jiti(join(extensionDir, "runner.ts"));
const schemas = jiti(join(extensionDir, "schemas.ts"));
const packets = jiti(join(extensionDir, "packets.ts"));
const review = jiti(join(extensionDir, "review.ts"));
const baseline = jiti(join(extensionDir, "baseline.ts"));
const workflowExtension = jiti(join(extensionDir, "index.ts")).default;

assert.equal(config.splitModelRef("openai-codex/gpt-5.6-luna").model, "gpt-5.6-luna");
assert.equal(config.loadConfig(process.cwd()).enableDeltaReviews, true);
assert.equal(config.loadConfig(process.cwd()).maxChildOutputBytes, 2 * 1024 * 1024, "xhigh JSON event streams have a practical bounded safety limit");
assert.equal(state.needsSolDesign("migrate the auth schema"), true);
assert.equal(state.needsSolDesign("rename a local variable"), false);
assert.equal(gates.isBehaviorBearingPath("README.md"), false);
assert.equal(gates.isBehaviorBearingPath(".pi/agent/agents/reviewer.md"), true);
assert.equal(gates.isForbiddenShell("git commit -m nope").includes("metadata"), true);
assert.equal(gates.isForbiddenShell("GIT_INDEX_FILE=x git add a").includes("metadata"), true);
assert.match(gates.isForbiddenShell("cd .. && npm test"), /outside/);
assert.match(gates.isForbiddenShell("tool --output /var/tmp/result"), /outside/);
assert.match(gates.isForbiddenShell("python -c 'open(\"x\", \"w\")'"), /bypasses/);
assert.match(gates.isForbiddenShell("printf x > file"), /mutation/);
assert.match(gates.isForbiddenShell("npm test &"), /Background/);
assert.equal(gates.isForbiddenShell("npm test >/dev/null 2>&1"), undefined, "observational redirection remains usable");
assert.equal(gates.isForbiddenShell("npm test"), undefined);
assert.equal(gates.isAllowedTool("subagent", true), false);
assert.equal(gates.isAllowedTool("edit", false), true);
assert.equal(gates.isAllowedTool("bash", false), false);
assert.equal(gates.isAllowedTool("bash", true), true);
assert.equal(gates.isAllowedTool("workflow_file", true), true);
assert.equal(gates.isAllowedTool("hypa_shell", false), false);
assert.deepEqual(gates.activeToolsForStage(false, ["read", "edit", "bash", "hypa_shell", "workflow_file", "workflow_terra_test_plan"]), ["read", "workflow_terra_test_plan", "edit"]);
assert.deepEqual(gates.activeToolsForStage(true, ["read", "edit", "bash", "hypa_shell", "workflow_file", "workflow_terra_test_plan"]), ["read", "workflow_terra_test_plan", "edit", "bash", "hypa_shell", "workflow_file"]);
assert.deepEqual(gates.activeToolsForStage(true, ["read", "edit", "bash", "hypa_shell", "workflow_file", "workflow_terra_test_plan"], true), ["read"], "idle and terminal runs expose no role or mutation tools");

const parsed = runner.parseChildOutput([
  JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-terra", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } } } }),
  JSON.stringify({ type: "tool_execution_end", toolName: "workflow_role_result", result: { details: { result: { kind: "terra_review", summary: "good", body: "reviewed", verdict: "APPROVE", coverage: ["diff:a.ts"] } } } }),
].join("\n"), { provider: "openai-codex", model: "gpt-5.6-terra" });
assert.equal(parsed.result.verdict, "APPROVE");
assert.equal(parsed.usage.input, 1);
assert.throws(() => runner.parseChildOutput("not json\n", { provider: "x", model: "y" }), /malformed JSONL/);
assert.throws(() => schemas.parseRoleResult({ kind: "terra_review", summary: "bad", body: "bad", findings: [{ key: "bad", severity: "unknown", message: "bad" }] }), /invalid severity/);
const triaged = review.triageFindings(review.assignFindingIds(1, [
  { key: "critical", severity: "critical", message: "critical" },
  { key: "unqualified", severity: "medium", message: "unqualified" },
  { key: "qualified", severity: "medium", message: "qualified", evidence: [{ kind: "failed_test", reference: "npm test: failing case" }] },
  { key: "style", severity: "low", message: "style" },
]), { acceptanceCriteria: [], artifactPaths: ["a.ts"], diffReferences: new Set(["a.ts:1"]), failedTestOutput: ["npm test: failing case"], solDesign: undefined });
assert.equal(triaged.blockers.length, 2);
assert.equal(triaged.advisories.length, 2);
const weakMedium = review.triageFindings(review.assignFindingIds(1, [{ key: "weak-regression", severity: "medium", message: "weak", evidence: [{ kind: "regression", reference: "a.ts" }] }]), { acceptanceCriteria: [], artifactPaths: ["a.ts"], diffReferences: new Set(), failedTestOutput: [], solDesign: undefined });
assert.equal(weakMedium.blockers.length, 0, "a bare artifact path is not concrete medium evidence");
assert.equal(review.diffLineReferences("diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new").has("a.ts:1"), true, "only actual diff hunk lines qualify as artifact evidence");
assert.equal(review.assignFindingIds(1, [{ key: "style", severity: "low", message: "style" }])[0].id, review.assignFindingIds(2, [{ key: "style", severity: "low", message: "rewritten wording" }])[0].id, "finding IDs remain stable across wording changes");
const advisory = review.assignFindingIds(1, [{ key: "style", severity: "low", file: "a.ts", message: "style" }])[0];
assert.equal(review.mergeAdvisories([advisory], [advisory], []).length, 1, "duplicate advisories are idempotent");
assert.equal(review.mergeAdvisories([advisory], [], [{ ...advisory, severity: "high" }]).length, 0, "a blocker supersedes an advisory with the same ID");

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
  const outside = mkdtempSync(join(tmpdir(), "workflow-outside-"));
  writeFileSync(join(outside, "secret"), "do not snapshot\n");
  symlinkSync(join(outside, "secret"), join(repo, "secret-link"));
  await assert.rejects(() => baseline.capturePathBeforeMutation(repo, dirty, "secret-link"), /regular files/);
  mkdirSync(join(outside, "dir"));
  symlinkSync(join(outside, "dir"), join(repo, "escape"));
  await assert.rejects(() => baseline.capturePathBeforeMutation(repo, dirty, "escape/new.ts"), /outside repository/);
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
  const legacyRun = state.newRun("legacy run", refState, "repo", "legacy");
  legacyRun.stage = "approved";
  legacyRun.approvalEnvelopeHash = "old";
  legacyRun.reviews.push({ pass: 1, verdict: "APPROVE", summary: "old", findings: [], envelopeHash: "old", coverage: [], createdAt: 1 });
  const migrated = state.restoreState([{ type: "custom", customType: state.WORKFLOW_STATE_TYPE, data: { version: 1, enabled: true, run: legacyRun, updatedAt: 1 } }]);
  assert.equal(migrated.version, 5);
  assert.equal(migrated.run.stage, "implementing");
  assert.equal(migrated.run.reviews.length, 0);
  assert.equal(packets.chunkDiff("a\nb\nc", 2).length > 1, true);

  const fingerprintBefore = await baseline.repositoryFingerprint(repo);
  writeFileSync(join(repo, "a.ts"), "export const n = 8.5;\n");
  const fingerprintAfter = await baseline.repositoryFingerprint(repo);
  assert.notEqual(fingerprintAfter, fingerprintBefore, "dirty-file contents participate in repository fingerprints");
  writeFileSync(join(repo, "a.ts"), "export const n = 8;\n");
  const currentManifest = await baseline.taskArtifactManifest(repo, ["a.ts"]);

  // A first clean shell verification has no task paths yet. Exercise the real
  // event handlers so its pre-command empty manifest is recorded explicitly.
  const shellRepo = mkdtempSync(join(tmpdir(), "orch-shell-test-"));
  execFileSync("git", ["init", "-q"], { cwd: shellRepo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: shellRepo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: shellRepo });
  writeFileSync(join(shellRepo, "README.md"), "clean\n");
  writeFileSync(join(shellRepo, "old.ts"), "export const oldName = true;\n");
  execFileSync("git", ["add", "README.md", "old.ts"], { cwd: shellRepo });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: shellRepo });
  writeFileSync(join(shellRepo, "README.md"), "preexisting user work\n");
  const shellRef = await baseline.createBaseline(shellRepo, "event-test", "shell-run");
  const shellRun = state.newRun("verify a clean checkout", shellRef, await baseline.repositoryFingerprint(shellRepo), "shell-run");
  shellRun.terraPlan = { role: "terra", kind: "terra_test_plan", summary: "plan", body: "test", hash: "plan", verificationCommands: ["npm test"], createdAt: 1 };
  shellRun.stage = "implementing";
  const appended = [];
  const handlers = new Map();
  const registeredTools = new Map();
  const registeredCommands = new Map();
  const sentMessages = [];
  let activeTools = [];
  let widgetLines;
  let failSol = false;
  const fakePi = {
    registerFlag() {},
    registerCommand(name, definition) { registeredCommands.set(name, definition); },
    registerTool(definition) { registeredTools.set(definition.name, definition); },
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(_type, data) { appended.push(data); },
    events: { emit() {} },
    getAllTools() { return ["read", "bash", "hypa_shell", "write", "workflow_file", "workflow_terra_test_plan", "workflow_terra_review"].map((name) => ({ name })); },
    setActiveTools(tools) { activeTools = tools; },
    getActiveTools() { return activeTools; },
    getFlag() { return false; },
    getThinkingLevel() { return "xhigh"; },
    setThinkingLevel() {},
    async setModel(model) { return model; },
    async exec(command, args) {
      assert.equal(command, "pi");
      const model = args[args.indexOf("--model") + 1];
      if (failSol && model.endsWith("-sol")) return { code: 1, killed: true, stderr: "aborted", stdout: "" };
      const result = model.endsWith("-sol")
        ? { kind: "sol_design", summary: "designed", body: "architecture ready" }
        : { kind: "terra_review", summary: "approved", body: "reviewed", verdict: "APPROVE", findings: [], coverage: ["diff:app.ts", "diff:new.ts", "diff:old.ts"] };
      return {
        code: 0,
        killed: false,
        stderr: "",
        stdout: [
          JSON.stringify({ type: "message_end", message: { role: "assistant", provider: "openai-codex", model, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } } }),
          JSON.stringify({ type: "tool_execution_end", toolName: "workflow_role_result", result: { details: { result } } }),
        ].join("\n"),
      };
    },
    sendUserMessage(message, options) { sentMessages.push({ message, options }); },
  };
  workflowExtension(fakePi);
  const shellContext = {
    cwd: shellRepo,
    signal: new AbortController().signal,
    sessionManager: {
      getBranch: () => [{ type: "custom", customType: state.WORKFLOW_STATE_TYPE, data: { version: 4, enabled: true, run: shellRun, updatedAt: 1 } }],
      getSessionId: () => "event-test",
    },
    isProjectTrusted: () => true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    model: { provider: "openai-codex", id: "gpt-5.6-luna" },
    modelRegistry: { find(provider, id) { return { provider, id, reasoning: true }; } },
    ui: { theme: { fg: (_color, text) => text, bold: (text) => text }, setStatus() {}, setWidget(_key, value) { widgetLines = value; }, notify() {} },
  };
  await handlers.get("session_start")({}, shellContext);
  const solDesign = registeredTools.get("workflow_sol_design");
  await assert.rejects(() => solDesign.execute("optional-sol", { question: "optional" }, shellContext.signal, undefined, shellContext), /not required/);
  assert.equal(await handlers.get("tool_call")({ toolName: "hypa_shell", toolCallId: "shell-call", input: { command: "npm test" } }, shellContext), undefined);
  await handlers.get("tool_result")({ toolName: "hypa_shell", toolCallId: "shell-call", input: { command: "npm test" }, details: { command: "npm test", exitCode: 0 }, isError: false, content: [{ type: "text", text: "ok" }] }, shellContext);
  const shellEvidence = appended.at(-1).run.verification.at(-1);
  const emptyManifest = await baseline.taskArtifactManifest(shellRepo, []);
  assert.equal(shellEvidence.beforeArtifactManifestHash, emptyManifest.hash, "the first shell command records an explicit empty pre-command manifest");
  assert.equal(shellEvidence.artifactManifestHash, emptyManifest.hash);
  assert.equal(review.hasFreshVerification(shellRun, emptyManifest.hash), true);

  // File removals and moves remain implementation-capable without opaque shell
  // mutations, and both sides of a move are attributed to the task baseline.
  const workflowFile = registeredTools.get("workflow_file");
  assert.ok(workflowFile, "the tracked file operation tool is registered");
  assert.equal(await handlers.get("tool_call")({ toolName: "workflow_file", toolCallId: "move-call", input: { action: "move", path: "old.ts", destination: "new.ts" } }, shellContext), undefined);
  const moveResult = await workflowFile.execute("move-call", { action: "move", path: "old.ts", destination: "new.ts" }, shellContext.signal, undefined, shellContext);
  await handlers.get("tool_result")({ toolName: "workflow_file", toolCallId: "move-call", input: { action: "move", path: "old.ts", destination: "new.ts" }, details: moveResult.details, isError: false, content: moveResult.content }, shellContext);
  assert.equal(existsSync(join(shellRepo, "old.ts")), false);
  assert.equal(existsSync(join(shellRepo, "new.ts")), true);
  assert.deepEqual(shellRun.taskPaths, ["old.ts", "new.ts"]);

  // Missing verification must be retryable rather than terminal. Attribute a
  // behavior-bearing write, reject review, then prove the exact shell check is
  // still reachable and becomes fresh against the new task manifest.
  await handlers.get("tool_call")({ toolName: "write", toolCallId: "write-call", input: { path: "app.ts" } }, shellContext);
  writeFileSync(join(shellRepo, "app.ts"), "export const ready = true;\n");
  await handlers.get("tool_result")({ toolName: "write", toolCallId: "write-call", input: { path: "app.ts" }, isError: false, content: [{ type: "text", text: "written" }] }, shellContext);
  const terraReview = registeredTools.get("workflow_terra_review");
  assert.ok(terraReview, "the Terra review tool is registered");
  await assert.rejects(
    () => terraReview.execute("review-call", {}, shellContext.signal, undefined, shellContext),
    /fresh successful verification/,
  );
  const rejectedState = appended.at(-1).run;
  assert.equal(rejectedState.stage, "verifying", "a missing check leaves the run retryable");
  assert.equal(rejectedState.blockedReason, undefined);
  assert.equal(rejectedState.reviews.length, 0);
  assert.equal(rejectedState.approvalEnvelopeHash, undefined);
  assert.equal(activeTools.includes("hypa_shell"), true, "the exact verification command remains available");

  assert.equal(await handlers.get("tool_call")({ toolName: "hypa_shell", toolCallId: "retry-shell-call", input: { command: "npm test" } }, shellContext), undefined);
  await handlers.get("tool_result")({ toolName: "hypa_shell", toolCallId: "retry-shell-call", input: { command: "npm test" }, details: { command: "npm test", exitCode: 0 }, isError: false, content: [{ type: "text", text: "ok" }] }, shellContext);
  const appManifest = await baseline.taskArtifactManifest(shellRepo, shellRun.taskPaths);
  const retryEvidence = shellRun.verification.at(-1);
  assert.equal(retryEvidence.beforeArtifactManifestHash, appManifest.hash);
  assert.equal(retryEvidence.artifactManifestHash, appManifest.hash);
  assert.equal(review.hasFreshVerification(shellRun, appManifest.hash), true);

  // A twice-settled model pauses without destroying the run; explicit continue
  // resets the nudge and preserves stage, plan, files, and verification.
  await handlers.get("agent_settled")({}, shellContext);
  await handlers.get("agent_settled")({}, shellContext);
  assert.equal(shellRun.stage, "verifying");
  assert.equal(shellRun.blockedReason, undefined);
  assert.equal(shellRun.nudgeCount, 2);
  await registeredCommands.get("workflow").handler("continue", shellContext);
  assert.equal(shellRun.nudgeCount, 0);
  assert.match(String(sentMessages.at(-1).message), /Resume the existing task/);

  await handlers.get("tool_execution_start")({ toolCallId: "timeline-read", toolName: "read", args: { path: "app.ts" } }, shellContext);
  await handlers.get("tool_execution_end")({ toolCallId: "timeline-read", toolName: "read", isError: false }, shellContext);
  assert.equal(shellRun.activities.at(-1).status, "done");
  assert.equal(shellRun.activities.at(-1).detail, "app.ts");
  assert.equal(widgetLines.some((line) => line.includes("Task:")), false, "the persistent widget hides the task");
  assert.equal(widgetLines.some((line) => line.includes("Recent activity:")), false, "the persistent widget hides recent activity");

  const approval = await terraReview.execute("approved-review", {}, shellContext.signal, undefined, shellContext);
  assert.match(approval.content[0].text, /^APPROVE:/);
  assert.equal(approval.details.completed, true);
  assert.equal(shellRun.stage, "finished", "Terra approval atomically completes the run");
  assert.equal(registeredTools.has("workflow_finish"), false, "there is no brittle second finish handshake");
  assert.deepEqual(activeTools, ["read"], "completion returns the session to read-only ready state");
  await baseline.cleanupBaseline(shellRef);

  // Read-only turns complete naturally when the parent settles.
  await handlers.get("before_agent_start")({ prompt: "Explain the current setup", systemPrompt: "base" }, shellContext);
  await handlers.get("agent_settled")({}, shellContext);
  const readOnlyRun = appended.at(-1).run;
  assert.equal(readOnlyRun.stage, "finished");
  await baseline.cleanupBaseline(readOnlyRun.baseline);

  // A mutation cannot absorb an unrelated checkout edit made between observed
  // tool calls; it fails before the task baseline is expanded.
  await handlers.get("before_agent_start")({ prompt: "Change the application", systemPrompt: "base" }, shellContext);
  const guardedRun = appended.at(-1).run;
  writeFileSync(join(shellRepo, "README.md"), "unobserved external edit\n");
  const blockedMutation = await handlers.get("tool_call")({ toolName: "write", toolCallId: "unobserved-write", input: { path: "guarded.ts" } }, shellContext);
  assert.equal(blockedMutation.block, true);
  assert.match(blockedMutation.reason, /Unscoped repository changes/);
  assert.equal(appended.at(-1).run.stage, "blocked");
  await baseline.cleanupBaseline(guardedRun.baseline);

  // High-risk runs may call Sol, and the ordinary tool row receives immediate
  // elapsed progress rather than appearing frozen until child completion.
  await handlers.get("before_agent_start")({ prompt: "Design an architecture migration", systemPrompt: "base" }, shellContext);
  const architectureRun = appended.at(-1).run;
  const progressUpdates = [];
  const solResult = await solDesign.execute("required-sol", { question: "Choose the architecture" }, shellContext.signal, (update) => progressUpdates.push(update), shellContext);
  assert.match(progressUpdates[0].content[0].text, /Sol design running/);
  assert.match(solResult.content[0].text, /architecture ready/);
  assert.equal(solResult.details.role, "sol");
  await registeredCommands.get("workflow").handler("abandon", shellContext);
  await baseline.cleanupBaseline(architectureRun.baseline);

  // Aborted/timed-out specialist calls remain paused and resumable rather than
  // being misreported as successfully finished read-only work.
  await handlers.get("before_agent_start")({ prompt: "Design another architecture migration", systemPrompt: "base" }, shellContext);
  const interruptedRun = appended.at(-1).run;
  failSol = true;
  await assert.rejects(() => solDesign.execute("failed-sol", { question: "Choose the architecture" }, shellContext.signal, undefined, shellContext), /timed out or was aborted/);
  failSol = false;
  await handlers.get("agent_settled")({}, shellContext);
  assert.equal(appended.at(-1).run.stage, "designing");
  assert.equal(appended.at(-1).run.gatedWorkStarted, true);
  assert.equal(appended.at(-1).run.nudgeCount, 2);
  await registeredCommands.get("workflow").handler("abandon", shellContext);
  await baseline.cleanupBaseline(interruptedRun.baseline);
  const snapshot = await baseline.createReviewSnapshot(repo, dirty, currentManifest, "pass-1");
  assert.equal((await baseline.validateReviewSnapshot(snapshot)).ok, true);
  writeFileSync(join(repo, "a.ts"), "export const n = 9;\n");
  const remediation = await baseline.collectSnapshotDiff(repo, snapshot);
  assert.match(remediation.text, /-export const n = 8/);
  assert.match(remediation.text, /\+export const n = 9/);

  const manifestAfterFix = await baseline.taskArtifactManifest(repo, ["a.ts"]);
  const deltaRun = state.newRun("fix local rendering", dirty, "repo", "delta-run");
  deltaRun.terraPlan = { role: "terra", kind: "terra_test_plan", summary: "plan", body: "test", hash: "plan", verificationCommands: ["npm test"], createdAt: 1 };
  deltaRun.verification.push({ toolName: "hypa_shell", command: "npm test", exitCode: 0, isError: false, output: "ok", outputHash: "ok", beforeArtifactManifestHash: manifestAfterFix.hash, artifactManifestHash: manifestAfterFix.hash, beforeRepoHash: "a", afterRepoHash: "b", createdAt: 1 });
  deltaRun.reviews.push({ pass: 1, verdict: "CHANGES_REQUESTED", summary: "fix it", findings: [{ id: "T1-a", key: "adjust-rendering", severity: "medium", file: "a.ts", message: "adjust rendering", evidence: [{ kind: "regression", reference: "a.ts:1" }] }], envelopeHash: "base", coverage: ["diff:a.ts"], snapshot, taskRevision: 1, terraPlanHash: "plan", createdAt: 1 });
  assert.equal(review.selectReviewScope(deltaRun, manifestAfterFix, true).scope, "delta");
  assert.equal(review.selectReviewScope(deltaRun, manifestAfterFix, false).scope, "full");
  assert.equal(review.hasFreshVerification(deltaRun, manifestAfterFix.hash), true);
  const narrowed = { ...deltaRun, verification: [{ ...deltaRun.verification[0], command: "npm test -- narrowed" }] };
  assert.equal(review.hasFreshVerification(narrowed, manifestAfterFix.hash), false, "narrowed commands cannot satisfy Terra's exact required check");
  const stale = { ...deltaRun, verification: [{ ...deltaRun.verification[0], beforeArtifactManifestHash: "old" }] };
  assert.equal(review.hasFreshVerification(stale, manifestAfterFix.hash), false, "commands that mutate artifacts cannot support approval");

  const multiCommand = {
    ...deltaRun,
    terraPlan: { ...deltaRun.terraPlan, verificationCommands: ["npm test", "cargo test"] },
    verification: [
      deltaRun.verification[0],
      { ...deltaRun.verification[0], command: "cargo test", createdAt: 2 },
    ],
  };
  assert.equal(review.hasFreshVerification(multiCommand, manifestAfterFix.hash), true, "every planned command must have exact successful evidence");
  const failedLatest = {
    ...deltaRun,
    verification: [...deltaRun.verification, { ...deltaRun.verification[0], exitCode: 1, output: "failed", createdAt: 2 }],
  };
  assert.equal(review.hasFreshVerification(failedLatest, manifestAfterFix.hash), false, "a later failed run invalidates earlier evidence for the same command");

  const mutationRun = state.newRun("verify after an edit", dirty, "repo", "mutation-run");
  mutationRun.taskPaths = ["a.ts"];
  mutationRun.terraPlan = { role: "terra", kind: "terra_test_plan", summary: "plan", body: "test", hash: "plan", verificationCommands: ["npm test"], createdAt: 1 };
  mutationRun.verification.push({ ...deltaRun.verification[0] });
  assert.equal(review.hasFreshVerification(mutationRun, manifestAfterFix.hash), true);
  writeFileSync(join(repo, "a.ts"), "export const n = 9.1;\n");
  const changedManifest = await baseline.taskArtifactManifest(repo, ["a.ts"]);
  assert.equal(review.hasFreshVerification(mutationRun, changedManifest.hash), false, "successful evidence is stale after a task artifact changes");
  mutationRun.verification.push({ ...deltaRun.verification[0], beforeArtifactManifestHash: changedManifest.hash, artifactManifestHash: changedManifest.hash, createdAt: 3 });
  assert.equal(review.hasFreshVerification(mutationRun, changedManifest.hash), true);
  writeFileSync(join(repo, "a.ts"), "export const n = 9;\n");

  assert.equal(review.compactEvidence([...deltaRun.verification, { ...deltaRun.verification[0], output: "new", createdAt: 2 }], manifestAfterFix.hash).length, 1);
  const chainWithFix = review.reviewChainHash(undefined, { envelopeHash: "e", verdict: "CHANGES_REQUESTED", scope: "delta", coverage: ["diff:a.ts"], resolutions: [{ id: "T1-a", status: "fixed", note: "changed a.ts", evidence: [{ kind: "regression", reference: "a.ts:1" }], artifactPaths: ["a.ts"] }], activeFindings: [] });
  const chainWithOpen = review.reviewChainHash(undefined, { envelopeHash: "e", verdict: "CHANGES_REQUESTED", scope: "delta", coverage: ["diff:a.ts"], resolutions: [{ id: "T1-a", status: "open", note: "still failing", evidence: [{ kind: "regression", reference: "a.ts:1" }], artifactPaths: ["a.ts"] }], activeFindings: [{ id: "T1-a", key: "adjust-rendering", severity: "medium", file: "a.ts", message: "adjust rendering", evidence: [{ kind: "regression", reference: "a.ts:1" }] }] });
  assert.notEqual(chainWithFix, chainWithOpen, "review chains bind remediation resolutions and open findings");
  const fullPacket = packets.fullReviewPacket(deltaRun, { text: Array.from({ length: 6 }, (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n--- a/f${i}.ts\n+++ b/f${i}.ts\n@@\n-${"x".repeat(500)}${i}\n+${"y".repeat(500)}${i + 1}`).join("\n"), hash: "d", paths: Array.from({ length: 6 }, (_, i) => `f${i}.ts`), complete: true }, manifestAfterFix);
  const shards = packets.shardFullReview(fullPacket.packet, 2_000);
  assert.equal(shards.length > 1, true);
  assert.equal(shards.every((shard) => packets.packetBytes(shard.packet) <= 2_000), true);
  const oversizedFile = packets.fullReviewPacket(deltaRun, { text: `diff --git a/huge.ts b/huge.ts\n${"+x".repeat(3_000)}`, hash: "huge", paths: ["huge.ts"], complete: true }, manifestAfterFix);
  assert.throws(() => packets.shardFullReview(oversizedFile.packet, 2_000), /cannot be reviewed atomically/);
  unlinkSync(join(repo, "a.ts"));
  const deletedManifest = await baseline.taskArtifactManifest(repo, ["a.ts"]);
  assert.equal(deletedManifest.entries[0].kind, "missing");
  const deletionSnapshot = await baseline.createReviewSnapshot(repo, dirty, deletedManifest, "deletion");
  assert.equal((await baseline.validateReviewSnapshot(deletionSnapshot)).ok, true, "full-review deletion tombstones remain auditable");
  await baseline.cleanupBaseline(dirty);
}

baselineTest().then(
  () => console.log("workflow tests passed"),
  (error) => { console.error(error); process.exitCode = 1; },
);
