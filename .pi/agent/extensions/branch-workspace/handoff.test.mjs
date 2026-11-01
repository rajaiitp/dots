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
const json = (result) => ok(JSON.stringify({ result }));
const failure = (stderr = "not a git repository") => ({
	code: 128,
	stdout: "",
	stderr,
	killed: false,
});

async function fixture(t) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "pi-directory-handoff-")),
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
			"handoff must not inspect or mutate WIP",
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
	const starts = [];
	const focuses = [];
	let tool;
	const git = gitDouble(options.repositories);
	let createCount = 0;
	let startCount = 0;
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
			calls.push({ binary, args });
			if (binary === "git") return git.exec(binary, args, executionOptions);
			if (args[0] === "pane" && args[1] === "list")
				return json({ panes: options.panes || [] });
			if (args[0] === "workspace" && args[1] === "list")
				return json({ workspaces: options.workspaces || [] });
			if (
				(args[0] === "workspace" || args[0] === "tab") &&
				args[1] === "create"
			) {
				if (options.createResponse) return options.createResponse;
				createCount += 1;
				const workspaceId =
					args[0] === "tab"
						? args[args.indexOf("--workspace") + 1]
						: `workspace-${createCount}`;
				return json({
					workspace: { workspace_id: workspaceId },
					root_pane: {
						pane_id: `pane-${createCount}`,
						tab_id: `tab-${createCount}`,
						workspace_id: workspaceId,
						cwd: files.target,
					},
				});
			}
			if (args[0] === "agent" && args[1] === "start") {
				startCount += 1;
				if (
					startCount <= (options.startBusyCount || 0) ||
					options.startFailure
				) {
					return {
						code: 1,
						stdout: "",
						stderr: JSON.stringify({
							error: {
								code: options.startFailure || "agent_pane_busy",
								message: "startup refused",
							},
						}),
						killed: false,
					};
				}
				return json({ started: true });
			}
			if (args[0] === "agent" && args[1] === "get" && options.confirmStarted) {
				return json({
					agent: {
						name: args[2],
						agent: "pi",
						pane_id: "pane-1",
						agent_status: "idle",
					},
				});
			}
			if (args[1] === "focus") return json({ focused: true });
			if (args[0] === "agent" && args[1] === "prompt") {
				assert.equal(
					args.length,
					4,
					"prompt submission must have no wait or progress options",
				);
				if (options.failPrompt)
					return ok(
						JSON.stringify({
							error: {
								code: "submission_failed",
								message: "submission rejected",
							},
						}),
					);
				return json({ submitted: true });
			}
			throw new Error(`Unexpected Herdr operation: ${args.join(" ")}`);
		},
	};
	const dependencies = {
		startAgent: async (...args) => {
			starts.push(args);
			if (options.failStart) throw new Error("agent startup failed");
		},
		focusDestination: async (...args) => {
			focuses.push(args);
			if (options.failFocus) throw new Error("focus unavailable");
		},
	};
	if (options.factory) branchWorkspace.default(pi);
	else registerDirectoryHandoff(pi, dependencies);
	return { tool, pi, calls, journals, handlers, starts, focuses, git };
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

test("explicit directory in another repository uses destination Git metadata", async (t) => {
	const files = await fixture(t);
	const source = await repository(files.source);
	const target = await repository(files.target);
	const git = gitDouble([source, target]);
	const result = await resolveHandoffDirectory(git, files.source, files.target);
	assert.equal(result.path, files.target);
	assert.equal(result.git.repoRoot, files.target);
	assert.equal(result.git.commonDir, join(files.target, ".git"));
	assert.ok(git.calls.every((call) => call.cwd !== files.source));
});

test("accepts detached worktrees without requiring a branch", async (t) => {
	const files = await fixture(t);
	const target = await repository(files.target, { detached: true });
	const result = await resolveHandoffDirectory(
		gitDouble([target]),
		files.source,
		files.target,
	);
	assert.equal(result.git.currentRef, "HEAD");
	assert.equal(result.branchRef, undefined);
	assert.equal(result.commit, "abcdef1234567890");
});

