#!/usr/bin/env node
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const Module = require("node:module");

const extensionDir = __dirname;
const localNodeModules = resolve(extensionDir, "../../npm/node_modules");
process.env.NODE_PATH = [localNodeModules, process.env.NODE_PATH].filter(Boolean).join(":");
Module._initPaths();
const jitiModule = process.env.PI_JITI_MODULE || "/home/raja/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti";
if (!existsSync(jitiModule)) throw new Error("Set PI_JITI_MODULE to Pi's jiti package.");
const jiti = require(jitiModule)(__filename, { interopDefault: true });

const configModule = jiti(join(extensionDir, "config.ts"));
const stateModule = jiti(join(extensionDir, "state.ts"));
const baseline = jiti(join(extensionDir, "baseline.ts"));
const verify = jiti(join(extensionDir, "verify.ts"));
const delegation = jiti(join(extensionDir, "delegation.ts"));
const workflowExtension = jiti(join(extensionDir, "index.ts")).default;
const delegationApi = jiti(resolve(localNodeModules, "pi-subagents/src/api/delegation.ts"));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "workflow-lite-test-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "workflow@example.test");
  git(repo, "config", "user.name", "Workflow Test");
  writeFileSync(join(repo, "a.txt"), "base\n");
  writeFileSync(join(repo, "dirty.txt"), "committed\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  return repo;
}

function latestState(entries) {
  return [...entries].reverse().find((entry) => entry.customType === stateModule.WORKFLOW_STATE_TYPE)?.data;
}

class Events {
  constructor() { this.handlers = new Map(); }
  on(name, handler) {
    const list = this.handlers.get(name) || [];
    list.push(handler);
    this.handlers.set(name, list);
    return () => this.handlers.set(name, (this.handlers.get(name) || []).filter((item) => item !== handler));
  }
  emit(name, ...args) {
    for (const handler of [...(this.handlers.get(name) || [])]) handler(...args);
  }
}

function usage() {
  return { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.01, turns: 1, toolCalls: 2, durationMs: 10 };
}

