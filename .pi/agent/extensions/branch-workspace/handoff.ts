import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TuiosClient, TuiosError, tuiosBinary } from "../tuios/client.ts";
import {
	getTuiosState,
	type NativeDestination,
	type NativeState,
	openTuiosDestination,
	startForkedAgent,
	submitHandoff,
} from "../tuios/runtime.ts";

const TOOL_NAME = "branch_workspace_handoff";
const JOURNAL_TYPE = "branch-workspace-handoff";
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_SELECTOR_LENGTH = 4_096;
const MAX_TASK_LENGTH = 12_000;
const REQUEST_ID_LENGTH = 10;
const MAX_AGENT_NAME_LENGTH = 32;

const parameters = Type.Object(
	{
		worktree: Type.String({
			minLength: 1,
			maxLength: MAX_SELECTOR_LENGTH,
			description:
				"Existing destination directory, a local worktree branch, or checkout directory name",
		}),
		task: Type.String({
			minLength: 1,
			maxLength: MAX_TASK_LENGTH,
			description: "Task to begin in the destination",
		}),
	},
	{ additionalProperties: false },
);

enum LaunchStage {
	Invalid = 0,
	Prepared,
	OpeningDestination,
	DestinationCreated,
	Submitting,
	Submitted,
}

enum HandoffOutcome {
	Invalid = 0,
	Accepted,
	Submitted,
	Partial,
	Failed,
}

enum HandoffErrorKind {
	Invalid = 0,
	Validation,
	Git,
	Tuios,
	Snapshot,
	Agent,
	Journal,
	Unknown,
}

class HandoffError extends Error {
	constructor(
		readonly kind: HandoffErrorKind,
		message: string,
	) {
		super(message);
	}
}

function submissionStatus(stage: LaunchStage): string {
	switch (stage) {
		case LaunchStage.Submitted:
			return "submitted";
		case LaunchStage.Submitting:
			return "unconfirmed";
		case LaunchStage.Prepared:
		case LaunchStage.OpeningDestination:
		case LaunchStage.DestinationCreated:
			return "not_attempted";
		case LaunchStage.Invalid:
			throw new Error("Invalid handoff launch stage.");
	}
}

function outcomeValue(outcome: HandoffOutcome): string {
	switch (outcome) {
		case HandoffOutcome.Accepted:
			return "accepted";
		case HandoffOutcome.Submitted:
			return "submitted";
		case HandoffOutcome.Partial:
			return "partial";
		case HandoffOutcome.Failed:
			return "failed";
		case HandoffOutcome.Invalid:
			throw new Error("Invalid handoff outcome.");
	}
}

function errorKindValue(kind: HandoffErrorKind): string {
	switch (kind) {
		case HandoffErrorKind.Validation:
			return "validation";
		case HandoffErrorKind.Git:
			return "git";
		case HandoffErrorKind.Tuios:
			return "tuios";
		case HandoffErrorKind.Snapshot:
			return "snapshot";
		case HandoffErrorKind.Agent:
			return "agent";
		case HandoffErrorKind.Journal:
			return "journal";
		case HandoffErrorKind.Unknown:
			return "unknown";
		case HandoffErrorKind.Invalid:
			throw new Error("Invalid handoff error kind.");
	}
}

export type HandoffGitContext = {
	repoRoot: string;
	primaryWorktreePath: string;
	repoName: string;
	commonDir: string;
	currentRef: string;
};

export type HandoffDirectory = {
	path: string;
	name: string;
	git?: HandoffGitContext;
	commit?: string;
	branchRef?: string;
};

type Destination = NativeDestination;
type AgentConfig = {
	model: string;
	thinkingLevel: string;
	sessionName: string;
};
type HandoffDependencies = {
	startAgent: (
		bin: string,
		destination: Destination,
		sessionFile: string,
		agentName: string,
		config: AgentConfig,
		signal?: AbortSignal,
	) => Promise<NativeDestination>;
};

type CommandResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
};

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalize(value: string, field: string, maximum: number): string {
	const text = value.replaceAll("\r\n", "\n").trim();
	if (!text || text.length > maximum || /[^\P{Cc}\n\t]/u.test(text)) {
		throw new HandoffError(
			HandoffErrorKind.Validation,
			`${field} must contain 1–${maximum} characters without unsupported control characters.`,
		);
	}
	return text;
}

async function command(
	pi: ExtensionAPI,
	binary: string,
	args: string[],
	cwd?: string,
	signal?: AbortSignal,
): Promise<CommandResult> {
	return pi.exec(binary, args, { cwd, signal, timeout: COMMAND_TIMEOUT_MS });
}

