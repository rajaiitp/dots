import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const { TuiosClient, TuiosErrorKind, decodeResponse } =
	await jiti.import("./client.ts");
const { createTuiosTool } = await jiti.import("./index.ts");
const {
	classifyWorktreeSession,
	DestinationKind,
	openTuiosDestination,
	SessionRegistrationKind,
	startForkedAgent,
} = await jiti.import("./runtime.ts");
const ok = (data) => ({
	stdout: JSON.stringify(data),
	stderr: "",
	code: 0,
	killed: false,
});

function harness(handle) {
	const calls = [];
	const handlers = new Map();
	const pi = {
		on: (name, callback) => handlers.set(name, callback),
		exec: async (binary, args, options) => {
			assert.equal(binary, "tuios");
			assert.equal(args[0], "call");
			const params = JSON.parse(args[2]);
			calls.push({ verb: args[1], params, options });
			return handle(args[1], params, options);
		},
	};
	const tool = createTuiosTool(pi);
	return {
		calls,
		handlers,
		pi,
		tool,
		run: (input) => tool.execute("call", input),
	};
}

test("native response decoding rejects malformed envelopes and preserves daemon errors", () => {
	assert.deepEqual(decodeResponse('{"type":"ok"}', "", 0), { type: "ok" });
	for (const raw of ["not-json", "[]", "null"])
		assert.throws(
			() => decodeResponse(raw, "", 0),
			(error) => error.kind === TuiosErrorKind.Protocol,
		);
	assert.throws(
		() =>
			decodeResponse(
				'{"error":{"code":"forbidden","message":"denied"}}',
				"",
				1,
			),
		(error) =>
			error.kind === TuiosErrorKind.Daemon && error.code === "forbidden",
	);
	assert.throws(
		() => decodeResponse("", "", 0, true),
		(error) =>
			error.kind === TuiosErrorKind.Transport &&
			/Do not retry/.test(error.message),
	);
});

test("transport bounds waits, forwards cancellation and never retries writes", async () => {
	let count = 0;
	const controller = new AbortController();
	const client = new TuiosClient({
		exec: async (_binary, args, options) => {
			count++;
			assert.equal(args[1], "new-window");
			assert.equal(args.at(-1), "15000ms");
			assert.equal(options.timeout, 25000);
			assert.equal(options.signal, controller.signal);
			return { ...ok({}), killed: true };
		},
	});
	await assert.rejects(
		client.call("new-window", {}, controller.signal, 5000),
		/may still be running/,
	);
	assert.equal(count, 1);
	controller.abort();
	await assert.rejects(client.call("new-window", {}, controller.signal));
	assert.equal(count, 1);
});

test("pane aliases bind native IDs to sessions and default creation never focuses", async () => {
	const h = harness(async (verb, params) => {
		if (verb === "new-window") {
			assert.equal(params.focus, false);
			return ok({ window_id: "window-1", workspace: 1 });
		}
		if (verb === "capture-pane") {
			assert.deepEqual(
				{ session: params.session, window: params.window },
				{ session: "project", window: "window-1" },
			);
			assert.equal(params.unwrap, true);
			return ok({ content: "build done" });
		}
		throw new Error(verb);
	});
	assert.equal(
		(
			await h.run({
				action: "pane_create",
				session: "project",
				newPane: "build",
			})
		).isError,
		false,
	);
	assert.equal(
		(await h.run({ action: "read", pane: "build", source: "recent-unwrapped" }))
			.details.content,
		"build done",
	);
	const count = h.calls.length;
	assert.equal(
		(await h.run({ action: "read", pane: "build", session: "wrong" })).details
			.error.kind,
		"validation",
	);
	assert.equal(
		(
			await h.run({
				action: "pane_create",
				session: "project",
				newPane: "build",
			})
		).details.error.kind,
		"validation",
	);
	assert.equal(h.calls.length, count);
});

