import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { hostRequire, sdkRoot } from "../big-pickle/test/host.mjs";

const { createJiti } = hostRequire("jiti");
const jiti = createJiti(import.meta.url, {
	alias: { "@earendil-works/pi-coding-agent": join(sdkRoot, "dist/index.js") },
});
const { SessionManager, initTheme } = await jiti.import(
	join(sdkRoot, "dist/index.js"),
);
const { createForkPaneCommand } = await jiti.import("./index.ts");
initTheme("dark");

test("real Pi starts in an unfocused native pane with its selected prompt and tool restrictions", {
	skip: process.env.TUIOS_SMOKE !== "1",
	timeout: 60_000,
}, async (t) => {
	const root = await realpath(await mkdtemp("/tmp/pi-fork-pane-smoke-"));
	const home = join(root, "home");
	for (const path of [
		home,
		join(root, "run"),
		join(root, "config"),
		join(root, "agent"),
	])
		await mkdir(path, { recursive: true });
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
		SHELL: "/bin/sh",
		XDG_RUNTIME_DIR: join(root, "run"),
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_STATE_HOME: join(root, "state"),
		XDG_DATA_HOME: join(root, "data"),
		XDG_CACHE_HOME: join(root, "cache"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_OFFLINE: "1",
	});
	const exec = (binary, args, options = {}) =>
		new Promise((resolve, reject) => {
			execFile(
				binary,
				args,
				{ ...options, env, maxBuffer: 4 * 1024 * 1024 },
				(error, stdout, stderr) => {
					if (error && typeof error.code !== "number") return reject(error);
					resolve({
						code: error?.code ?? 0,
						killed: error?.killed ?? false,
						stdout,
						stderr,
					});
				},
			);
		});
	const changed = {};
	for (const [key, value] of Object.entries({
		TUIOS_ENV: "1",
		TUIOS_SESSION: "fork-smoke",
		PI_CODING_AGENT_DIR: env.PI_CODING_AGENT_DIR,
	})) {
		changed[key] = process.env[key];
		process.env[key] = value;
	}
	changed.TUIOS_PANE_ID = process.env.TUIOS_PANE_ID;
	t.after(async () => {
		await exec("tuios", ["kill-server"], { timeout: 10_000 });
		for (const [key, value] of Object.entries(changed)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	});
	const control = async (verb, params) => {
		const result = await exec(
			"tuios",
			["call", verb, JSON.stringify(params), "--json"],
			{ timeout: 15_000 },
		);
		assert.equal(result.code, 0, result.stderr || result.stdout);
		return JSON.parse(result.stdout);
	};
	assert.equal(
		(await exec("tuios", ["start-server"], { timeout: 10_000 })).code,
		0,
	);
	const created = await control("new-session", {
		name: "fork-smoke",
		cwd: root,
	});
	process.env.TUIOS_PANE_ID = created.window_id;
	const probe = join(root, "probe.ts");
	const resultPath = join(root, "startup.json");
	await writeFile(
		probe,
		`import { writeFile } from "node:fs/promises";
export default function (pi) {
  pi.registerProvider("fork-test", {
    baseUrl: "http://127.0.0.1:1", api: "openai-completions", apiKey: "unused",
    models: [{ id: "model", name: "Smoke", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }]
  });
  pi.on("session_start", (_event, ctx) => {
    setImmediate(async () => {
      await writeFile(${JSON.stringify(resultPath)}, JSON.stringify({ editor: ctx.ui.getEditorText(), tools: pi.getActiveTools(), id: ctx.sessionManager.getSessionId() }));
      ctx.ui.notify("FORK_PANE_SMOKE_READY", "info");
    });
  });
}
`,
	);
	const source = SessionManager.create(root, join(root, "sessions"));
	source.appendMessage({ role: "user", content: "first", timestamp: 1 });
	source.appendMessage({
		role: "user",
		content: "selected prompt",
		timestamp: 2,
	});
	const sourceBytes = await readFile(source.getSessionFile(), "utf8");
	const errors = [];
	const command = createForkPaneCommand(
		{ exec },
		{
			argv: [
				"--offline",
				"--no-extensions",
				"--no-skills",
				"--no-mcp",
				"--no-context-files",
				"--no-tools",
				"--model",
				"fork-test/model",
				"--extension",
				probe,
			],
			entrypoint: join(sdkRoot, "dist/bundle/cli.js"),
		},
	);
	await command.handler("", {
		mode: "tui",
		cwd: root,
		sessionManager: source,
		ui: {
			notify: (message, level) => {
				if (level === "error") errors.push(message);
			},
			custom: async (factory) => {
				let selected;
				factory({ requestRender() {} }, {}, {}, (value) => {
					selected = value;
				}).handleInput("\r");
				return selected;
			},
		},
	});
	assert.deepEqual(errors, []);
	const windows = await control("list-windows", { session: "fork-smoke" });
	assert.equal(windows.windows.length, 2);
	assert.equal(windows.focused_window_id, created.window_id);
	const child = windows.windows.find(
		(pane) => pane.window_id !== created.window_id,
	);
	await control("wait-for", {
		condition: "window-output",
		session: "fork-smoke",
		window: child.window_id,
		pattern: "FORK_PANE_SMOKE_READY",
		timeout: 15_000,
	});
	const startup = JSON.parse(await readFile(resultPath, "utf8"));
	assert.equal(startup.editor, "selected prompt");
	assert.deepEqual(startup.tools, []);
	assert.notEqual(startup.id, source.getSessionId());
	assert.equal(await readFile(source.getSessionFile(), "utf8"), sourceBytes);
});
