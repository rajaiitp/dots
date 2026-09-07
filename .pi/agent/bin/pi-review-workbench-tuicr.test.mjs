import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "ordinary-tuicr-launcher-test-"));
const repo = join(root, "repo");
const data = join(root, "data");
const state = join(root, "state");
const fakeTuicr = join(root, "tuicr");
const argsOutput = join(root, "args.txt");
const paneId = "launcher-test-pane";
const runId = "ordinary-launcher-test";

try {
  process.env.XDG_DATA_HOME = data;
  process.env.XDG_STATE_HOME = state;
  await execFileAsync("git", ["init", "--quiet", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "test"]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  await writeFile(join(repo, "example.txt"), "base\n");
  await execFileAsync("git", ["-C", repo, "add", "example.txt"]);
  await execFileAsync("git", ["-C", repo, "commit", "--quiet", "-m", "base"]);

  const { ChangeControlCoordinator } = await import("/home/raja/Projects/pi-workbench/packages/pi-review-workbench/change-control/coordinator.mjs");
  const coordinator = new ChangeControlCoordinator({ env: process.env });
  const created = await coordinator.createRun({ sourceRepository: repo, runId });
  await writeFile(join(created.run.stagingDirectory, "example.txt"), "changed\n");
  await coordinator.captureSnapshot(runId, { kind: "prompt", label: "make a change", force: true });
  await execFileAsync("git", ["-C", created.run.stagingDirectory, "read-tree", "--reset", "-u", created.run.baseOid]);
  await coordinator.captureSnapshot(runId, { kind: "prompt", label: "return to baseline", force: true });
  const range = await coordinator.promptReviewRange(runId);
  assert.ok(range?.firstOid && range.latestOid && range.baseOid);
  const aggregate = await execFileAsync("git", [
    `--git-dir=${created.run.privateGitDirectory}`, "diff", "--quiet", `${range.firstOid}^`, range.latestOid,
  ]).then(() => 0, (error) => error.code);
  assert.equal(aggregate, 0, "fixture must have an empty aggregate diff");

  const locator = createHash("sha256").update(paneId).digest("hex");
  const ordinaryState = join(state, "pi-review-workbench", "ordinary");
  await mkdir(ordinaryState, { recursive: true });
  await writeFile(join(ordinaryState, `${locator}.json`), `${JSON.stringify({
    version: 1,
    sessionId: "launcher-test-session",
    paneId,
    sourceRepository: repo,
    runId,
    run: created.run,
    lastCapturedSequence: 2,
  })}\n`);
  await writeFile(fakeTuicr, "#!/bin/sh\nprintf '%s\\n' \"$@\" >\"$ARGS_OUTPUT\"\n");
  await chmod(fakeTuicr, 0o755);

  await execFileAsync(process.execPath, ["/home/raja/dots/.pi/agent/bin/pi-review-workbench-tuicr.mjs"], {
    cwd: repo,
    env: {
      ...process.env,
      HERDR_ACTIVE_PANE_ID: paneId,
      TUICR_BIN: fakeTuicr,
      ARGS_OUTPUT: argsOutput,
      XDG_DATA_HOME: data,
      XDG_STATE_HOME: state,
    },
  });
  const args = (await readFile(argsOutput, "utf8")).trim().split("\n");
  assert.deepEqual(args, [
    "-w", "--no-update-check", "--single-prompt",
    "-r", `${range.firstOid}^..${range.latestOid}`,
    "--single-prompt-baseline", range.baseOid,
  ]);
  console.log("ordinary tuicr zero-net prompt-history launcher test passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
