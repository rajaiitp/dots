import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
const {
	resolveHandoffDirectory,
	handoffSnapshotEntries,
	writeHandoffSnapshot,
	registerDirectoryHandoff,
} = await jiti.import("./handoff.ts");
const branchWorkspace = await jiti.import("../branch-workspace.ts");
const { SessionManager } = await jiti.import(join(sdkRoot, "dist", "index.js"));
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", killed: false });
const json = (data) => ok(JSON.stringify(data));
const failure = (stderr = "not a git repository") => ({
	code: 128,
	stdout: "",
	stderr,
	killed: false,
});

async function fixture(t) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "pi-native-handoff-")),
	);
	t.after(() => rm(root, { recursive: true, force: true }));
	const source = join(root, "source");
	const target = join(root, "different project");
	await mkdir(source);
	await mkdir(target);
	return { root, source, target };
}

function gitDouble(repositories = []) {
	const calls = [];
	const exec = async (binary, args, options = {}) => {
		calls.push({ binary, args, cwd: options.cwd });
		assert.equal(binary, "git");
		assert.ok(
			!args.some((arg) =>
				["status", "diff", "submodule", "stash", "hash-object"].includes(arg),
			),
			"directory handoff must not inspect or mutate WIP",
		);
		const repo = repositories.find(
			(candidate) =>
				options.cwd === candidate.path ||
				options.cwd?.startsWith(`${candidate.path}/`),
		);
		if (!repo) return failure();
		if (args.includes("--show-toplevel")) return ok(`${repo.path}\n`);
		if (args.includes("--git-common-dir"))
			return ok(`${repo.common || join(repo.path, ".git")}\n`);
		if (args[0] === "worktree")
			return ok(
				repo.worktrees ||
					`worktree ${repo.path}\0HEAD abcdef1234\0branch refs/heads/main\0\0`,
			);
		if (args[0] === "symbolic-ref")
			return repo.detached
				? { ...ok(), code: 1 }
				: ok(`${repo.branch || "main"}\n`);
		if (args.includes("HEAD^{commit}"))
			return repo.unborn
				? failure("unknown revision")
				: ok("abcdef1234567890\n");
		throw new Error(`Unexpected Git operation: ${args.join(" ")}`);
	};
	return { calls, exec };
}

async function repository(path, options = {}) {
	await mkdir(join(path, ".git"), { recursive: true });
	return { path, ...options };
}

function sourceEntries() {
	return [
		{
			type: "message",
			id: "user",
			parentId: null,
			timestamp: "2026-01-01T00:00:00Z",
			message: {
				role: "user",
				content: "Do the destination task",
				timestamp: 1,
			},
		},
		{
			type: "message",
			id: "assistant",
			parentId: "user",
			timestamp: "2026-01-01T00:00:01Z",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "handoff-call",
						name: "branch_workspace_handoff",
						arguments: {},
					},
					{ type: "toolCall", id: "sibling", name: "read", arguments: {} },
				],
				stopReason: "toolUse",
				timestamp: 2,
			},
		},
		{
			type: "message",
			id: "sibling-result",
			parentId: "assistant",
			timestamp: "2026-01-01T00:00:02Z",
			message: {
				role: "toolResult",
				toolCallId: "sibling",
				toolName: "read",
				content: [],
				timestamp: 3,
			},
		},
	];
}

function context(files, overrides = {}) {
	return {
		cwd: files.source,
		mode: "tui",
		hasUI: true,
		model: { provider: "test-provider", id: "test-model" },
		isProjectTrusted: () => {
			throw new Error("Destination trust must not inherit source approval");
		},
		isIdle: () => {
			throw new Error("Source idleness must not be queried");
		},
		hasPendingMessages: () => {
			throw new Error("Pending input must not gate handoff");
		},
		sessionManager: {
			getHeader: () => ({
				type: "session",
				version: 3,
				id: "source-session",
				timestamp: "2026-01-01T00:00:00Z",
				cwd: files.source,
			}),
			getSessionFile: () => undefined,
			getSessionDir: () => join(files.root, "sessions"),
			getSessionId: () => "source-session",
			getBranch: sourceEntries,
		},
		...overrides,
	};
}

