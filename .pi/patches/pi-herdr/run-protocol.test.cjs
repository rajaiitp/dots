#!/usr/bin/env node
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join, resolve } = require("node:path");

const packageDir = process.env.PI_HERDR_PACKAGE_DIR || resolve(__dirname, "../../agent/npm/node_modules/@weshipwork/pi-herdr");
const jitiModule = process.env.PI_JITI_MODULE;
if (!jitiModule || !existsSync(jitiModule)) {
  throw new Error("PI_JITI_MODULE must point to Pi's jiti package for this test harness.");
}
const jiti = require(jitiModule)(join(packageDir, "tests", "jiti-entry.cjs"), { interopDefault: true });
const protocol = jiti(join(packageDir, "extensions", "herdr-run-protocol.ts"));
const { handlePaneAction } = jiti(join(packageDir, "extensions", "herdr-pane-actions.ts"));

function idleZsh() {
  return {
    pane_id: "pane-1",
    shell_pid: 10,
    foreground_processes: [{ argv: ["/usr/bin/zsh"], name: "zsh", pid: 10 }],
  };
}

for (const shell of ["bash", "zsh"]) {
  const command = "printf 'quoted: %s\\n' \"it's safe\"; false";
  const run = protocol.createCommandProtocol(command, shell, `token-${shell}`);
  assert.equal(run.wrappedCommand.includes(run.donePrefix), false, "echoed wrapper must not contain full done marker");
  const output = execFileSync(shell, ["-c", run.wrappedCommand], { encoding: "utf8" });
  const completion = protocol.parseCompletion(output, run.token);
  assert.equal(completion.exitCode, 1);
  assert.deepEqual(protocol.extractCommandOutput(output, run.token), {
    text: "quoted: it's safe",
    beginFound: true,
    doneFound: true,
  });
}

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
  const calls = { exec: [], wait: 0, read: 0, compress: 0 };
  const runtime = {
    signal: undefined,
    currentWorkspaceId: "workspace-1",
    runRegistry: new protocol.PaneRunRegistry(),
    requirePaneRef: async () => ({ pane: { pane_id: "pane-1" }, alias: "test" }),
    withSnapshot: (details) => ({ ...details, aliases: {}, aliasOrder: [] }),
    client: {
      getPaneProcessInfo: async () => idleZsh(),
      exec: async (args) => { calls.exec.push(args); },
      waitForPaneOutput: async (_pane, donePrefix) => {
        calls.wait += 1;
        const token = /:([^:]+):$/.exec(donePrefix)[1];
        return {
          matched_line: `${donePrefix}7`,
          read: {
            text: `__PI_HERDR_BEGIN__:${token}\nfinal result\n__PI_HERDR_DONE__:${token}:7\n`,
            truncated: false,
          },
        };
      },
      readPane: async () => { calls.read += 1; return ""; },
      compressShellOutput: async () => { calls.compress += 1; return ""; },
    },
  };
  const result = await handlePaneAction({ action: "run", pane: "test", command: "false", compression: "never" }, runtime);
  assert.equal(calls.exec.length, 1);
  assert.equal(calls.wait, 1);
  assert.equal(calls.read, 0, "normal waiting run must not perform an eager/fallback read");
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