function makeHarness(options = {}) {
  const commands = new Map();
  const tools = new Map();
  const entries = [];
  let branchEntries = entries;
  const notifications = [];
  const messages = [];
  const events = new Events();
  const models = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"].map((id) => ({ provider: "openai-codex", id, reasoning: true }));
  const pi = {
    currentModel: models[1],
    thinking: "xhigh",
    activeTools: ["read", "edit", "write", "bash", "todo", "subagent"],
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(definition) { tools.set(definition.name, definition); if (!this.activeTools.includes(definition.name)) this.activeTools.push(definition.name); },
    on(name, handler) { return events.on(name, handler); },
    events,
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
    getAllTools() { return [...new Set([...this.activeTools, ...tools.keys(), "subagent"])].map((name) => ({ name, sourceInfo: { source: "test" } })); },
    getActiveTools() { return [...this.activeTools]; },
    setActiveTools(names) { this.activeTools = [...new Set(names)]; },
    async setModel(model) {
      if (options.failWriterSelection && model.id === "gpt-5.6-luna") return false;
      this.currentModel = model;
      return true;
    },
    getThinkingLevel() { return this.thinking; },
    setThinkingLevel(level) { this.thinking = level; },
    sendUserMessage(message, sendOptions) { messages.push({ message, options: sendOptions }); },
  };
  const ctx = {
    cwd: "/tmp/fake-workflow-repo",
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => "session-test",
      getBranch: () => branchEntries,
    },
    modelRegistry: { find: (provider, id) => models.find((model) => model.provider === provider && model.id === id) },
    ui: {
      notify: (text, level) => notifications.push({ text, level }),
      setStatus: () => {},
      editor: async () => undefined,
    },
  };
  Object.defineProperty(ctx, "model", { get: () => pi.currentModel });
  let fingerprint = "fp-1";
  let runtimeBookkeepingWrites = 0;
  const fakeBaseline = {
    dir: "/tmp/fake-workflow-baseline/run",
    manifestPath: "/tmp/fake-workflow-baseline/run/manifest.json",
    cwd: ctx.cwd,
    initialHead: "a".repeat(40),
    initialFingerprint: "initial",
    createdAt: 1,
  };
  const dependencies = {
    createBaseline: async (_cwd, _session, runId) => ({ ...fakeBaseline, dir: `/tmp/fake-workflow-baseline/${runId}`, manifestPath: `/tmp/fake-workflow-baseline/${runId}/manifest.json` }),
    collectTaskDiff: async () => ({ text: "diff --git a/a.txt b/a.txt\n-old\n+new\n", hash: "diff", paths: ["a.txt"], complete: true, currentFingerprint: fingerprint, initialHead: fakeBaseline.initialHead, currentHead: fakeBaseline.initialHead }),
    validateBaseline: async () => ({ ok: true }),
    repositoryFingerprint: async () => fingerprint,
    runVerificationSuite: async (input) => ({
      attempt: input.attempt,
      planRevision: input.planRevision,
      status: "passed",
      checks: input.checks.map((check) => ({ ...check, status: "passed", exitCode: 0, outputTail: "ok", outputTruncated: false, durationMs: 1, changedPaths: [], beforeFingerprint: fingerprint, afterFingerprint: fingerprint })),
      repositoryFingerprint: fingerprint,
      startedAt: 1,
      completedAt: 2,
    }),
    runDesign: async () => ({ decision: "keep it small", rationale: "bounded", constraints: [], risks: [], implementationNotes: [], model: "openai-codex/gpt-5.6-sol", usage: usage(), createdAt: Date.now() }),
    runReview: async (input) => {
      if (options.reviewError) throw options.reviewError;
      if (options.reviewWritesBookkeeping) runtimeBookkeepingWrites += 1;
      const verdict = options.reviewVerdict || "APPROVE";
      const findings = options.reviewFindings ?? (verdict === "CHANGES_REQUESTED" ? [{ id: "R1", severity: "P1", title: "fix it", evidence: "a.txt:1", smallestFix: "adjust" }] : []);
      return { verdict, summary: "reviewed", findings, repositoryFingerprint: input.repositoryFingerprint, model: "openai-codex/gpt-5.6-terra", usage: usage(), createdAt: Date.now() };
    },
    subagentsAvailable: () => true,
  };
  workflowExtension(pi, dependencies);
  return {
    pi,
    ctx,
    commands,
    tools,
    entries,
    notifications,
    messages,
    events,
    setFingerprint(value) { fingerprint = value; },
    recordRuntimeBookkeeping() { runtimeBookkeepingWrites += 1; },
    runtimeBookkeepingWrites() { return runtimeBookkeepingWrites; },
    setBranch(value) { branchEntries = value; },
  };
}

