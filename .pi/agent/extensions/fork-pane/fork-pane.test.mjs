import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hostRequire, sdkRoot } from "../big-pickle/test/host.mjs";

const { createJiti } = hostRequire("jiti");
const jiti = createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": join(sdkRoot, "dist/index.js"),
	},
});
const { SessionManager, initTheme } = await jiti.import(
	join(sdkRoot, "dist/index.js"),
);
initTheme("dark");
const {
	forkMessages,
	prepareFork,
	saveFork,
	prefillText,
	PREFILL_SESSION_ENV,
} = await jiti.import("./session.ts");
const { forkRuntimeArgs } = await jiti.import("./launch.ts");
const { default: extension, createForkPaneCommand } =
	await jiti.import("./index.ts");
const entrypoint = fileURLToPath(import.meta.url);

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "pi-fork-pane-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "sessions");
	await mkdir(directory);
	const source = SessionManager.create(root, directory);
	const first = source.appendMessage({
		role: "user",
		content: "first",
		timestamp: 1,
	});
	const state = source.appendCustomEntry("example-state", { count: 2 });
	const second = source.appendMessage({
		role: "user",
		content: [
			{ type: "text", text: "second" },
			{ type: "text", text: "\nline" },
		],
		timestamp: 2,
	});
	return { root, directory, source, first, state, second };
}

function environment(t, values = {}) {
	for (const [key, value] of Object.entries({
		TUIOS_ENV: "1",
		TUIOS_SESSION: "source-session",
		TUIOS_PANE_ID: "source-pane",
		[PREFILL_SESSION_ENV]: undefined,
		...values,
	})) {
		const previous = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
		t.after(() => {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		});
	}
}

function harness(source, options = {}) {
	const calls = [];
	const notifications = [];
	const editorWrites = [];
	const pi = {
		exec: async (binary, args) => {
			const params = JSON.parse(args[2]);
			calls.push({ binary, verb: args[1], params });
			const result = options.handle
				? await options.handle(args[1], params)
				: args[1] === "list-windows"
					? {
							windows: [{ window_id: "source-pane", workspace: 3 }],
							focused_window_id: "other-pane",
						}
					: { window_id: "child-pane" };
			return {
				stdout: JSON.stringify(result),
				stderr: "",
				code: result.error ? 1 : 0,
			};
		},
	};
	const ctx = {
		mode: "tui",
		cwd: source.getCwd(),
		sessionManager: source,
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			setEditorText: (text) => editorWrites.push(text),
			custom: async (factory) => {
				let choice;
				const component = factory({ requestRender() {} }, {}, {}, (value) => {
					choice = value;
				});
				if (options.pick) await options.pick(component);
				else component.handleInput(options.cancel ? "\x1b" : "\r");
				return choice;
			},
		},
	};
	const command = createForkPaneCommand(pi, {
		argv: options.argv ?? [],
		entrypoint,
	});
	return {
		pi,
		ctx,
		calls,
		notifications,
		editorWrites,
		run: () => command.handler("", ctx),
	};
}

const textMessages = (manager) =>
	manager
		.buildSessionContext()
		.messages.filter((message) => message.role === "user")
		.map((message) => message.content);

test("snapshot forks before the selection without mutating the source", async (t) => {
	const { source, second, state } = await fixture(t);
	const before = await readFile(source.getSessionFile(), "utf8");
	const leaf = source.getLeafId();
	const entries = structuredClone(source.getEntries());
	const saved = await saveFork(source, second);
	const fork = SessionManager.open(saved.path);
	assert.notEqual(fork.getSessionId(), source.getSessionId());
	assert.equal(fork.getHeader().parentSession, source.getSessionFile());
	assert.deepEqual(textMessages(fork), ["first"]);
	assert.equal(prefillText(fork), "second\nline");
	assert.equal(fork.getEntry(state).data.count, 2);
	assert.equal(fork.getEntry(second), undefined);
	assert.deepEqual(source.getEntries(), entries);
	assert.equal(source.getLeafId(), leaf);
	assert.equal(await readFile(source.getSessionFile(), "utf8"), before);
	assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
});

