#!/usr/bin/env node
const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const packageDir = process.env.PI_HERDR_PACKAGE_DIR || resolve(__dirname, "../../agent/npm/node_modules/@weshipwork/pi-herdr");
const jitiModule = process.env.PI_JITI_MODULE;
const agentPackageDir = process.env.PI_CODING_AGENT_PACKAGE_DIR;
if (!jitiModule || !existsSync(jitiModule)) {
  throw new Error("PI_JITI_MODULE must point to Pi's jiti package for this test harness.");
}
if (!agentPackageDir || !existsSync(agentPackageDir)) {
  throw new Error("PI_CODING_AGENT_PACKAGE_DIR must point to Pi's package directory.");
}
const piCodingAgentTools = join(agentPackageDir, "dist", "core", "tools", "truncate.js");
const piAiStringEnum = join(
  agentPackageDir,
  "node_modules",
  "@earendil-works",
  "pi-ai",
  "dist",
  "utils",
  "typebox-helpers.js",
);
const typeboxEntry = require.resolve("typebox", { paths: [agentPackageDir] });
const typeboxCompileEntry = require.resolve("typebox/compile", { paths: [agentPackageDir] });
const typeboxValueEntry = require.resolve("typebox/value", { paths: [agentPackageDir] });
const jiti = require(jitiModule)(join(packageDir, "tests", "jiti-entry.cjs"), {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-coding-agent": piCodingAgentTools,
    "@earendil-works/pi-ai": piAiStringEnum,
    "typebox/compile": typeboxCompileEntry,
    "typebox/value": typeboxValueEntry,
    typebox: typeboxEntry,
  },
});
const protocol = jiti(join(packageDir, "extensions", "herdr-run-protocol.ts"));
const paneActionsPath = join(packageDir, "extensions", "herdr-pane-actions.ts");
const { handlePaneAction } = jiti(paneActionsPath);
const paneActionsSource = readFileSync(paneActionsPath, "utf8");
const runCaseSource = paneActionsSource.slice(
  paneActionsSource.indexOf("case HERDR_ACTION.RUN"),
  paneActionsSource.indexOf("case HERDR_ACTION.READ"),
);
assert.doesNotMatch(
  runCaseSource,
  /setInterval|\bsleep\(|waitForPaneOutput|__PI_HERDR_/,
  "run must use native semantic completion without timers, polling, or visible marker wrappers",
);
assert.match(runCaseSource, /runPaneCommand/, "run must delegate to Herdr's atomic semantic command API");

function idleZsh() {
  return {
    pane_id: "pane-1",
    shell_pid: 10,
    foreground_processes: [{ argv: ["/usr/bin/zsh"], name: "zsh", pid: 10 }],
  };
}

assert.match(protocol.createRunToken(), /^[A-Za-z0-9_-]{20,}$/);
assert.equal(
  protocol.stripTerminalControlSequences("\x1b]2;command title\x07\x1b[0 qvisible\r\n"),
  "visible\r\n",
);

assert.equal(protocol.getIdleSupportedShell(idleZsh()).name, "zsh");
assert.equal(protocol.getIdleSupportedShell({ ...idleZsh(), foreground_processes: [{ name: "nvim", pid: 11 }] }), undefined);
assert.equal(protocol.shouldAutoCompress("line\n".repeat(300)), true);
assert.equal(protocol.shouldAutoCompress("small output"), false);

const registry = new protocol.PaneRunRegistry();
registry.reserveWaiting("pane-1", "token");
assert.throws(() => registry.reserveWaiting("pane-1", "other"), /already has a command/);
registry.markPossiblyRunning("pane-1", "token", "timed_out");
assert.match(registry.get("pane-1").kind, /possibly-running/);
registry.clearIfShellIsIdle("pane-1", idleZsh());
assert.equal(registry.get("pane-1"), undefined);

async function runActionTest() {
  const calls = { exec: [], run: [], wait: 0, read: 0, compress: 0 };
  const runtime = {
    signal: undefined,
    currentWorkspaceId: "workspace-1",
    runRegistry: new protocol.PaneRunRegistry(),
    requirePaneRef: async () => ({ pane: { pane_id: "pane-1" }, alias: "test" }),
    withSnapshot: (details) => ({ ...details, aliases: {}, aliasOrder: [] }),
    client: {
      getPaneProcessInfo: async () => idleZsh(),
      exec: async (args) => { calls.exec.push(args); },
      runPaneCommand: async (paneId, command, timeout) => {
        calls.run.push({ paneId, command, timeout });
        return {
          pane_id: paneId,
          sequence: 1,
          exit_code: 7,
          output: "final result\n",
          truncated: false,
        };
      },
      waitForPaneOutput: async () => { calls.wait += 1; throw new Error("unexpected wait"); },
      readPane: async () => { calls.read += 1; return ""; },
      compressShellOutput: async () => { calls.compress += 1; return ""; },
    },
  };
  const result = await handlePaneAction({ action: "run", pane: "test", command: "false", compression: "never" }, runtime);
  assert.equal(calls.exec.length, 0);
  assert.deepEqual(calls.run, [{ paneId: "pane-1", command: "false", timeout: 120_000 }]);
  assert.equal(calls.wait, 0);
  assert.equal(calls.read, 0, "normal waiting run must not perform pane reads");
  assert.equal(calls.compress, 0);
  assert.match(result.content[0].text, /exited with code 7/);
  assert.match(result.content[0].text, /final result/);

  const detached = await handlePaneAction({ action: "run", pane: "test", command: "sleep 30", detached: true }, {
    ...runtime,
    runRegistry: new protocol.PaneRunRegistry(),
  });
  assert.equal(detached.details.detached, true);

  let watchArgs;
  await handlePaneAction({ action: "watch", pane: "test", match: "ready", timeout: 1_000 }, {
    ...runtime,
    client: {
      ...runtime.client,
      json: async (args) => {
        watchArgs = args;
        return { result: { matched_line: "ready", read: { text: "ready", truncated: false } } };
      },
    },
  });
  assert.deepEqual(watchArgs.slice(0, 2), ["pane", "wait-output"]);
}

runActionTest().then(
  () => console.log("pi-herdr run protocol tests passed"),
  (error) => { console.error(error); process.exitCode = 1; },
);