test("accepts an unborn Git checkout", async (t) => {
	const files = await fixture(t);
	const result = await resolveHandoffDirectory(
		gitDouble([await repository(files.target, { unborn: true })]),
		files.source,
		files.target,
	);
	assert.equal(result.commit, undefined);
	assert.equal(result.branchRef, "refs/heads/main");
});

test("accepts non-Git source and destination directories", async (t) => {
	const files = await fixture(t);
	const result = await resolveHandoffDirectory(
		gitDouble(),
		files.source,
		files.target,
	);
	assert.equal(result.path, files.target);
	assert.equal(result.git, undefined);
});

test("resolves relative paths, spaces, at-prefixed selectors, and symlinks", async (t) => {
	const files = await fixture(t);
	const alias = join(files.source, "alias");
	await symlink(files.target, alias);
	const result = await resolveHandoffDirectory(
		gitDouble(),
		files.source,
		"@./alias",
	);
	assert.equal(result.path, files.target);
	assert.equal(result.name, "different project");
});

test("preserves an explicitly selected subdirectory", async (t) => {
	const files = await fixture(t);
	const target = await repository(files.target);
	const subdirectory = join(files.target, "subdirectory");
	await mkdir(subdirectory);
	const result = await resolveHandoffDirectory(
		gitDouble([target]),
		files.source,
		subdirectory,
	);
	assert.equal(result.path, subdirectory);
	assert.equal(result.git.repoRoot, files.target);
});

test("allows handoff to the current directory", async (t) => {
	const files = await fixture(t);
	assert.equal(
		(await resolveHandoffDirectory(gitDouble(), files.source, ".")).path,
		files.source,
	);
});