function harness(files, options = {}) {
	const calls = [];
	const journals = [];
	const handlers = [];
	const sessions = [...(options.sessions || [])];
	const panes = new Map(
		sessions.map((session) => [session.name, [...(session.panes || [])]]),
	);
	const git = gitDouble(options.repositories);
	let tool;
	let count = 0;
	const pi = {
		getThinkingLevel: () => "high",
		registerTool: (definition) => {
			tool = definition;
		},
		registerCommand: () => {},
		on: (event) => {
			handlers.push(event);
		},
		appendEntry: (kind, data) => {
			if (options.failJournal === data.outcome)
				throw new Error("journal unavailable");
			journals.push({ kind, data });
		},
		exec: async (binary, args, executionOptions) => {
			if (binary === "git") return git.exec(binary, args, executionOptions);
			assert.equal(binary, "tuios");
			assert.equal(args[0], "call");
			const verb = args[1];
			const params = JSON.parse(args[2]);
			calls.push({ verb, params });
			switch (verb) {
				case "list-sessions":
					return json({ type: "session_list", sessions });
				case "list-windows":
					return json({
						type: "window_list",
						windows: panes.get(params.session) || [],
					});
				case "new-session": {
					if (options.createResponse) return options.createResponse;
					const session = { name: params.name, id: `session-${++count}` };
					sessions.push(session);
					panes.set(session.name, []);
					return json({ session: session.name, session_id: session.id });
				}
				case "start-agent": {
					const session = sessions.find((item) => item.name === params.session);
					const pane = {
						window_id: `pane-${++count}`,
						workspace: 1,
						cwd: options.wrongDirectory ? files.source : files.target,
					};
					panes.get(params.session).push(pane);
					return json({
						session: params.session,
						session_id: session.id,
						...pane,
						ready: !options.failStart,
						outcome: options.failStart ? "timeout" : "ready",
					});
				}
				case "queue-prompt":
					if (options.failPrompt)
						return {
							...json({
								error: {
									code: "submission_failed",
									message: "submission rejected",
								},
							}),
							code: 1,
						};
					return json(
						options.missingQueueId ? {} : { id: `queue-${count}`, queued: 1 },
					);
				default:
					throw new Error(`Unexpected tuios operation: ${verb}`);
			}
		},
	};
	if (options.factory) branchWorkspace.default(pi);
	else registerDirectoryHandoff(pi);
	return { tool, pi, calls, journals, handlers, git };
}

async function execute(h, files, ctx = context(files)) {
	return h.tool.execute(
		"handoff-call",
		{ worktree: files.target, task: "Implement the Reading Mode tile." },
		undefined,
		undefined,
		ctx,
	);
}

for (const options of [{}, { detached: true }, { unborn: true }]) {
	test(`explicit external checkout supports ${JSON.stringify(options)}`, async (t) => {
		const files = await fixture(t);
		const target = await repository(files.target, options);
		const git = gitDouble([target]);
		const result = await resolveHandoffDirectory(
			git,
			files.source,
			files.target,
		);
		assert.equal(result.path, files.target);
		assert.equal(result.git.repoRoot, files.target);
		assert.equal(result.git.currentRef, options.detached ? "HEAD" : "main");
		assert.equal(
			result.commit,
			options.unborn ? undefined : "abcdef1234567890",
		);
		assert.ok(git.calls.every((call) => call.cwd !== files.source));
	});
}

test("plain directories, relative paths, at-prefixed selectors and symlinks work", async (t) => {
	const files = await fixture(t);
	await symlink(files.target, join(files.source, "alias"));
	const target = await resolveHandoffDirectory(
		gitDouble(),
		files.source,
		"@./alias",
	);
	assert.equal(target.path, files.target);
	assert.equal(target.git, undefined);
	assert.equal(
		(await resolveHandoffDirectory(gitDouble(), files.source, ".")).path,
		files.source,
	);
});

test("explicit subdirectories are preserved", async (t) => {
	const files = await fixture(t);
	const repo = await repository(files.target);
	const subdirectory = join(files.target, "subdirectory");
	await mkdir(subdirectory);
	const result = await resolveHandoffDirectory(
		gitDouble([repo]),
		files.source,
		subdirectory,
	);
	assert.equal(result.path, subdirectory);
	assert.equal(result.git.repoRoot, files.target);
});

test("branch shorthand and detached checkout basenames still resolve", async (t) => {
	const files = await fixture(t);
	const source = await repository(files.source, {
		worktrees: `worktree ${files.target}\0HEAD abcdef1234\0branch refs/heads/feature/read\0\0`,
	});
	const target = await repository(files.target);
	const git = gitDouble([source, target]);
	assert.equal(
		(await resolveHandoffDirectory(git, files.source, "feature/read")).path,
		files.target,
	);
	source.worktrees = `worktree ${files.target}\0HEAD abcdef1234\0detached\0\0`;
	target.detached = true;
	assert.equal(
		(await resolveHandoffDirectory(git, files.source, basename(files.target)))
			.path,
		files.target,
	);
});