(async () => {
  const loadedConfig = configModule.loadConfig();
  assert.equal(loadedConfig.version, 1);
  assert.equal(loadedConfig.models.writer, "openai-codex/gpt-5.6-luna");
  assert.equal(loadedConfig.maxChecks, 8);

  const dummyBaseline = { dir: "/tmp/x", manifestPath: "/tmp/x/manifest", cwd: "/tmp", initialHead: "a".repeat(40), initialFingerprint: "f", createdAt: 1 };
  const fresh = stateModule.newRun("task", "standard", dummyBaseline, "run-1");
  assert.equal(fresh.stage, "planning");
  assert.equal(stateModule.newRun("task", "design", dummyBaseline, "run-2").stage, "designing");
  assert.equal(stateModule.expectedNext(fresh), "Call workflow_plan with acceptance criteria, steps, and final checks.");
  assert.equal(stateModule.restoreState([{ type: "custom", customType: "workflow-state", data: { version: 6, enabled: true } }]).run, undefined, "legacy state is ignored");
  const interrupted = { version: 1, run: { ...fresh, stage: "verifying" }, updatedAt: 2 };
  assert.equal(stateModule.restoreState([{ type: "custom", customType: stateModule.WORKFLOW_STATE_TYPE, data: interrupted }]).run.stage, "implementing");
  const interruptedReview = { version: 1, run: { ...fresh, stage: "reviewing", reviewStarted: true }, updatedAt: 2 };
  assert.equal(stateModule.restoreState([{ type: "custom", customType: stateModule.WORKFLOW_STATE_TYPE, data: interruptedReview }]).run.stage, "failed");

  const repo = makeRepo();
  writeFileSync(join(repo, "dirty.txt"), "dirty at start\n");
  writeFileSync(join(repo, "preexisting.txt"), "keep me\n");
  const baselineRef = await baseline.createBaseline(repo, "session", "run");
  let diff = await baseline.collectTaskDiff(repo, baselineRef);
  assert.equal(diff.complete, true);
  assert.deepEqual(diff.paths, [], "unchanged intake dirt is excluded");
  writeFileSync(join(repo, "a.txt"), "changed\n");
  writeFileSync(join(repo, "dirty.txt"), "dirty after\n");
  writeFileSync(join(repo, "new.txt"), "new\n");
  diff = await baseline.collectTaskDiff(repo, baselineRef);
  assert.deepEqual(diff.paths, ["a.txt", "dirty.txt", "new.txt"]);
  assert.match(diff.text, /dirty at start/);
  assert.doesNotMatch(diff.text, /committed/);
  assert.doesNotMatch(diff.text, /preexisting\.txt/);
  assert.equal((await baseline.validateBaseline(repo, baselineRef)).ok, true);
  const committedDiffRepo = makeRepo();
  const committedDiffRef = await baseline.createBaseline(committedDiffRepo, "session", "committed");
  writeFileSync(join(committedDiffRepo, "a.txt"), "committed change\n");
  git(committedDiffRepo, "add", "a.txt");
  git(committedDiffRepo, "commit", "-qm", "workflow change");
  const committedDiff = await baseline.collectTaskDiff(committedDiffRepo, committedDiffRef);
  assert.deepEqual(committedDiff.paths, ["a.txt"], "committed task changes are compared with the run-start HEAD");
  assert.match(committedDiff.text, /committed change/);
  const committedRenameRepo = makeRepo();
  const committedRenameRef = await baseline.createBaseline(committedRenameRepo, "session", "rename");
  git(committedRenameRepo, "mv", "a.txt", "renamed.txt");
  git(committedRenameRepo, "commit", "-qm", "workflow rename");
  const committedRenameDiff = await baseline.collectTaskDiff(committedRenameRepo, committedRenameRef);
  assert.deepEqual(committedRenameDiff.paths, ["a.txt", "renamed.txt"], "committed renames include both task-local paths");
  assert.match(committedRenameDiff.text, /a\/a\.txt/);
  assert.match(committedRenameDiff.text, /b\/renamed\.txt/);
  const specialPathRepo = makeRepo();
  const specialPathRef = await baseline.createBaseline(specialPathRepo, "session", "special-path");
  writeFileSync(join(specialPathRepo, "dollar$&.txt"), "special path\n");
  const specialPathDiff = await baseline.collectTaskDiff(specialPathRepo, specialPathRef);
  assert.deepEqual(specialPathDiff.paths, ["dollar$&.txt"]);
  assert.match(specialPathDiff.text, /b\/dollar\$&\.txt/);
  const corruptRepo = makeRepo();
  writeFileSync(join(corruptRepo, "dirty.txt"), "dirty baseline\n");
  const corruptRef = await baseline.createBaseline(corruptRepo, "session", "corrupt");
  const corruptManifest = JSON.parse(readFileSync(corruptRef.manifestPath, "utf8"));
  writeFileSync(join(corruptRef.dir, corruptManifest.entries["dirty.txt"].snapshot), "tampered\n");
  assert.match((await baseline.validateBaseline(corruptRepo, corruptRef)).reason, /hash/);

  const runtimeRepo = makeRepo();
  mkdirSync(join(runtimeRepo, ".pi", "agent", "missions", "existing"), { recursive: true });
  writeFileSync(join(runtimeRepo, ".pi", "agent", "run-history.jsonl"), "before\n");
  writeFileSync(join(runtimeRepo, ".pi", "agent", "missions", "existing", "state.json"), "before\n");
  const runtimeRef = await baseline.createBaseline(runtimeRepo, "session", "runtime");
  const runtimeFingerprint = await baseline.repositoryFingerprint(runtimeRepo);
  writeFileSync(join(runtimeRepo, ".pi", "agent", "run-history.jsonl"), "after\n");
  mkdirSync(join(runtimeRepo, ".pi", "agent", "missions", "review"), { recursive: true });
  writeFileSync(join(runtimeRepo, ".pi", "agent", "missions", "review", "state.json"), "review bookkeeping\n");
  assert.equal(await baseline.repositoryFingerprint(runtimeRepo), runtimeFingerprint, "pi-subagents runtime bookkeeping is excluded from fingerprints");
  git(runtimeRepo, "add", ".pi");
  assert.equal(await baseline.repositoryFingerprint(runtimeRepo), runtimeFingerprint, "staged runtime bookkeeping is excluded from fingerprints");
  git(runtimeRepo, "reset", "-q");
  git(runtimeRepo, "add", ".pi");
  git(runtimeRepo, "commit", "-qm", "subagent runtime bookkeeping");
  assert.equal(await baseline.repositoryFingerprint(runtimeRepo), runtimeFingerprint, "a bookkeeping-only commit is also excluded from fingerprints");
  diff = await baseline.collectTaskDiff(runtimeRepo, runtimeRef);
  assert.deepEqual(diff.paths, [], "runtime bookkeeping is excluded from task-local review evidence");
  writeFileSync(join(runtimeRepo, "a.txt"), "task source change\n");
  diff = await baseline.collectTaskDiff(runtimeRepo, runtimeRef);
  assert.deepEqual(diff.paths, ["a.txt"], "source changes remain covered when runtime bookkeeping changes too");
  const otherPiRepo = makeRepo();
  const otherPiRef = await baseline.createBaseline(otherPiRepo, "session", "other-pi");
  mkdirSync(join(otherPiRepo, ".pi", "agent"), { recursive: true });
  writeFileSync(join(otherPiRepo, ".pi", "agent", "settings.json"), "source configuration\n");
  const otherPiDiff = await baseline.collectTaskDiff(otherPiRepo, otherPiRef);
  assert.deepEqual(otherPiDiff.paths, [".pi/agent/settings.json"], "non-bookkeeping .pi paths remain covered");

  const verifyRepo = makeRepo();
  const verifyDir = mkdtempSync(join(tmpdir(), "workflow-verify-test-"));
  let record = await verify.runVerificationSuite({
    cwd: verifyRepo,
    runDir: verifyDir,
    planRevision: 1,
    attempt: 1,
    checks: [{ id: "V1.1", label: "pass", command: "printf ok" }, { id: "V1.2", label: "also pass", command: "test -f a.txt" }],
    commandTimeoutMs: 5_000,
    maxOutputBytes: 1024,
  });
  assert.equal(record.status, "passed");
  assert.deepEqual(record.checks.map((check) => check.status), ["passed", "passed"]);

  record = await verify.runVerificationSuite({
    cwd: verifyRepo,
    runDir: verifyDir,
    planRevision: 1,
    attempt: 2,
    checks: [{ id: "V1.1", label: "subagent runtime bookkeeping", command: "mkdir -p .pi/agent/missions/review; printf review > .pi/agent/run-history.jsonl; printf state > .pi/agent/missions/review/state.json" }],
    commandTimeoutMs: 5_000,
    maxOutputBytes: 1024,
  });
  assert.equal(record.status, "passed", "pi-subagents bookkeeping does not make controller verification look mutated");
  assert.deepEqual(record.checks[0].changedPaths, []);

  record = await verify.runVerificationSuite({
    cwd: verifyRepo,
    runDir: verifyDir,
    planRevision: 1,
    attempt: 3,
    checks: [{ id: "V1.1", label: "fail", command: "printf nope >&2; exit 7" }, { id: "V1.2", label: "skip", command: "true" }],
    commandTimeoutMs: 5_000,
    maxOutputBytes: 1024,
  });
  assert.equal(record.status, "failed");
  assert.equal(record.checks[0].exitCode, 7);
  assert.equal(record.checks[1].status, "not_run");
  assert.match(record.checks[0].outputTail, /nope/);

  record = await verify.runVerificationSuite({
    cwd: verifyRepo,
    runDir: verifyDir,
    planRevision: 1,
    attempt: 4,
    checks: [{ id: "V1.1", label: "mutate", command: "printf changed > a.txt" }],
    commandTimeoutMs: 5_000,
    maxOutputBytes: 1024,
  });
  assert.equal(record.status, "mutated");
  assert.deepEqual(record.checks[0].changedPaths, ["a.txt"]);

  writeFileSync(join(verifyRepo, "a.txt"), "base\n");
  record = await verify.runVerificationSuite({
    cwd: verifyRepo,
    runDir: verifyDir,
    planRevision: 1,
    attempt: 5,
    checks: [{ id: "V1.1", label: "large output", command: "python3 -c 'print(\"x\" * 5000)'" }],
    commandTimeoutMs: 5_000,
    maxOutputBytes: 128,
  });
  assert.equal(record.status, "passed");
  assert.equal(record.checks[0].outputTruncated, true);
  assert.ok(Buffer.byteLength(record.checks[0].outputTail) <= 128);

  record = await verify.runVerificationSuite({
    cwd: verifyRepo,
    runDir: verifyDir,
    planRevision: 1,
    attempt: 6,
    checks: [{ id: "V1.1", label: "timeout", command: "sleep 2" }],
    commandTimeoutMs: 50,
    maxOutputBytes: 1024,
  });
  assert.equal(record.status, "failed");
  assert.equal(record.checks[0].status, "timed_out");

  const cancellation = new AbortController();
  cancellation.abort(new Error("stop verification"));
  record = await verify.runVerificationSuite({
    cwd: verifyRepo,
    runDir: verifyDir,
    planRevision: 1,
    attempt: 7,
    checks: [{ id: "V1.1", label: "cancelled", command: "printf should-not-run > cancelled.txt" }],
    commandTimeoutMs: 5_000,
    maxOutputBytes: 1024,
    signal: cancellation.signal,
  });
  assert.equal(record.status, "cancelled");
  assert.equal(record.checks[0].status, "cancelled");
  assert.equal(existsSync(join(verifyRepo, "cancelled.txt")), false);

  const runningCancellation = new AbortController();
  const cancellationStartedAt = Date.now();
  setTimeout(() => runningCancellation.abort(new Error("stop running verification")), 50).unref();
  record = await verify.runVerificationSuite({
    cwd: verifyRepo,
    runDir: verifyDir,
    planRevision: 1,
    attempt: 8,
    checks: [{ id: "V1.1", label: "cancel while descendant ignores TERM", command: "(trap '' TERM; exec sleep 10) & sleep 10" }, { id: "V1.2", label: "not started", command: "true" }],
    commandTimeoutMs: 5_000,
    maxOutputBytes: 1024,
    signal: runningCancellation.signal,
  });
  assert.equal(record.status, "cancelled");
  assert.deepEqual(record.checks.map((check) => check.status), ["cancelled", "not_run"]);
  assert.ok(Date.now() - cancellationStartedAt < 5_000, "a TERM-ignoring descendant is hard-killed instead of hanging verification");

  const exitedLeaderStartedAt = Date.now();
  record = await verify.runVerificationSuite({
    cwd: verifyRepo,
    runDir: verifyDir,
    planRevision: 1,
    attempt: 9,
    checks: [{ id: "V1.1", label: "timeout after shell leader exits", command: "trap '' TERM; sleep 10 & exit 0" }],
    commandTimeoutMs: 50,
    maxOutputBytes: 1024,
  });
  assert.equal(record.status, "failed");
  assert.equal(record.checks[0].status, "timed_out");
  assert.ok(Date.now() - exitedLeaderStartedAt < 5_000, "timeout also kills descendants after the shell leader exits");

  const bus = new Events();
  const fakePi = { events: bus, getAllTools: () => [{ name: "subagent" }] };
  bus.on(delegationApi.SUBAGENT_DELEGATION_REQUEST_EVENT, (request) => {
    bus.emit(delegationApi.SUBAGENT_DELEGATION_UPDATE_EVENT, null);
    bus.emit(delegationApi.SUBAGENT_DELEGATION_UPDATE_EVENT, { requestId: request.requestId, ownerRunId: request.ownerRunId, nodeId: request.nodeId, durationMs: 10, currentTool: "read" });
    bus.emit(delegationApi.SUBAGENT_DELEGATION_RESPONSE_EVENT, null);
    // A requestId alone must not be able to resolve a structured delegation.
    bus.emit(delegationApi.SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      requestId: request.requestId,
      status: "completed",
      result: { kind: "structured", value: { decision: "spoofed", rationale: "wrong identity", constraints: [], risks: [], implementationNotes: [] } },
    });
    bus.emit(delegationApi.SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      requestId: request.requestId,
      ownerRunId: request.ownerRunId,
      nodeId: request.nodeId,
      status: "completed",
      result: { kind: "structured", value: { decision: "small", rationale: "simple", constraints: [], risks: [], implementationNotes: [] } },
      model: "openai-codex/gpt-5.6-sol",
      thinking: "xhigh",
      usage: usage(),
    });
  });
  let progressSeen = false;
  const design = await delegation.runDesign({ pi: fakePi, ctx: { cwd: repo }, ownerRunId: "r", nodeId: "design", agent: "workflow-architect", task: "design", model: "openai-codex/gpt-5.6-sol", thinking: "xhigh", timeoutMs: 1000, onProgress: () => { progressSeen = true; } });
  assert.equal(design.decision, "small");
  assert.equal(progressSeen, true);
  assert.equal(delegation.usageForPi(design.usage).totalTokens, 10);

  const rejectedWriter = makeHarness({ failWriterSelection: true });
  await rejectedWriter.commands.get("workflow").handler("cannot start", rejectedWriter.ctx);
  assert.equal(latestState(rejectedWriter.entries), undefined, "failed writer activation must not leave an active run");
  assert.equal(rejectedWriter.pi.currentModel.id, "gpt-5.6-terra");
  assert.equal(rejectedWriter.pi.activeTools.includes("subagent"), true);

  const branchSwitch = makeHarness();
  await branchSwitch.commands.get("workflow").handler("switch away", branchSwitch.ctx);
  assert.equal(branchSwitch.pi.currentModel.id, "gpt-5.6-luna");
  assert.equal(branchSwitch.pi.activeTools.includes("subagent"), false);
  branchSwitch.setBranch([]);
  branchSwitch.events.emit("session_tree", {}, branchSwitch.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(branchSwitch.pi.currentModel.id, "gpt-5.6-terra", "leaving an active workflow branch restores its prior model");
  assert.equal(branchSwitch.pi.activeTools.includes("subagent"), true, "leaving an active workflow branch restores its direct delegation tool");

  const harness = makeHarness({ reviewWritesBookkeeping: true });
  await harness.commands.get("workflow").handler("implement a small feature", harness.ctx);
  assert.match(harness.messages[0].message, /^\/skill:workflow-delivery Workflow mode: standard/);
  assert.equal(harness.pi.currentModel.id, "gpt-5.6-luna");
  await harness.pi.setModel(harness.ctx.modelRegistry.find("openai-codex", "gpt-5.6-terra"));
  harness.events.emit("session_tree", {}, harness.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.pi.currentModel.id, "gpt-5.6-luna", "an active restored run reselects its writer");
  assert.equal(harness.pi.activeTools.includes("subagent"), false);
  assert.equal(harness.pi.activeTools.includes("bash"), true, "normal Luna tools remain available");
  let run = latestState(harness.entries).run;
  assert.equal(run.stage, "planning");
  await assert.rejects(() => harness.tools.get("workflow_plan").execute("plan", {
    expectedRevision: 0,
    summary: "   ",
    acceptanceCriteria: ["behavior works"],
    steps: ["edit the file"],
    checks: [{ label: "tests", command: "npm test" }],
  }, new AbortController().signal, undefined, harness.ctx), /Plan summary cannot be blank/);
  await harness.tools.get("workflow_plan").execute("plan", {
    expectedRevision: 0,
    summary: "small plan",
    acceptanceCriteria: ["behavior works"],
    steps: ["edit the file"],
    checks: [{ label: "tests", command: " npm test " }],
  }, new AbortController().signal, undefined, harness.ctx);
  run = latestState(harness.entries).run;
  assert.equal(run.stage, "implementing");
  assert.equal(run.plan.checks[0].id, "V1.1");
  assert.equal(run.plan.checks[0].command, " npm test ", "verification commands are stored exactly as declared");
  await harness.tools.get("workflow_verify").execute("verify", {}, new AbortController().signal, undefined, harness.ctx);
  assert.equal(latestState(harness.entries).run.stage, "reviewing");
  const reviewResult = await harness.tools.get("workflow_review").execute("review", {}, new AbortController().signal, undefined, harness.ctx);
  assert.equal(reviewResult.details.completed, true);
  assert.equal(harness.runtimeBookkeepingWrites(), 1, "bookkeeping written by an approving reviewer does not stale its fingerprint");
  assert.equal(latestState(harness.entries).run.stage, "completed");
  assert.equal(harness.pi.currentModel.id, "gpt-5.6-terra", "prior model is restored after completion");
  assert.equal(harness.pi.activeTools.includes("subagent"), true);
  assert.equal(latestState(harness.entries).prior, undefined, "restoration is recorded so terminal session events do not re-enable tools later");

  const remediation = makeHarness({ reviewVerdict: "CHANGES_REQUESTED", reviewWritesBookkeeping: true });
  await remediation.commands.get("workflow").handler("fix behavior", remediation.ctx);
  await remediation.tools.get("workflow_plan").execute("plan", { expectedRevision: 0, summary: "fix", acceptanceCriteria: ["fixed"], steps: ["edit"], checks: [{ label: "test", command: "npm test" }] }, new AbortController().signal, undefined, remediation.ctx);
  await remediation.tools.get("workflow_verify").execute("verify", {}, new AbortController().signal, undefined, remediation.ctx);
  await remediation.tools.get("workflow_review").execute("review", {}, new AbortController().signal, undefined, remediation.ctx);
  assert.equal(remediation.runtimeBookkeepingWrites(), 1, "reviewer bookkeeping is modeled separately from task changes");
  assert.equal(latestState(remediation.entries).run.stage, "fixing");
  remediation.recordRuntimeBookkeeping();
  await assert.rejects(() => remediation.tools.get("workflow_verify").execute("verify-bookkeeping", {}, new AbortController().signal, undefined, remediation.ctx), /repository has not changed since review/);
  assert.equal(latestState(remediation.entries).run.stage, "fixing", "bookkeeping-only changes do not satisfy remediation");
  remediation.setFingerprint("fp-2");
  const remediationResult = await remediation.tools.get("workflow_verify").execute("verify-2", {}, new AbortController().signal, undefined, remediation.ctx);
  assert.equal(remediationResult.details.status, "completed_after_fixes");
  assert.equal(latestState(remediation.entries).run.stage, "completed_after_fixes");

  const designed = makeHarness();
  await designed.commands.get("workflow").handler("--design migrate the API", designed.ctx);
  await assert.rejects(() => designed.tools.get("workflow_plan").execute("plan", { expectedRevision: 0, summary: "x", acceptanceCriteria: ["x"], steps: ["x"], checks: [{ label: "x", command: "true" }] }, new AbortController().signal, undefined, designed.ctx), /workflow_design/);
  await designed.tools.get("workflow_design").execute("design", {}, new AbortController().signal, undefined, designed.ctx);
  assert.equal(latestState(designed.entries).run.stage, "planning");

  const p2Only = makeHarness({ reviewVerdict: "CHANGES_REQUESTED", reviewFindings: [{ id: "N1", severity: "P2", title: "note", evidence: "a.txt:1", smallestFix: "optional cleanup" }] });
  await p2Only.commands.get("workflow").handler("note-only review", p2Only.ctx);
  await p2Only.tools.get("workflow_plan").execute("plan", { expectedRevision: 0, summary: "note", acceptanceCriteria: ["works"], steps: ["edit"], checks: [{ label: "test", command: "npm test" }] }, new AbortController().signal, undefined, p2Only.ctx);
  await p2Only.tools.get("workflow_verify").execute("verify", {}, new AbortController().signal, undefined, p2Only.ctx);
  const p2Result = await p2Only.tools.get("workflow_review").execute("review", {}, new AbortController().signal, undefined, p2Only.ctx);
  assert.equal(p2Result.details.verdict, "APPROVE");
  assert.equal(latestState(p2Only.entries).run.stage, "completed");

  const preabortedReview = makeHarness();
  await preabortedReview.commands.get("workflow").handler("preemptive review cancellation", preabortedReview.ctx);
  await preabortedReview.tools.get("workflow_plan").execute("plan", { expectedRevision: 0, summary: "cancel", acceptanceCriteria: ["works"], steps: ["edit"], checks: [{ label: "test", command: "npm test" }] }, new AbortController().signal, undefined, preabortedReview.ctx);
  await preabortedReview.tools.get("workflow_verify").execute("verify", {}, new AbortController().signal, undefined, preabortedReview.ctx);
  const preabortedSignal = new AbortController();
  preabortedSignal.abort(new Error("cancel before dispatch"));
  await assert.rejects(() => preabortedReview.tools.get("workflow_review").execute("review", {}, preabortedSignal.signal, undefined, preabortedReview.ctx), /cancel before dispatch/);
  assert.equal(latestState(preabortedReview.entries).run.stage, "reviewing");
  assert.equal(latestState(preabortedReview.entries).run.reviewStarted, undefined, "an unstarted review remains available");

  const reviewFailure = makeHarness({ reviewError: new Error("review bridge failed") });
  await reviewFailure.commands.get("workflow").handler("review failure", reviewFailure.ctx);
  await reviewFailure.tools.get("workflow_plan").execute("plan", { expectedRevision: 0, summary: "failure", acceptanceCriteria: ["works"], steps: ["edit"], checks: [{ label: "test", command: "npm test" }] }, new AbortController().signal, undefined, reviewFailure.ctx);
  await reviewFailure.tools.get("workflow_verify").execute("verify", {}, new AbortController().signal, undefined, reviewFailure.ctx);
  await assert.rejects(() => reviewFailure.tools.get("workflow_review").execute("review", {}, new AbortController().signal, undefined, reviewFailure.ctx), /review bridge failed/);
  assert.equal(latestState(reviewFailure.entries).run.stage, "failed");
  assert.equal(reviewFailure.pi.currentModel.id, "gpt-5.6-terra", "failed review also restores the original model");
  await assert.rejects(() => reviewFailure.tools.get("workflow_review").execute("review-again", {}, new AbortController().signal, undefined, reviewFailure.ctx), /No active workflow run/);

  console.log("workflow tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