test("retains branch shorthand and accepts detached checkout basename", async (t) => {
	const files = await fixture(t);
	const source = await repository(files.source, {
		worktrees: `worktree ${files.source}\0HEAD abcdef1234\0branch refs/heads/main\0\0worktree ${files.target}\0HEAD abcdef1234\0branch refs/heads/feature/read\0\0`,
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

test("rejects missing and non-directory targets without creating them", async (t) => {
	const files = await fixture(t);
	await assert.rejects(
		resolveHandoffDirectory(gitDouble(), files.source, "missing"),
		/No existing destination directory/,
	);
	const file = join(files.source, "file");
	await writeFile(file, "data");
	await assert.rejects(
		resolveHandoffDirectory(gitDouble(), files.source, file),
		/not a directory/,
	);
});

test("snapshot omits the in-flight batch and its partial sibling results", () => {
	const entries = sourceEntries();
	assert.deepEqual(
		handoffSnapshotEntries(entries, "handoff-call").map((entry) => entry.id),
		["user"],
	);
	assert.deepEqual(
		handoffSnapshotEntries(entries, "handoff-call/nested").map(
			(entry) => entry.id,
		),
		["user"],
	);
	assert.equal(entries.length, 3);
});

test("snapshot keeps completed history when a provider reuses a tool-call ID", () => {
	const entries = sourceEntries();
	const previousAssistant = {
		...entries[1],
		id: "previous-assistant",
		message: {
			...entries[1].message,
			content: [entries[1].message.content[0]],
		},
	};
	const previousResult = {
		...entries[2],
		id: "previous-result",
		message: {
			...entries[2].message,
			toolCallId: "handoff-call",
			toolName: "branch_workspace_handoff",
		},
	};
	const history = [
		entries[0],
		previousAssistant,
		previousResult,
		...entries.slice(1),
	];
	assert.deepEqual(
		handoffSnapshotEntries(history, "handoff-call").map((entry) => entry.id),
		["user", "previous-assistant", "previous-result"],
	);
});

test("snapshot is private, durable, independent, and supports unpersisted sources", async (t) => {
	const files = await fixture(t);
	const ctx = context(files);
	const snapshot = await writeHandoffSnapshot(ctx, "handoff-call", "request");
	const records = (await readFile(snapshot, "utf8"))
		.trim()
		.split("\n")
		.map(JSON.parse);
	assert.notEqual(records[0].id, "source-session");
	assert.equal(records[0].cwd, files.source);
	assert.deepEqual(
		records.slice(1).map((entry) => entry.id),
		["user"],
	);
	assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
	assert.equal(
		(await stat(join(files.root, "sessions", "handoffs"))).mode & 0o777,
		0o700,
	);
});

test("real in-memory SDK sessions fork the snapshot into the destination", async (t) => {
	const files = await fixture(t);
	const manager = SessionManager.inMemory(files.source);
	manager.appendMessage({
		role: "user",
		content: "Continue the destination task",
		timestamp: 1,
	});
	const ctx = context(files, { sessionManager: manager });
	assert.equal(manager.getSessionDir(), "");
	const snapshot = await writeHandoffSnapshot(
		ctx,
		"handoff-call",
		"sdk-request",
	);
	t.after(() => rm(join(snapshot, ".."), { recursive: true, force: true }));
	assert.ok(!snapshot.startsWith(files.source));
	const fork = SessionManager.forkFrom(
		snapshot,
		files.target,
		join(files.root, "forked-sessions"),
	);
	assert.equal(fork.getCwd(), files.target);
	assert.notEqual(fork.getSessionId(), manager.getSessionId());
	assert.equal(
		fork.getBranch().at(-1).message.content,
		"Continue the destination task",
	);
});

test("successful submission neither waits for progress nor terminates the source", async (t) => {
	const files = await fixture(t);
	const h = harness(files);
	const result = await execute(h, files);
	assert.equal(result.isError, undefined);
	assert.equal(result.terminate, undefined);
	assert.equal(result.details.submitted, true);
	assert.equal(result.details.submissionStatus, "submitted");
	assert.deepEqual(
		h.handlers,
		[],
		"no source input, tool, settlement, or shutdown locks",
	);
	assert.equal(h.starts.length, 1);
	assert.equal(h.starts[0][4].model, "test-provider/test-model");
	assert.equal(h.starts[0][4].thinkingLevel, "high");
	assert.equal(h.focuses.length, 1);
	assert.deepEqual(
		h.journals.map((entry) => entry.data.outcome),
		["accepted", "submitted"],
	);
	const prompt = h.calls.find((call) => call.args[0] === "agent");
	assert.match(prompt.args[3], /Implement the Reading Mode tile\./);
	assert.doesNotMatch(
		prompt.args[3],
		/wait|acknowledge|inspect git status|do not send work back/i,
	);
	assert.ok(
		!h.calls.some((call) =>
			call.args.some((arg) =>
				["--wait", "--until", "get", "read", "watch"].includes(arg),
			),
		),
	);
});

test("RPC and print callers do not require TUI, Herdr environment, or focus", async (t) => {
	const files = await fixture(t);
	for (const mode of ["rpc", "print"]) {
		const h = harness(files);
		const result = await execute(
			h,
			files,
			context(files, { mode, hasUI: false }),
		);
		assert.equal(result.details.submitted, true);
		assert.equal(h.focuses.length, 0);
	}
});

test("reuses an existing repository workspace without source-repo registration requirements", async (t) => {
	const files = await fixture(t);
	const h = harness(files, {
		workspaces: [
			{
				workspace_id: "external-workspace",
				worktree: { checkout_path: files.target, repo_key: files.target },
			},
		],
	});
	const result = await execute(h, files);
	assert.equal(result.details.workspaceId, "external-workspace");
	assert.ok(
		h.calls.some((call) => call.args[0] === "tab" && call.args[1] === "create"),
	);
	assert.ok(
		!h.calls.some(
			(call) => call.args[0] === "workspace" && call.args[1] === "create",
		),
	);
});

test("reuses plain-directory workspaces based on their pane directory", async (t) => {
	const files = await fixture(t);
	const h = harness(files, {
		workspaces: [{ workspace_id: "plain-workspace" }],
		panes: [{ workspace_id: "plain-workspace", cwd: files.target }],
	});
	assert.equal(
		(await execute(h, files)).details.workspaceId,
		"plain-workspace",
	);
});

test("does not reuse a different repository workspace just because a pane changed directories", async (t) => {
	const files = await fixture(t);
	const h = harness(files, {
		workspaces: [
			{
				workspace_id: "source-workspace",
				worktree: { checkout_path: files.source },
			},
		],
		panes: [{ workspace_id: "source-workspace", cwd: files.target }],
	});
	assert.equal((await execute(h, files)).details.workspaceId, "workspace-1");
});

test("independent handoffs can run concurrently without a global reservation", async (t) => {
	const files = await fixture(t);
	const h = harness(files);
	const results = await Promise.all([execute(h, files), execute(h, files)]);
	assert.ok(results.every((result) => result.details.submitted));
	assert.notEqual(results[0].details.agentName, results[1].details.agentName);
	assert.notEqual(h.starts[0][2], h.starts[1][2]);
});

test("snapshot persistence failure stops before destination mutation", async (t) => {
	const files = await fixture(t);
	const notDirectory = join(files.root, "file");
	await writeFile(notDirectory, "data");
	const ctx = context(files);
	ctx.sessionManager.getSessionDir = () => notDirectory;
	const h = harness(files);
	const result = await execute(h, files, ctx);
	assert.equal(result.isError, true);
	assert.equal(result.details.error.kind, "snapshot");
	assert.equal(h.starts.length, 0);
	assert.ok(!h.calls.some((call) => call.args[1] === "create"));
});

test("launch failure reports destination identifiers without resubmission or monitoring", async (t) => {
	const files = await fixture(t);
	const h = harness(files, { failStart: true });
	const result = await execute(h, files);
	assert.equal(result.isError, true);
	assert.equal(result.details.error.kind, "agent");
	assert.equal(result.details.location.paneId, "pane-1");
	assert.equal(result.details.submitted, false);
	assert.equal(result.details.submissionStatus, "not_attempted");
	assert.equal(h.starts.length, 1);
	assert.ok(!h.calls.some((call) => call.args[0] === "agent"));
});

test("prompt transport rejection is a partial failure, not successful task execution", async (t) => {
	const files = await fixture(t);
	const h = harness(files, { failPrompt: true });
	const result = await execute(h, files);
	assert.equal(result.isError, true);
	assert.equal(result.details.error.kind, "herdr");
	assert.equal(result.details.submitted, false);
	assert.equal(result.details.submissionStatus, "unconfirmed");
	assert.equal(h.calls.filter((call) => call.args[1] === "prompt").length, 1);
	assert.equal(h.journals.at(-1).data.outcome, "partial");
});

test("post-submission journal failure is reported without hiding that the task was sent", async (t) => {
	const files = await fixture(t);
	const h = harness(files, { failJournal: "submitted" });
	const result = await execute(h, files);
	assert.equal(result.isError, true);
	assert.equal(result.details.submitted, true);
	assert.equal(result.details.error.kind, "journal");
	assert.equal(h.calls.filter((call) => call.args[1] === "prompt").length, 1);
});

test("malformed destination responses warn that creation may have happened", async (t) => {
	const files = await fixture(t);
	const h = harness(files, { createResponse: ok("invalid-json") });
	const result = await execute(h, files);
	assert.equal(result.isError, true);
	assert.equal(result.details.destinationMayExist, true);
	assert.match(result.content[0].text, /do not resubmit blindly/);
	assert.equal(h.starts.length, 0);
});

test("the installed extension factory launches a fork and submits without lifecycle guards", async (t) => {
	const files = await fixture(t);
	const h = harness(files, { factory: true });
	const result = await execute(h, files);
	assert.equal(result.details.submitted, true);
	assert.deepEqual(h.handlers, []);
	const start = h.calls.find(
		(call) => call.args[0] === "agent" && call.args[1] === "start",
	);
	assert.ok(start.args.includes("--fork"));
	assert.ok(start.args.includes("--model"));
	assert.ok(!start.args.includes("--approve"));
	assert.ok(!start.args.includes("--no-approve"));
	assert.ok(
		!h.calls.some(
			(call) => call.args.includes("--wait") || call.args.includes("--until"),
		),
	);
});

test("the installed launcher waits for a fresh shell and submits the task once", async (t) => {
	const files = await fixture(t);
	const h = harness(files, { factory: true, startBusyCount: 1 });
	const result = await execute(h, files);
	assert.equal(result.isError, undefined);
	assert.equal(result.details.submitted, true);
	const starts = h.calls.filter(
		(call) => call.args[0] === "agent" && call.args[1] === "start",
	);
	assert.equal(starts.length, 2);
	assert.deepEqual(starts[0].args, starts[1].args);
	assert.equal(h.calls.filter((call) => call.args[1] === "create").length, 1);
	assert.equal(h.calls.filter((call) => call.args[1] === "prompt").length, 1);
	assert.ok(
		!h.calls.some(
			(call) =>
				call.args[0] === "agent" &&
				["get", "list", "wait"].includes(call.args[1]),
		),
	);
});

test("the installed launcher reconciles a false startup exit before submitting once", async (t) => {
	const files = await fixture(t);
	const h = harness(files, {
		factory: true,
		startFailure: "agent_start_failed",
		confirmStarted: true,
	});
	const result = await execute(h, files);
	assert.equal(result.isError, undefined);
	assert.equal(result.details.submitted, true);
	assert.equal(h.calls.filter((call) => call.args[1] === "start").length, 1);
	assert.equal(h.calls.filter((call) => call.args[1] === "get").length, 1);
	assert.equal(h.calls.filter((call) => call.args[1] === "prompt").length, 1);
	assert.ok(
		h.calls.findIndex((call) => call.args[1] === "get") <
			h.calls.findIndex((call) => call.args[1] === "prompt"),
	);
});

test("the installed launcher never retries an agent that may already have started", async (t) => {
	const files = await fixture(t);
	const h = harness(files, { factory: true, startFailure: "agent_not_ready" });
	const result = await execute(h, files);
	assert.equal(result.isError, true);
	assert.equal(result.details.submissionStatus, "not_attempted");
	assert.equal(h.calls.filter((call) => call.args[1] === "start").length, 1);
	assert.equal(h.calls.filter((call) => call.args[1] === "prompt").length, 0);
});

test("the exported Git resolver remains compatible and supports external detached checkouts", async (t) => {
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
	assert.equal(result.expectedCommit, "abcdef1234567890");
});

test("contradictory destination identifiers never launch an agent", async (t) => {
	const files = await fixture(t);
	const response = json({
		workspace: { workspace_id: "wrong-workspace" },
		root_pane: {
			pane_id: "new-pane",
			tab_id: "new-tab",
			workspace_id: "actual-workspace",
			cwd: files.target,
		},
	});
	const h = harness(files, { createResponse: response });
	const result = await execute(h, files);
	assert.equal(result.isError, true);
	assert.equal(result.details.error.kind, "herdr");
	assert.equal(h.starts.length, 0);
});

test("focus failure does not obscure accepted prompt submission", async (t) => {
	const files = await fixture(t);
	const result = await execute(harness(files, { failFocus: true }), files);
	assert.equal(result.details.submitted, true);
	assert.match(result.details.warning, /focus unavailable/);
});
