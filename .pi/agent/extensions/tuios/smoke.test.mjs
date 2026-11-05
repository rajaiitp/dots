import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { hostRequire, sdkRoot } from "../big-pickle/test/host.mjs";

const { createJiti } = hostRequire("jiti");
const jiti = createJiti(import.meta.url, {
	alias: {
		typebox: hostRequire.resolve("typebox"),
		"@earendil-works/pi-coding-agent": join(sdkRoot, "dist", "index.js"),
		"@earendil-works/pi-tui": hostRequire.resolve("@earendil-works/pi-tui"),
	},
});
const { createTuiosTool } = await jiti.import("./index.ts");
const { registerDirectoryHandoff } = await jiti.import(
	"../branch-workspace/handoff.ts",
);
const { SessionManager } = await jiti.import(join(sdkRoot, "dist", "index.js"));

function execute(binary, args, options, env) {
	return new Promise((resolve, reject) => {
		execFile(
			binary,
			args,
			{ ...options, env, maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error && typeof error.code !== "number") return reject(error);
				resolve({
					code: error?.code || 0,
					killed: error?.killed || false,
					stdout,
					stderr,
				});
			},
		);
	});
}

test("native pane control and forked handoff work on an isolated daemon without a model", {
	skip: process.env.TUIOS_SMOKE !== "1",
	timeout: 120_000,
}, async (t) => {
	const root = await realpath(await mkdtemp("/tmp/tuios-native-smoke-"));
	const oldPath = process.env.PATH;
	const bin = join(root, "bin");
	const source = join(root, "source");
	const target = join(root, "destination");
	const home = join(root, "home");
	for (const path of [
		bin,
		source,
		target,
		home,
		join(root, "run"),
		join(root, "config"),
	])
		await mkdir(path, { recursive: true, mode: 0o700 });
	process.env.PATH = `${bin}${delimiter}${oldPath}`;
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) =>
				!name.startsWith("TUIOS_") &&
				!name.startsWith("HERDR_") &&
				!name.startsWith("GHOSTTY_") &&
				!name.startsWith("PI_"),
		),
	);
	Object.assign(env, {
		HOME: home,
		SHELL: "/bin/zsh",
		XDG_RUNTIME_DIR: join(root, "run"),
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_CONFIG_DIRS: join(root, "config"),
		XDG_STATE_HOME: join(root, "state"),
		XDG_DATA_HOME: join(root, "data"),
		XDG_CACHE_HOME: join(root, "cache"),
		SMOKE_AGENT_ARGS: join(root, "agent-args"),
		SMOKE_AGENT_PROMPTS: join(root, "agent-prompts"),
	});
	const exec = (binary, args, options = {}) =>
		execute(binary, args, options, env);
	t.after(async () => {
		await exec("tuios", ["kill-server"], { timeout: 10_000 });
		process.env.PATH = oldPath;
		await rm(root, { recursive: true, force: true });
	});
	await writeFile(
		join(home, ".zshrc"),
		"precmd() { local rc=$?; printf '\\033]133;D;%s\\007\\033]133;A\\007' \"$rc\"; }\npreexec() { printf '\\033]133;C\\007'; }\nPROMPT='SMOKE_PROMPT> '\n",
		{ mode: 0o600 },
	);
	await writeFile(
		join(bin, "pi"),
		`#!/bin/sh
printf '%s\\n' "$@" > "$SMOKE_AGENT_ARGS"
stty -echo
tuios set-agent-state idle --harness pi >/dev/null
printf 'FAKE_PI_READY\\n'
while IFS= read -r line; do
    printf '%s\\n' "$line" >> "$SMOKE_AGENT_PROMPTS"
    printf 'FAKE_RECEIVED_%s\\n' "$line"
    tuios set-agent-state done --harness pi >/dev/null
done
`,
		{ mode: 0o700 },
	);
	await chmod(join(bin, "pi"), 0o700);
	assert.equal(
		(await exec("tuios", ["start-server"], { timeout: 10_000 })).code,
		0,
	);
	const pi = { exec, on: () => {} };
	const tool = createTuiosTool(pi);
	const created = await tool.execute("create", {
		action: "session_create",
		name: "smoke",
		cwd: source,
		newPane: "shell",
	});
	assert.equal(created.isError, false, JSON.stringify(created));
	const ready = await tool.execute("ready", {
		action: "watch",
		pane: "shell",
		match: "SMOKE_PROMPT",
		timeout: 10_000,
	});
	assert.equal(ready.isError, false, JSON.stringify(ready));
	const run = await tool.execute("run", {
		action: "run",
		pane: "shell",
		command: "printf 'NATIVE_COMMAND_OK\\n'; false",
		timeout: 10_000,
	});
	assert.equal(run.details.exit_code, 1, JSON.stringify(run));
	assert.equal(run.isError, true);
	assert.match(run.details.output, /NATIVE_COMMAND_OK/);
	const read = await tool.execute("read", {
		action: "read",
		pane: "shell",
		source: "recent-unwrapped",
	});
	assert.equal(read.isError, false, JSON.stringify(read));
	assert.match(read.details.content, /NATIVE_COMMAND_OK/);
	let handoff;
	const journal = [];
	registerDirectoryHandoff({
		...pi,
		registerTool: (definition) => {
			handoff = definition;
		},
		appendEntry: (kind, data) => journal.push({ kind, data }),
		getThinkingLevel: () => "high",
	});
	const manager = SessionManager.inMemory(source);
	manager.appendMessage({
		role: "user",
		content: "Native handoff smoke fixture",
		timestamp: 1,
	});
	const result = await handoff.execute(
		"handoff",
		{ worktree: target, task: "NATIVE_HANDOFF_OK" },
		undefined,
		undefined,
		{
			cwd: source,
			mode: "print",
			hasUI: false,
			model: { provider: "fixture", id: "no-model" },
			sessionManager: manager,
		},
	);
	assert.equal(result.isError, undefined, JSON.stringify(result));
	assert.equal(result.details.submitted, true);
	assert.ok(result.details.queueId);
	const args = await readFile(env.SMOKE_AGENT_ARGS, "utf8");
	assert.match(args, /--fork/);
	assert.match(args, /fixture\/no-model/);
	const delivered = await exec(
		"tuios",
		[
			"wait-for",
			"window-output",
			"-s",
			result.details.sessionName,
			"-w",
			result.details.paneId,
			"--pattern",
			"FAKE_RECEIVED_NATIVE_HANDOFF_OK",
			"--timeout",
			"10000",
		],
		{ timeout: 15_000 },
	);
	assert.equal(delivered.code, 0, delivered.stderr);
	assert.equal(
		(await readFile(env.SMOKE_AGENT_PROMPTS, "utf8")).split("NATIVE_HANDOFF_OK")
			.length - 1,
		1,
	);
	assert.deepEqual(
		journal.map((entry) => entry.data.outcome),
		["accepted", "submitted"],
	);
	const snapshot = journal[0].data.snapshot;
	await rm(join(snapshot, ".."), { recursive: true, force: true });
});