test("run submits exactly one native command and reports a non-zero command exit", async () => {
	const h = harness(async (verb, params) => {
		assert.equal(verb, "run");
		assert.equal(params.command, "printf 'a; b\\n'; exit 7");
		return ok({ exit_code: 7, output: "a; b\n", command_seq: 10 });
	});
	const result = await h.run({
		action: "run",
		session: "work",
		pane: "tests",
		command: "printf 'a; b\\n'; exit 7",
	});
	assert.equal(result.isError, true);
	assert.equal(result.details.exit_code, 7);
	assert.equal(h.calls.length, 1);
});

test("run fails closed when completion is missing", async () => {
	const h = harness(async () => ok({ output: "still running" }));
	const result = await h.run({
		action: "run",
		session: "work",
		pane: "tests",
		command: "make test",
	});
	assert.equal(result.isError, true);
	assert.equal(result.details.error.kind, "protocol");
});

test("watch uses the native wait verb and quotes literal search patterns", async () => {
	const h = harness(async (verb, params) => {
		assert.equal(verb, "wait-for");
		assert.equal(params.condition, "window-output");
		assert.equal(params.pattern, "BUILD \\[ok\\]\\.");
		return ok({ condition: "window-output" });
	});
	assert.equal(
		(
			await h.run({
				action: "watch",
				session: "work",
				pane: "build",
				match: "BUILD [ok].",
			})
		).isError,
		false,
	);
});

test("wait_agent refuses ordinary shells and does not call the wait verb", async () => {
	const h = harness(async (verb) => {
		assert.equal(verb, "list-agents");
		return ok({ agents: [] });
	});
	const result = await h.run({
		action: "wait_agent",
		session: "work",
		pane: "shell",
	});
	assert.equal(result.isError, true);
	assert.match(result.details.error.message, /use watch/);
	assert.equal(h.calls.length, 1);
});

test("wait_agent uses native needs_input and done states", async () => {
	const h = harness(async (verb, params) => {
		if (verb === "list-agents")
			return ok({ agents: [{ window_id: "agent-id", name: "reviewer" }] });
		assert.equal(verb, "wait-for");
		assert.equal(params.until, "idle,done,needs_input");
		return ok({ state: "done" });
	});
	assert.equal(
		(await h.run({ action: "wait_agent", session: "work", pane: "reviewer" }))
			.details.state,
		"done",
	);
});

test("send rejects ambiguous input and propagates approval guards without overrides", async () => {
	const h = harness(async (verb, params) => {
		assert.equal(verb, "send-text");
		assert.equal(params.allow_blocked, undefined);
		return {
			...ok({
				error: { code: "agent_blocked", message: "waiting for approval" },
			}),
			code: 1,
		};
	});
	assert.equal(
		(
			await h.run({
				action: "send",
				session: "work",
				pane: "agent",
				text: "yes",
				keys: "Enter",
			})
		).details.error.kind,
		"validation",
	);
	assert.equal(h.calls.length, 0);
	assert.equal(
		(
			await h.run({
				action: "send",
				session: "work",
				pane: "agent",
				text: "yes",
			})
		).details.error.code,
		"agent_blocked",
	);
});

test("split restores the previous focus when focus was not requested", async () => {
	const h = harness(async (verb, params) => {
		switch (verb) {
			case "list-windows":
				return ok({ focused_window_id: "original" });
			case "split-window":
				assert.equal(params.direction, "horizontal");
				assert.equal(params.side, "down");
				return ok({ window_id: "new" });
			case "focus-window":
				assert.equal(params.window, "original");
				return ok({ focused_window_id: "original" });
			default:
				throw new Error(verb);
		}
	});
	assert.equal(
		(
			await h.run({
				action: "pane_split",
				session: "work",
				pane: "source",
				direction: "down",
				newPane: "logs",
			})
		).isError,
		false,
	);
});

test("workspace creation selects an empty numbered workspace without changing focus", async () => {
	const h = harness(async (verb, params) => {
		if (verb === "list-workspaces")
			return ok({
				workspaces: [
					{ workspace: 1, current: true, window_count: 1 },
					{ workspace: 2, current: false, window_count: 0 },
				],
			});
		assert.equal(verb, "new-window");
		assert.equal(params.workspace, 2);
		assert.equal(params.focus, false);
		return ok({ window_id: "workspace-pane", workspace: 2 });
	});
	assert.equal(
		(await h.run({ action: "workspace_create", session: "work" })).details
			.workspace,
		2,
	);
});