async function checkedCommand(
	pi: ExtensionAPI,
	binary: string,
	args: string[],
	cwd?: string,
	signal?: AbortSignal,
): Promise<CommandResult> {
	let result: CommandResult;
	try {
		result = await command(pi, binary, args, cwd, signal);
	} catch (error) {
		throw new HandoffError(
			binary === "git" ? HandoffErrorKind.Git : HandoffErrorKind.Tuios,
			errorText(error),
		);
	}
	if (result.code !== 0 || result.killed) {
		throw new HandoffError(
			binary === "git" ? HandoffErrorKind.Git : HandoffErrorKind.Tuios,
			`${binary} ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout || `exit ${result.code}`).trim()}`,
		);
	}
	return result;
}

async function gitContext(
	pi: ExtensionAPI,
	cwd: string,
	signal?: AbortSignal,
): Promise<HandoffGitContext | undefined> {
	let root: CommandResult;
	try {
		root = await command(
			pi,
			"git",
			["rev-parse", "--show-toplevel"],
			cwd,
			signal,
		);
	} catch (error) {
		signal?.throwIfAborted();
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (root.code !== 0 || root.killed) {
		signal?.throwIfAborted();
		if (root.killed)
			throw new HandoffError(
				HandoffErrorKind.Git,
				"Git repository discovery timed out.",
			);
		return undefined;
	}
	const repoRoot = await realpath(root.stdout.trim());
	const common = await checkedCommand(
		pi,
		"git",
		["rev-parse", "--git-common-dir"],
		repoRoot,
		signal,
	);
	const commonDir = await realpath(resolve(repoRoot, common.stdout.trim()));
	const list = await checkedCommand(
		pi,
		"git",
		["worktree", "list", "--porcelain", "-z"],
		repoRoot,
		signal,
	);
	const primary = list.stdout
		.split("\0")
		.find((field) => field.startsWith("worktree "));
	const primaryWorktreePath = primary
		? await realpath(primary.slice("worktree ".length))
		: repoRoot;
	const branch = await command(
		pi,
		"git",
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		repoRoot,
		signal,
	);
	if (branch.killed || (branch.code !== 0 && branch.code !== 1)) {
		throw new HandoffError(
			HandoffErrorKind.Git,
			"Could not determine the destination Git ref.",
		);
	}
	return {
		repoRoot,
		primaryWorktreePath,
		commonDir,
		repoName: basename(primaryWorktreePath),
		currentRef: branch.code === 0 ? branch.stdout.trim() : "HEAD",
	};
}

async function directoryTarget(
	pi: ExtensionAPI,
	path: string,
	signal?: AbortSignal,
): Promise<HandoffDirectory> {
	const canonical = await realpath(path);
	if (!(await stat(canonical)).isDirectory())
		throw new HandoffError(
			HandoffErrorKind.Validation,
			`Handoff destination is not a directory: ${path}`,
		);
	const git = await gitContext(pi, canonical, signal);
	if (!git)
		return { path: canonical, name: basename(canonical) || "workspace" };
	const head = await command(
		pi,
		"git",
		["rev-parse", "--verify", "HEAD^{commit}"],
		git.repoRoot,
		signal,
	);
	if (head.killed || (head.code !== 0 && git.currentRef === "HEAD")) {
		throw new HandoffError(
			HandoffErrorKind.Git,
			"Could not determine the destination Git commit.",
		);
	}
	return {
		path: canonical,
		name: basename(canonical) || git.repoName,
		git,
		commit: head.code === 0 ? head.stdout.trim() : undefined,
		branchRef:
			git.currentRef === "HEAD" ? undefined : `refs/heads/${git.currentRef}`,
	};
}

export async function resolveHandoffDirectory(
	pi: ExtensionAPI,
	cwd: string,
	selectorInput: string,
	signal?: AbortSignal,
): Promise<HandoffDirectory> {
	const selector = normalize(
		selectorInput.replace(/^@(?=\S)/, ""),
		"Destination",
		MAX_SELECTOR_LENGTH,
	);
	const expanded =
		selector === "~"
			? homedir()
			: selector.startsWith("~/")
				? join(homedir(), selector.slice(2))
				: selector;
	const path = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	try {
		return await directoryTarget(pi, path, signal);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
	}

	const source = await gitContext(pi, cwd, signal);
	if (source) {
		const result = await checkedCommand(
			pi,
			"git",
			["worktree", "list", "--porcelain", "-z"],
			source.repoRoot,
			signal,
		);
		const matches = new Set<string>();
		for (const record of result.stdout.split("\0\0")) {
			const fields = record.split("\0");
			const worktree = fields
				.find((field) => field.startsWith("worktree "))
				?.slice("worktree ".length);
			const branch = fields
				.find((field) => field.startsWith("branch "))
				?.slice("branch ".length);
			if (
				!worktree ||
				fields.some(
					(field) => field === "prunable" || field.startsWith("prunable "),
				)
			)
				continue;
			if (
				selector === branch ||
				selector === branch?.replace(/^refs\/heads\//, "") ||
				selector === basename(worktree)
			) {
				matches.add(worktree);
			}
		}
		if (matches.size > 1)
			throw new HandoffError(
				HandoffErrorKind.Validation,
				`Destination selector is ambiguous: ${[...matches].join(", ")}. Use a directory path.`,
			);
		const match = matches.values().next().value;
		if (match) return directoryTarget(pi, match, signal);
	}
	throw new HandoffError(
		HandoffErrorKind.Validation,
		`No existing destination directory matches ${JSON.stringify(selector)}.`,
	);
}

export function handoffSnapshotEntries(
	entries: readonly SessionEntry[],
	toolCallId: string,
): SessionEntry[] {
	const pending = entries.findLastIndex(
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.content.some(
				(part) =>
					part.type === "toolCall" &&
					(part.id === toolCallId || toolCallId.startsWith(`${part.id}/`)),
			),
	);
	// Exclude the in-flight tool batch instead of waiting for its results to persist.
	return [...(pending < 0 ? entries : entries.slice(0, pending))];
}

export async function writeHandoffSnapshot(
	ctx: ExtensionContext,
	toolCallId: string,
	requestId: string,
): Promise<string> {
	const header = ctx.sessionManager.getHeader();
	if (!header)
		throw new HandoffError(
			HandoffErrorKind.Validation,
			"The source session has no header to fork.",
		);
	const entries = handoffSnapshotEntries(
		ctx.sessionManager.getBranch(),
		toolCallId,
	);
	const sessionDirectory = ctx.sessionManager.getSessionDir();
	const directory = sessionDirectory
		? join(sessionDirectory, "handoffs")
		: await mkdtemp(join(tmpdir(), "pi-handoff-"));
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, `${requestId}.jsonl`);
	const snapshot = {
		...header,
		id: randomUUID(),
		timestamp: new Date().toISOString(),
		parentSession: ctx.sessionManager.getSessionFile(),
	};
	const file = await open(path, "wx", 0o600);
	try {
		await file.writeFile(
			`${[snapshot, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
		await file.sync();
	} finally {
		await file.close();
	}
	return path;
}

export async function openHandoffDestination(
	pi: ExtensionAPI,
	bin: string,
	target: HandoffDirectory,
	_state: NativeState,
	requestId: string,
	signal?: AbortSignal,
): Promise<Destination> {
	return openTuiosDestination(
		new TuiosClient(pi, bin),
		target.path,
		target.name,
		requestId,
		undefined,
		signal,
	);
}

function agentName(name: string, requestId: string): string {
	const prefix = `bh-${name.toLowerCase()}`.replace(/[^a-z0-9_-]+/g, "-");
	return `${prefix.slice(0, MAX_AGENT_NAME_LENGTH - requestId.length - 1).replace(/[-_]$/g, "")}-${requestId}`;
}

export function registerDirectoryHandoff(
	pi: ExtensionAPI,
	dependencies: HandoffDependencies = {
		startAgent: (bin, destination, snapshot, name, config, signal) =>
			startForkedAgent(
				new TuiosClient(pi, bin),
				destination,
				snapshot,
				name,
				config,
				signal,
			),
	},
): void {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Workspace Handoff",
		description:
			"Fork this Pi session into any existing directory in a native tuios session, queue the task once, and return without monitoring destination progress.",
		promptSnippet:
			"Hand off a task to an independent Pi session in any existing directory",
		promptGuidelines: [
			"Use branch_workspace_handoff to transfer a task to another directory, including another repository or a detached worktree.",
			"After submission, do not monitor or wait for destination progress unless the task explicitly requires it. The source session remains available for other work.",
			"Do not duplicate the transferred task in the source session. Include only task-relevant context and constraints in the handoff.",
		],
		parameters,
		async execute(toolCallId, input, signal, onUpdate, ctx) {
			const requestId = randomUUID()
				.replaceAll("-", "")
				.slice(0, REQUEST_ID_LENGTH);
			const bin = tuiosBinary();
			const client = new TuiosClient(pi, bin);
			let target: HandoffDirectory | undefined;
			let destination: Destination | undefined;
			let snapshot: string | undefined;
			let name: string | undefined;
			let queueId: string | undefined;
			let stage = LaunchStage.Prepared;
			const journal = (outcome: HandoffOutcome, message: string) => {
				try {
					pi.appendEntry(JOURNAL_TYPE, {
						requestId,
						outcome: outcomeValue(outcome),
						message,
						timestamp: Date.now(),
						sourceSessionId: ctx.sessionManager.getSessionId(),
						targetPath: target?.path,
						targetBranch: target?.git?.currentRef,
						agentName: name,
						snapshot,
						location: destination,
						queueId,
					});
				} catch (error) {
					throw new HandoffError(HandoffErrorKind.Journal, errorText(error));
				}
			};
			try {
				const model = ctx.model;
				if (!model)
					throw new HandoffError(
						HandoffErrorKind.Validation,
						"No active Pi model is selected.",
					);
				const task = normalize(input.task, "Handoff task", MAX_TASK_LENGTH);
				target = await resolveHandoffDirectory(
					pi,
					ctx.cwd,
					input.worktree,
					signal,
				);
				const state = await getTuiosState(client, signal);
				try {
					snapshot = await writeHandoffSnapshot(ctx, toolCallId, requestId);
				} catch (error) {
					if (error instanceof HandoffError) throw error;
					throw new HandoffError(HandoffErrorKind.Snapshot, errorText(error));
				}
				name = agentName(target.name, requestId);
				journal(
					HandoffOutcome.Accepted,
					"Destination and session snapshot are ready.",
				);
				onUpdate?.({
					content: [{ type: "text", text: `Launching Pi in ${target.path}…` }],
					details: { requestId },
				});
				stage = LaunchStage.OpeningDestination;
				destination = await openHandoffDestination(
					pi,
					bin,
					target,
					state,
					requestId,
					signal,
				);
				stage = LaunchStage.DestinationCreated;
				try {
					destination = await dependencies.startAgent(
						bin,
						destination,
						snapshot,
						name,
						{
							model: `${model.provider}/${model.id}`,
							thinkingLevel: pi.getThinkingLevel(),
							sessionName: target.name,
						},
						signal,
					);
				} catch (error) {
					throw new HandoffError(HandoffErrorKind.Agent, errorText(error));
				}
				stage = LaunchStage.Submitting;
				queueId = await submitHandoff(
					client,
					destination,
					`Continue this task in ${target.path}:\n\n${task}`,
					signal,
				);
				stage = LaunchStage.Submitted;
				journal(
					HandoffOutcome.Submitted,
					"Task submitted; destination progress is not monitored.",
				);
				return {
					content: [
						{
							type: "text",
							text: `Task queued for Pi ${name} in ${target.path}; queue ${queueId}.`,
						},
					],
					details: {
						accepted: true,
						submitted: true,
						submissionStatus: submissionStatus(stage),
						requestId,
						targetPath: target.path,
						agentName: name,
						...destination,
						queueId,
					},
				};
			} catch (error) {
				const message = errorText(error);
				let journalError: string | undefined;
				try {
					journal(
						stage === LaunchStage.Prepared
							? HandoffOutcome.Failed
							: HandoffOutcome.Partial,
						message,
					);
				} catch (failure) {
					journalError = errorText(failure);
				}
				const destinationMayExist = stage !== LaunchStage.Prepared;
				const location = destination
					? ` Destination: ${destination.sessionName}/${destination.paneId || "not-started"}; agent ${name}.`
					: "";
				const recovery = destinationMayExist
					? " Destination creation was attempted; do not resubmit blindly."
					: "";
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Handoff failed: ${message}.${location}${recovery}${journalError ? ` Journal failure: ${journalError}` : ""}`,
						},
					],
					details: {
						accepted: Boolean(destination),
						submitted: stage === LaunchStage.Submitted,
						submissionStatus: submissionStatus(stage),
						destinationMayExist,
						requestId,
						targetPath: target?.path,
						agentName: name,
						location: destination,
						snapshot,
						error: {
							kind: errorKindValue(
								error instanceof HandoffError
									? error.kind
									: error instanceof TuiosError
										? HandoffErrorKind.Tuios
										: HandoffErrorKind.Unknown,
							),
							message,
						},
						journalError,
					},
				};
			}
		},
	});
}
