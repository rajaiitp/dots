import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "ordinary-tuicr-test-"));
const repo = join(root, "repo");
const stateHome = join(root, "state");
const dataHome = join(root, "data");
await execFileAsync("git", ["init", "--quiet", repo]);
await execFileAsync("git", ["-C", repo, "config", "user.name", "test"]);
await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
await writeFile(join(repo, "example.txt"), "one\n");
await writeFile(join(repo, ".gitignore"), ".pi/agent/sessions/\n.pi/agent/pi-quota-status/\n");
await execFileAsync("git", ["-C", repo, "add", "example.txt", ".gitignore"]);
await execFileAsync("git", ["-C", repo, "commit", "--quiet", "-m", "base"]);
await mkdir(join(repo, ".pi", "agent", "sessions"), { recursive: true });
await writeFile(join(repo, ".pi", "agent", "sessions", "live.jsonl"), "changes while Pi is running\n");

delete process.env.HERDR_ENV;
delete process.env.HERDR_PANE_ID;
process.env.XDG_STATE_HOME = stateHome;
process.env.XDG_DATA_HOME = dataHome;
delete process.env.PI_REVIEW_WORKBENCH_ENABLED;

const { default: extension } = await import("./ordinary-tuicr.ts");
const handlers = new Map();
const commands = new Map();
const entries = [];
const notifications = [];
let undoChoice = 1;
const pi = {
  on(name, handler) { handlers.set(name, handler); },
  registerCommand(name, definition) { commands.set(name, definition); },
  appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  async exec(binary, args, options = {}) {
    const result = await execFileAsync(binary, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      signal: options.signal,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0, killed: false };
  },
};
const ctx = {
  mode: "tui",
  cwd: repo,
  signal: undefined,
  ui: {
    theme: { fg: (_color, text) => text },
    setStatus(...args) { if (String(args.at(-1)).includes("unavailable")) console.error("STATUS", ...args); },
    notify(message, level) { notifications.push([message, level]); },
    async select(_title, options) { return options[undoChoice] ?? undefined; },
  },
  sessionManager: {
    getSessionId: () => "test-session",
    getBranch: () => entries,
  },
};