test("missing and non-directory targets are rejected without mutation", async (t) => {
	const files = await fixture(t);
	await assert.rejects(
		resolveHandoffDirectory(gitDouble(), files.source, "missing"),
		/No existing destination directory/,
	);
	const path = join(files.source, "file");
	await writeFile(path, "data");
	await assert.rejects(
		resolveHandoffDirectory(gitDouble(), files.source, path),
		/not a directory/,
	);
});

test("snapshot omits the in-flight batch and supports nested tool IDs", () => {
	const entries = sourceEntries();
	for (const id of ["handoff-call", "handoff-call/nested"])
		assert.deepEqual(
			handoffSnapshotEntries(entries, id).map((entry) => entry.id),
			["user"],
		);
	assert.equal(entries.length, 3);
});

test("snapshot preserves completed calls with reused provider IDs", () => {
	const entries = sourceEntries();
	const assistant = { ...entries[1], id: "previous-assistant" };
	const result = {
		...entries[2],
		id: "previous-result",
		message: { ...entries[2].message, toolCallId: "handoff-call" },
	};
	assert.deepEqual(
		handoffSnapshotEntries(
			[entries[0], assistant, result, ...entries.slice(1)],
			"handoff-call",
		).map((entry) => entry.id),
		["user", "previous-assistant", "previous-result"],
	);
});

test("snapshots are private, durable, independent and forkable by the SDK", async (t) => {
	const files = await fixture(t);
	const path = await writeHandoffSnapshot(
		context(files),
		"handoff-call",
		"request",
	);
	const records = (await readFile(path, "utf8"))
		.trim()
		.split("\n")
		.map(JSON.parse);
	assert.notEqual(records[0].id, "source-session");
	assert.deepEqual(
		records.slice(1).map((entry) => entry.id),
		["user"],
	);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.equal(
		(await stat(join(files.root, "sessions", "handoffs"))).mode & 0o777,
		0o700,
	);
	const fork = SessionManager.forkFrom(
		path,
		files.target,
		join(files.root, "forked"),
	);
	assert.equal(fork.getCwd(), files.target);
	assert.equal(
		fork.getBranch().at(-1).message.content,
		"Do the destination task",
	);
});

test("unpersisted SDK sessions get a standalone snapshot", async (t) => {
	const files = await fixture(t);
	const manager = SessionManager.inMemory(files.source);
	manager.appendMessage({ role: "user", content: "Continue", timestamp: 1 });
	const path = await writeHandoffSnapshot(
		context(files, { sessionManager: manager }),
		"call",
		"memory",
	);
	t.after(() => rm(join(path, ".."), { recursive: true, force: true }));
	assert.ok(!path.startsWith(files.source));
	assert.equal(
		SessionManager.forkFrom(path, files.target, join(files.root, "fork"))
			.getBranch()
			.at(-1).message.content,
		"Continue",
	);
});

test("native handoff submits once without monitoring or changing focus", async (t) => {
	const files = await fixture(t);
	const h = harness(files, { factory: true });
	const result = await execute(h, files);
	assert.equal(result.isError, undefined);
	assert.equal(result.details.submitted, true);
	assert.equal(result.details.submissionStatus, "submitted");
	assert.equal(result.terminate, undefined);
	assert.deepEqual(h.handlers, []);
	assert.deepEqual(
		h.journals.map((entry) => entry.data.outcome),
		["accepted", "submitted"],
	);
	const start = h.calls.find((call) => call.verb === "start-agent");
	assert.deepEqual(start.params.args.slice(-6), [
		"--model",
		"test-provider/test-model",
		"--thinking",
		"high",
		"--name",
		"different project",
	]);
	assert.equal(start.params.focus, false);
	assert.ok(start.params.args.includes("--fork"));
	assert.ok(!start.params.args.some((arg) => arg.includes("approve")));
	const queue = h.calls.filter((call) => call.verb === "queue-prompt");
	assert.equal(queue.length, 1);
	assert.match(queue[0].params.text, /Implement the Reading Mode tile/);
	assert.ok(
		!h.calls.some((call) =>
			["wait-for", "capture-pane", "switch-session", "focus-window"].includes(
				call.verb,
			),
		),
	);
});

for (const mode of ["rpc", "print"]) {
	test(`${mode} handoff does not require a terminal or source idleness`, async (t) => {
		const files = await fixture(t);
		const h = harness(files);
		assert.equal(
			(await execute(h, files, context(files, { mode, hasUI: false }))).details
				.submitted,
			true,
		);
	});
}