test("session discovery matches canonical directories and rejects ambiguity", async (t) => {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "native-session-match-")),
	);
	t.after(() => rm(root, { recursive: true, force: true }));
	const directory = join(root, "project");
	await mkdir(directory);
	await symlink(directory, join(root, "alias"));
	const session = {
		name: "existing",
		id: "id",
		panes: [{ id: "pane", workspace: 1, cwd: directory }],
	};
	assert.equal(
		(
			await classifyWorktreeSession(
				{ sessions: [session] },
				join(root, "alias"),
			)
		).kind,
		SessionRegistrationKind.Registered,
	);
	assert.equal(
		(
			await classifyWorktreeSession(
				{ sessions: [session, { ...session, name: "duplicate" }] },
				directory,
			)
		).kind,
		SessionRegistrationKind.Ambiguous,
	);
	assert.equal(
		(
			await classifyWorktreeSession(
				{ sessions: [{ ...session, worktreePath: root }] },
				directory,
			)
		).kind,
		SessionRegistrationKind.Absent,
	);
});

test("session creation checks response identities and is never retried", async () => {
	let count = 0;
	const h = harness(async (verb) => {
		if (verb === "list-sessions") return ok({ sessions: [] });
		count++;
		return ok({ session: "wrong", session_id: "wrong-id" });
	});
	await assert.rejects(
		openTuiosDestination(new TuiosClient(h.pi), "/tmp", "project", "request"),
		/different session/,
	);
	assert.equal(count, 1);
});

test("forked Pi startup rejects a reused pane even if it reports ready", async () => {
	const h = harness(async (verb) => {
		assert.equal(verb, "start-agent");
		return ok({
			session: "work",
			session_id: "id",
			window_id: "old",
			ready: true,
			outcome: "ready",
		});
	});
	await assert.rejects(
		startForkedAgent(
			new TuiosClient(h.pi),
			{
				kind: DestinationKind.ExistingSessionPane,
				sessionName: "work",
				sessionId: "id",
				cwd: "/tmp",
				beforePaneIds: ["old"],
			},
			"/tmp/snapshot",
			"agent",
			{
				model: "provider/model",
				thinkingLevel: "high",
				sessionName: "project",
			},
		),
		/pre-existing/,
	);
});

test("stop resolves abbreviated IDs before protecting the current pane", async (t) => {
	const previous = process.env.TUIOS_PANE_ID;
	process.env.TUIOS_PANE_ID = "current-window-id";
	t.after(() => {
		if (previous === undefined) delete process.env.TUIOS_PANE_ID;
		else process.env.TUIOS_PANE_ID = previous;
	});
	const h = harness(async (verb, params) => {
		assert.equal(verb, "get-window");
		assert.equal(params.window, "current");
		return ok({ window_id: "current-window-id" });
	});
	const result = await h.run({
		action: "stop",
		session: "work",
		pane: "current",
	});
	assert.equal(result.isError, true);
	assert.match(result.details.error.message, /own pane/);
	assert.equal(h.calls.length, 1);
});

test("watch preserves visible selection and rejects unsupported unwrapped waits", async () => {
	const h = harness(async (verb, params) => {
		assert.equal(verb, "wait-for");
		assert.equal(params.source, "visible");
		return ok({ matched: true });
	});
	assert.equal(
		(
			await h.run({
				action: "watch",
				session: "work",
				pane: "logs",
				source: "visible",
				match: "done",
			})
		).isError,
		false,
	);
	assert.equal(
		(
			await h.run({
				action: "watch",
				session: "work",
				pane: "logs",
				source: "recent-unwrapped",
				match: "done",
			})
		).details.error.kind,
		"validation",
	);
	assert.equal(h.calls.length, 1);
});