try {
  extension(pi);
  await handlers.get("session_start")({}, ctx);
  await handlers.get("input")({ source: "interactive", text: "make first change" }, ctx);
  await handlers.get("message_start")({ message: { role: "user", content: [{ type: "text", text: "make first change" }] } }, ctx);
  await writeFile(join(repo, "example.txt"), "two\n");
  await handlers.get("agent_settled")({}, ctx);
  await handlers.get("input")({ source: "interactive", text: "make second change" }, ctx);
  await handlers.get("message_start")({ message: { role: "user", content: [{ type: "text", text: "make second change" }] } }, ctx);
  await writeFile(join(repo, "example.txt"), "three\n");
  await handlers.get("agent_settled")({}, ctx);

  const state = [...entries].reverse().find((entry) => entry.customType === "ordinary-tuicr-state").data.state;
  assert.equal(state.lastCapturedSequence, 2);
  assert.match(state.paneId, /^ordinary-session-/);
  const events = (await readFile(join(dataHome, "pi-review-workbench", "change-control", "runs", state.runId, "events.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.type === "snapshot.committed" && event.payload.kind === "prompt").length, 2);
  assert.equal(await readFile(join(repo, "example.txt"), "utf8"), "three\n");
  assert.equal(await readFile(join(state.run.stagingDirectory, "example.txt"), "utf8"), "three\n");
  await assert.rejects(access(join(state.run.stagingDirectory, ".pi", "agent", "sessions", "live.jsonl")), /ENOENT/);

  await commands.get("undo").handler("", ctx);
  assert.equal(await readFile(join(repo, "example.txt"), "utf8"), "three\n", "undo must not touch active checkout");
  assert.equal(await readFile(join(state.run.stagingDirectory, "example.txt"), "utf8"), "two\n", "undo must restore private staging");
  assert.equal(notifications.some(([message]) => message.includes("Private staging restored")), true);

  // Rebinding the extension in the same session must reuse the persisted run
  // rather than resetting the prompt counter or creating duplicate history.
  extension(pi);
  await handlers.get("session_start")({}, ctx);
  await handlers.get("input")({ source: "interactive", text: "make third change after reload" }, ctx);
  await handlers.get("message_start")({ message: { role: "user", content: [{ type: "text", text: "make third change after reload" }] } }, ctx);
  await writeFile(join(repo, "example.txt"), "four\n");
  await handlers.get("agent_settled")({}, ctx);

  const restoredState = [...entries].reverse().find((entry) => entry.customType === "ordinary-tuicr-state").data.state;
  assert.equal(restoredState.runId, state.runId);
  assert.equal(restoredState.lastCapturedSequence, 3);
  const restoredEvents = (await readFile(join(dataHome, "pi-review-workbench", "change-control", "runs", state.runId, "events.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(restoredEvents.filter((event) => event.type === "snapshot.committed" && event.payload.kind === "prompt").length, 3);
  assert.equal(await readFile(join(repo, "example.txt"), "utf8"), "four\n");
  assert.equal(await readFile(join(restoredState.run.stagingDirectory, "example.txt"), "utf8"), "two\n", "new captures must not overwrite the selected private undo state");

  // A numbered undo can jump back to a specific prompt while leaving the
  // active checkout untouched.
  await commands.get("undo").handler("3", ctx);
  assert.equal(await readFile(join(repo, "example.txt"), "utf8"), "four\n", "targeted undo must not touch active checkout");
  assert.equal(await readFile(join(restoredState.run.stagingDirectory, "example.txt"), "utf8"), "two\n", "targeted undo must restore the selected private prompt");

  // A queued one-at-a-time prompt begins at its delivered user-message event.
  // The previous prompt is snapshotted before the queued prompt can receive
  // any assistant work, so both prompt messages retain their own file delta.
  await handlers.get("input")({ source: "interactive", text: "queued parent prompt" }, ctx);
  await handlers.get("message_start")({ message: { role: "user", content: [{ type: "text", text: "queued parent prompt" }] } }, ctx);
  await handlers.get("message_start")({ message: { role: "assistant", content: [] } }, ctx);
  await writeFile(join(repo, "example.txt"), "five\n");
  // Reload while a prompt is active. The replacement extension must recover
  // that exact prompt boundary from persisted private state.
  extension(pi);
  await handlers.get("session_start")({}, ctx);
  await handlers.get("input")({ source: "interactive", text: "queued child prompt", streamingBehavior: "steer" }, ctx);
  await handlers.get("message_start")({ message: { role: "user", content: [{ type: "text", text: "queued child prompt" }] } }, ctx);
  await handlers.get("message_start")({ message: { role: "assistant", content: [] } }, ctx);
  await writeFile(join(repo, "example.txt"), "six\n");
  await handlers.get("agent_settled")({}, ctx);

  const queuedState = [...entries].reverse().find((entry) => entry.customType === "ordinary-tuicr-state").data.state;
  assert.equal(queuedState.lastCapturedSequence, 5);
  const finalEvents = (await readFile(join(dataHome, "pi-review-workbench", "change-control", "runs", state.runId, "events.jsonl"), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  const promptEvents = finalEvents.filter((event) => event.type === "snapshot.committed" && event.payload.kind === "prompt");
  const queuedPromptEvents = promptEvents.slice(-2);
  assert.deepEqual(queuedPromptEvents.map((event) => event.payload.label), ["queued parent prompt", "queued child prompt"]);
  assert.equal((await execFileAsync("git", [`--git-dir=${restoredState.run.privateGitDirectory}`, "show", `${queuedPromptEvents[0].payload.promptHistoryOid}:example.txt`])).stdout, "five\n");
  assert.equal((await execFileAsync("git", [`--git-dir=${restoredState.run.privateGitDirectory}`, "show", `${queuedPromptEvents[1].payload.promptHistoryOid}:example.txt`])).stdout, "six\n");
  assert.equal(await readFile(join(repo, "example.txt"), "utf8"), "six\n");
  assert.equal(await readFile(join(restoredState.run.stagingDirectory, "example.txt"), "utf8"), "two\n", "queued captures must preserve the selected private undo state");
  console.log("ordinary tuicr private-staging test passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