for (const worktree of [true, false]) {
	test(`reuses native sessions by ${worktree ? "worktree metadata" : "pane directory"}`, async (t) => {
		const files = await fixture(t);
		const h = harness(files, {
			sessions: [
				{
					name: "existing",
					id: "existing-id",
					...(worktree ? { worktree: { path: files.target } } : {}),
					panes: [{ window_id: "old-pane", workspace: 1, cwd: files.target }],
				},
			],
		});
		const result = await execute(h, files);
		assert.equal(result.details.sessionName, "existing");
		assert.notEqual(result.details.paneId, "old-pane");
		assert.ok(!h.calls.some((call) => call.verb === "new-session"));
	});
}

test("worktree metadata takes precedence over a pane that changed directory", async (t) => {
	const files = await fixture(t);
	const h = harness(files, {
		sessions: [
			{
				name: "source",
				id: "source-id",
				worktree: { path: files.source },
				panes: [{ window_id: "old", workspace: 1, cwd: files.target }],
			},
		],
	});
	assert.notEqual((await execute(h, files)).details.sessionName, "source");
});

test("concurrent handoffs use independent panes and agents without a global reservation", async (t) => {
	const files = await fixture(t);
	const h = harness(files);
	const results = await Promise.all([execute(h, files), execute(h, files)]);
	assert.ok(results.every((result) => result.details.submitted));
	assert.notEqual(results[0].details.agentName, results[1].details.agentName);
	assert.notEqual(results[0].details.paneId, results[1].details.paneId);
});

test("snapshot failure stops before destination mutation", async (t) => {
	const files = await fixture(t);
	const path = join(files.root, "file");
	await writeFile(path, "data");
	const ctx = context(files);
	ctx.sessionManager.getSessionDir = () => path;
	const h = harness(files);
	const result = await execute(h, files, ctx);
	assert.equal(result.details.error.kind, "snapshot");
	assert.ok(!h.calls.some((call) => call.verb === "new-session"));
});

for (const options of [{ failStart: true }, { wrongDirectory: true }]) {
	test(`unconfirmed startup is never retried or submitted: ${JSON.stringify(options)}`, async (t) => {
		const files = await fixture(t);
		const h = harness(files, options);
		const result = await execute(h, files);
		assert.equal(result.isError, true);
		assert.equal(result.details.error.kind, "agent");
		assert.equal(result.details.submitted, false);
		assert.equal(result.details.submissionStatus, "not_attempted");
		assert.equal(
			h.calls.filter((call) => call.verb === "start-agent").length,
			1,
		);
		assert.ok(!h.calls.some((call) => call.verb === "queue-prompt"));
	});
}

for (const options of [{ failPrompt: true }, { missingQueueId: true }]) {
	test(`queue failures are partial and not silently retried: ${JSON.stringify(options)}`, async (t) => {
		const files = await fixture(t);
		const h = harness(files, options);
		const result = await execute(h, files);
		assert.equal(result.isError, true);
		assert.equal(result.details.error.kind, "tuios");
		assert.equal(result.details.submissionStatus, "unconfirmed");
		assert.equal(
			h.calls.filter((call) => call.verb === "queue-prompt").length,
			1,
		);
		assert.equal(h.journals.at(-1).data.outcome, "partial");
	});
}

test("post-submission journal failures preserve the known submission state", async (t) => {
	const files = await fixture(t);
	const h = harness(files, { failJournal: "submitted" });
	const result = await execute(h, files);
	assert.equal(result.isError, true);
	assert.equal(result.details.submitted, true);
	assert.equal(result.details.error.kind, "journal");
	assert.equal(
		h.calls.filter((call) => call.verb === "queue-prompt").length,
		1,
	);
});

test("malformed creation responses warn about possible side effects", async (t) => {
	const files = await fixture(t);
	const h = harness(files, { createResponse: ok("invalid-json") });
	const result = await execute(h, files);
	assert.equal(result.isError, true);
	assert.equal(result.details.destinationMayExist, true);
	assert.match(result.content[0].text, /do not resubmit blindly/);
	assert.ok(!h.calls.some((call) => call.verb === "start-agent"));
});

test("the exported Git resolver still accepts external detached checkouts", async (t) => {
	const files = await fixture(t);
	const repo = await repository(files.target, { detached: true });
	const result = await branchWorkspace.resolveAutomatedWorktreeTarget(
		gitDouble([repo]),
		{},
		files.source,
		files.target,
	);
	assert.equal(result.worktreePath, files.target);
	assert.equal(result.branchRef, "HEAD");
});