test("first-message fork is an empty conversation with the selected prompt", async (t) => {
	const { source, first } = await fixture(t);
	const saved = await saveFork(source, first);
	const fork = SessionManager.open(saved.path);
	assert.deepEqual(textMessages(fork), []);
	assert.equal(prefillText(fork), "first");
	assert.equal(fork.getBranch()[0].parentId, null);
});

test("picker includes alternative branches and snapshots only selected ancestry", async (t) => {
	const { source, first, second } = await fixture(t);
	source.branch(first);
	const alternate = source.appendMessage({
		role: "user",
		content: "alternate",
		timestamp: 3,
	});
	assert.deepEqual(
		forkMessages(source).map((item) => item.id),
		[first, second, alternate],
	);
	const saved = await saveFork(source, second);
	const fork = SessionManager.open(saved.path);
	assert.equal(fork.getEntry(alternate), undefined);
	assert.equal(source.getLeafId(), alternate);
});

test("snapshot uses resolved labels rather than stale branch-local bookmarks", async (t) => {
	const { source, first, second } = await fixture(t);
	source.appendLabelChange(first, "new label");
	let fork = prepareFork(source, second);
	let manager = SessionManager.inMemory(source.getCwd(), undefined, [
		fork.header,
		...fork.entries,
	]);
	assert.equal(manager.getLabel(first), "new label");
	source.appendLabelChange(first, undefined);
	fork = prepareFork(source, second);
	manager = SessionManager.inMemory(source.getCwd(), undefined, [
		fork.header,
		...fork.entries,
	]);
	assert.equal(manager.getLabel(first), undefined);
});

test("invalid selections, unsaved sessions and write failures do not produce a fork", async (t) => {
	const { source, state, root, second } = await fixture(t);
	assert.throws(() => prepareFork(source, state), /user message/);
	assert.throws(() => prepareFork(source, "missing"), /user message/);
	assert.throws(
		() => prepareFork(SessionManager.inMemory(root), "missing"),
		/saved session/,
	);
	const file = join(root, "not-a-directory");
	await writeFile(file, "occupied");
	const blocked = new Proxy(source, {
		get: (target, key) =>
			key === "getSessionDir"
				? () => file
				: typeof target[key] === "function"
					? target[key].bind(target)
					: target[key],
	});
	await assert.rejects(saveFork(blocked, second), /EEXIST/);
});

test("runtime options preserve restrictions and extensions but never replay input or session selection", () => {
	const args = forkRuntimeArgs([
		"--no-tools",
		"--no-builtin-tools",
		"--tools",
		"read",
		"--exclude-tools",
		"bash,write",
		"--no-extensions",
		"-e",
		"/tmp/extension.ts",
		"--system-prompt",
		"custom prompt",
		"--append-system-prompt",
		"extra",
		"--no-mcp",
		"--no-approve",
		"--offline",
		"--tui-mode",
		"regular",
		"--custom=one",
		"--session",
		"old.jsonl",
		"--name",
		"old",
		"--session-id",
		"old-id",
		"@secret",
		"do not submit",
	]);
	for (const flag of [
		"--no-tools",
		"--no-builtin-tools",
		"--no-extensions",
		"--no-mcp",
		"--no-approve",
		"--offline",
	])
		assert.ok(args.includes(flag));
	for (const value of [
		"read",
		"bash,write",
		"/tmp/extension.ts",
		"custom prompt",
		"extra",
		"regular",
		"--custom=one",
	])
		assert.ok(args.includes(value));
	for (const value of [
		"--session",
		"old.jsonl",
		"old-id",
		"old",
		"@secret",
		"do not submit",
	])
		assert.ok(!args.includes(value));
	assert.throws(() => forkRuntimeArgs(["--mode", "bad"]), /Invalid mode/);
});

test("command uses the native picker and opens an unfocused retained pane in the source workspace", async (t) => {
	environment(t);
	const { source, first } = await fixture(t);
	const h = harness(source, {
		pick: (component) => {
			component.handleInput("\x1b[A");
			component.handleInput("\r");
		},
	});
	await h.run();
	assert.notEqual(
		h.notifications.at(-1)?.level,
		"error",
		h.notifications.at(-1)?.message,
	);
	assert.deepEqual(
		h.calls.map((item) => item.verb),
		["list-windows", "new-window"],
	);
	const params = h.calls[1].params;
	assert.equal(params.session, "source-session");
	assert.equal(params.workspace, 3);
	assert.equal(params.cwd, source.getCwd());
	assert.equal(params.focus, false);
	assert.equal(params.keep_open, true);
	assert.ok(isAbsolute(params.command[0]));
	assert.equal(params.command[0], process.execPath);
	assert.equal(params.command[1], entrypoint);
	assert.ok(params.command.includes("--extension"));
	assert.equal(params.prompt, undefined);
	assert.equal(params.command.includes("--fork"), false);
	const path = params.command[params.command.indexOf("--session") + 1];
	const child = SessionManager.open(path);
	assert.equal(params.env[PREFILL_SESSION_ENV], child.getSessionId());
	assert.equal(prefillText(child), source.getEntry(first).message.content);
	assert.deepEqual(h.editorWrites, []);
	assert.match(h.notifications.at(-1).message, /Fork opened/);
});

test("picker cancellation creates no session or pane", async (t) => {
	environment(t);
	const { source, directory } = await fixture(t);
	const before = await readdir(directory);
	const h = harness(source, { cancel: true });
	await h.run();
	assert.deepEqual(h.calls, []);
	assert.deepEqual(await readdir(directory), before);
});

test("missing source and denied writes fail without fallback, retry or source mutation", async (t) => {
	environment(t);
	const { source } = await fixture(t);
	const leaf = source.getLeafId();
	const missing = harness(source, { handle: () => ({ windows: [] }) });
	await missing.run();
	assert.equal(missing.calls.length, 1);
	assert.match(missing.notifications.at(-1).message, /source tuios pane/);
	const denied = harness(source, {
		handle: (verb) =>
			verb === "list-windows"
				? { windows: [{ window_id: "source-pane", workspace: 3 }] }
				: { error: { code: "forbidden", message: "denied" } },
	});
	await denied.run();
	assert.equal(denied.calls.length, 2);
	assert.match(denied.notifications.at(-1).message, /denied.*Saved fork:/);
	assert.equal(source.getLeafId(), leaf);
	assert.deepEqual(denied.editorWrites, []);
});

test("duplicate commands cannot launch concurrently", async (t) => {
	environment(t);
	const { source } = await fixture(t);
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const h = harness(source, {
		pick: async (component) => {
			await gate;
			component.handleInput("\r");
		},
	});
	const first = h.run();
	await h.run();
	assert.match(h.notifications[0].message, /already in progress/);
	release();
	await first;
	assert.equal(h.calls.filter((item) => item.verb === "new-window").length, 1);
});

test("only fork-pane is registered; fork and clone retain native behavior", () => {
	const commands = [];
	const handlers = [];
	extension({
		registerCommand: (name) => commands.push(name),
		on: (name) => handlers.push(name),
	});
	assert.deepEqual(commands, ["fork-pane"]);
	assert.deepEqual(handlers, ["session_start"]);
});

test("child restores its editor once, without submitting the prompt", async (t) => {
	environment(t);
	const { source, second } = await fixture(t);
	const saved = await saveFork(source, second);
	const child = SessionManager.open(saved.path);
	const handlers = new Map();
	extension({
		registerCommand() {},
		on: (name, handler) => handlers.set(name, handler),
	});
	const writes = [];
	const ctx = {
		mode: "tui",
		sessionManager: child,
		ui: { setEditorText: (text) => writes.push(text) },
	};
	process.env[PREFILL_SESSION_ENV] = child.getSessionId();
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	assert.deepEqual(writes, ["second\nline"]);
	assert.equal(process.env[PREFILL_SESSION_ENV], undefined);
	process.env[PREFILL_SESSION_ENV] = "unrelated-session";
	await handlers.get("session_start")({ reason: "startup" }, ctx);
	assert.equal(writes.length, 1);
	process.env[PREFILL_SESSION_ENV] = child.getSessionId();
	await handlers.get("session_start")({ reason: "resume" }, ctx);
	assert.equal(writes.length, 1);
});

test("outside tuios and non-TUI invocation do not launch a pane", async (t) => {
	environment(t, { TUIOS_ENV: undefined });
	const { source } = await fixture(t);
	const h = harness(source);
	await h.run();
	assert.deepEqual(h.calls, []);
	process.env.TUIOS_ENV = "1";
	h.ctx.mode = "rpc";
	await h.run();
	assert.deepEqual(h.calls, []);
});
