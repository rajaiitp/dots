import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	SelectList,
	Text,
	type SelectItem,
} from "@earendil-works/pi-tui";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Type, type Static } from "typebox";

const COMMAND_NAME = "branch-workspace";
const AUTOMATED_HANDOFF_TOOL_NAME = "branch_workspace_handoff";
const AUTOMATED_HANDOFF_ENTRY_TYPE = "branch-workspace-handoff";
const HERDR_DEFAULT_BIN = "herdr";
const GIT_BIN = "git";
const EXTERNAL_COMMAND_TIMEOUT_MS = 30_000;
const WORKTREE_CREATE_TIMEOUT_MS = 120_000;
const AGENT_START_TIMEOUT_MS = 120_000;
const HANDOFF_TIMEOUT_MS = 180_000;
const AUTOMATED_HANDOFF_START_TIMEOUT_MS = 15_000;
const REMOTE_FETCH_TIMEOUT_MS = 180_000;
const MAX_AGENT_NAME_LENGTH = 32;
const MAX_WORKTREE_SELECTOR_LENGTH = 4_096;
const MAX_HANDOFF_TASK_LENGTH = 12_000;
const AUTOMATED_HANDOFF_ID_LENGTH = 10;
const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const HERDR_COMMAND = {
	AGENT: "agent",
	PANE: "pane",
	TAB: "tab",
	WORKSPACE: "workspace",
	WORKTREE: "worktree",
} as const;

const HERDR_SUBCOMMAND = {
	CREATE: "create",
	CURRENT: "current",
	FOCUS: "focus",
	GET: "get",
	LIST: "list",
	OPEN: "open",
	PROMPT: "prompt",
	START: "start",
} as const;

const PICKER_LABEL = {
	NEW_BRANCH: "Create a new branch",
	LOCAL_BRANCH: "Use an existing local branch",
	REMOTE_BRANCH: "Track a remote branch",
	EXISTING_WORKTREE: "Reuse an existing worktree",
	FETCH_REMOTES: "Fetch/prune remotes and refresh",
} as const;

const WIP_LABEL = {
	DUPLICATE: "Duplicate WIP into the target",
	SKIP: "Continue without copying WIP",
} as const;

const automatedHandoffToolSchema = Type.Object({
	worktree: Type.String({
		minLength: 1,
		maxLength: MAX_WORKTREE_SELECTOR_LENGTH,
		description: "Target worktree checkout path, a path inside it, its local branch, or checkout directory name",
	}),
	task: Type.String({
		minLength: 1,
		maxLength: MAX_HANDOFF_TASK_LENGTH,
		description: "Exact task the forked Pi must begin in the target worktree",
	}),
}, { additionalProperties: false });

export type AutomatedHandoffToolInput = Static<typeof automatedHandoffToolSchema>;

enum TargetKind {
	Invalid = 0,
	NewBranch,
	ExistingLocalBranch,
	RemoteTrackingBranch,
	ExistingWorktree,
}

enum WipChoice {
	Invalid = 0,
	Clean,
	Duplicate,
	Skip,
}

enum WipOutcome {
	Invalid = 0,
	Clean,
	Skipped,
	Applied,
	Conflicted,
	Failed,
}

enum AutomatedHandoffPhase {
	Invalid = 0,
	Reserved,
	Accepted,
	Executing,
	Partial,
	Terminal,
}

enum AutomatedHandoffOutcome {
	Invalid = 0,
	Accepted,
	Executing,
	DestinationReady,
	AgentStarted,
	TaskStarted,
	Succeeded,
	Failed,
	Partial,
	Cancelled,
	Abandoned,
}

export enum DestinationKind {
	Invalid = 0,
	NewWorktreeWorkspace,
	ExistingWorkspaceTab,
}

export enum WorkspaceRegistrationKind {
	Invalid = 0,
	Absent,
	Registered,
	Conflict,
	Ambiguous,
}

type CommandResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
};

type GitContext = {
	repoRoot: string;
	primaryWorktreePath: string;
	repoName: string;
	commonDir: string;
	currentRef: string;
};

export type LocalBranch = {
	fullRef: string;
	shortName: string;
	commit: string;
	upstream?: string;
	worktreePath?: string;
};

export type RemoteBranch = {
	fullRef: string;
	shortName: string;
	commit: string;
};

export type GitWorktree = {
	path: string;
	head: string;
	branchRef?: string;
	locked: boolean;
	prunable: boolean;
};

type BranchCatalog = {
	locals: LocalBranch[];
	remotes: RemoteBranch[];
	worktrees: GitWorktree[];
};

type TargetCommon = {
	kind: TargetKind;
	branchName: string;
	branchRef: string;
	expectedCommit: string;
	sourceLabel: string;
	worktreeName: string;
	worktreePath: string;
	isLinkedWorktree: boolean;
};

type NewBranchTarget = TargetCommon & {
	kind: TargetKind.NewBranch;
	baseRef: string;
};

type ExistingLocalTarget = TargetCommon & {
	kind: TargetKind.ExistingLocalBranch;
};

type RemoteTrackingTarget = TargetCommon & {
	kind: TargetKind.RemoteTrackingBranch;
	remoteRef: string;
	remoteShortName: string;
};

type ExistingWorktreeTarget = TargetCommon & {
	kind: TargetKind.ExistingWorktree;
};

type TargetPlan =
	| NewBranchTarget
	| ExistingLocalTarget
	| RemoteTrackingTarget
	| ExistingWorktreeTarget;

type HerdrPane = {
	pane_id?: string;
	workspace_id?: string;
	tab_id?: string;
	cwd?: string;
	foreground_cwd?: string;
	agent?: string;
	agent_status?: string;
	state_change_seq?: number;
	agent_session?: { kind?: string; value?: string; agent?: string };
};

type HerdrWorktreeMetadata = {
	checkout_path?: string;
	is_linked_worktree?: boolean;
	repo_key?: string;
	repo_name?: string;
	repo_root?: string;
};

type HerdrWorkspace = {
	workspace_id?: string;
	active_tab_id?: string;
	label?: string;
	worktree?: HerdrWorktreeMetadata;
};

type HerdrTab = {
	tab_id?: string;
	workspace_id?: string;
	label?: string;
};

type HerdrState = {
	panes: HerdrPane[];
	workspaces: HerdrWorkspace[];
	tabs: HerdrTab[];
};

type WorkspaceMatch = {
	workspaceId: string;
	label: string;
};

type WorkspaceRegistration = {
	kind: WorkspaceRegistrationKind;
	registered?: WorkspaceMatch;
	details?: string;
};

type HerdrDestination = {
	kind: DestinationKind;
	workspaceId: string;
	tabId: string;
	paneId: string;
};

type RecoveryStash = {
	objectId: string;
	marker: string;
};

type WipResult = {
	outcome: WipOutcome;
	details?: string;
};

type TargetPreparation = {
	plan: TargetPlan;
	preferredWorkspaceId?: string;
	initialTargetStatus?: string;
};

type PartialHandoffLocation = {
	workspaceId?: string;
	tabId?: string;
	paneId?: string;
	agentName?: string;
};

type AutomatedHandoffRequest = {
	requestId: string;
	toolCallId: string;
	sourceSessionId: string;
	sourceSessionFile: string;
	sourceLeafId: string | undefined;
	sourceCwd: string;
	sourceRef: string;
	sourceSessionName: string | undefined;
	model: string;
	thinkingLevel: string;
	projectTrusted: boolean;
	task: string;
	git: GitContext;
	preparation: TargetPreparation;
	targetFingerprint: string;
	agentName: string;
	tabLabel: string;
	acceptedAt: number;
};

type ForkedAgentConfig = {
	model: string;
	thinkingLevel: string;
	projectTrusted: boolean;
	sessionName: string;
};

type AutomatedHandoffRuntime = {
	phase: AutomatedHandoffPhase;
	toolCallId: string;
	request?: AutomatedHandoffRequest;
	abortController?: AbortController;
	location?: PartialHandoffLocation;
	mutationStarted: boolean;
	terminalRecorded: boolean;
};

type AutomatedHandoffEntry = {
	requestId: string;
	outcome: string;
	timestamp: number;
	sourceSessionId: string;
	targetPath: string;
	targetBranch: string;
	targetRepoKey?: string;
	targetIsLinkedWorktree?: boolean;
	agentName: string;
	tabLabel: string;
	message: string;
	location?: PartialHandoffLocation;
};

export function isValidWorktreeName(value: string): boolean {
	return WORKTREE_NAME_PATTERN.test(value) && value !== "." && value !== "..";
}

export function defaultWorktreeName(branch: string): string {
	const normalized = branch
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[^A-Za-z0-9]+/, "")
		.replace(/-+$/g, "");
	return normalized || "branch-worktree";
}

export function isPathContained(parentPath: string, childPath: string): boolean {
	const pathFromParent = relative(resolve(parentPath), resolve(childPath));
	return pathFromParent.length > 0 && pathFromParent !== ".." && !pathFromParent.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(pathFromParent);
}

function isSameOrContained(parentPath: string, candidatePath: string): boolean {
	return resolve(parentPath) === resolve(candidatePath) || isPathContained(parentPath, candidatePath);
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function truncateMessage(value: string, maxLength = 1_000): string {
	const trimmed = value.trim();
	return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, maxLength)}…`;
}

function commandFailure(command: string, args: string[], result: CommandResult): Error {
	const detail = truncateMessage(result.stderr || result.stdout || `exit code ${result.code}`);
	return new Error(`${command} ${args.slice(0, 3).join(" ")} failed: ${detail}`);
}

function assertNever(value: never): never {
	throw new Error(`Unhandled internal state: ${String(value)}`);
}

async function runCommand(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {},
): Promise<CommandResult> {
	return pi.exec(command, args, {
		cwd: options.cwd,
		timeout: options.timeout ?? EXTERNAL_COMMAND_TIMEOUT_MS,
		signal: options.signal,
	});
}

async function runChecked(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	options: { cwd?: string; timeout?: number; signal?: AbortSignal } = {},
): Promise<CommandResult> {
	const result = await runCommand(pi, command, args, options);
	if (result.code !== 0 || result.killed) {
		throw commandFailure(command, args, result);
	}
	return result;
}

export function parseHerdrResult<T>(output: string): T {
	let envelope: { result?: T; error?: { code?: string; message?: string } };
	try {
		envelope = JSON.parse(output) as typeof envelope;
	} catch {
		throw new Error("Herdr returned malformed JSON.");
	}
	if (envelope.error) {
		throw new Error(envelope.error.message || envelope.error.code || "Herdr command failed.");
	}
	if (envelope.result === undefined) {
		throw new Error("Herdr response did not contain a result.");
	}
	return envelope.result;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return resolve(path);
		throw error;
	}
}

function stripRecordPrefix(value: string): string {
	return value.startsWith("\n") ? value.slice(1) : value;
}

export function parseLocalBranches(output: string): LocalBranch[] {
	const fields = output.split("\0");
	const branches: LocalBranch[] = [];
	for (let index = 0; index + 4 < fields.length; index += 5) {
		const fullRef = stripRecordPrefix(fields[index]);
		if (!fullRef) break;
		branches.push({
			fullRef,
			shortName: fields[index + 1],
			commit: fields[index + 2],
			upstream: fields[index + 3] || undefined,
			worktreePath: fields[index + 4] || undefined,
		});
	}
	return branches;
}

export function parseRemoteBranches(output: string): RemoteBranch[] {
	const fields = output.split("\0");
	const branches: RemoteBranch[] = [];
	for (let index = 0; index + 3 < fields.length; index += 4) {
		const fullRef = stripRecordPrefix(fields[index]);
		if (!fullRef) break;
		const symref = fields[index + 3];
		if (!symref) {
			branches.push({
				fullRef,
				shortName: fields[index + 1],
				commit: fields[index + 2],
			});
		}
	}
	return branches;
}

export function parseGitWorktrees(output: string): GitWorktree[] {
	return output
		.split("\0\0")
		.map((record) => record.split("\0").filter(Boolean))
		.filter((fields) => fields.length > 0)
		.map((fields) => {
			const values = new Map<string, string>();
			const flags = new Set<string>();
			for (const field of fields) {
				const separator = field.indexOf(" ");
				if (separator === -1) {
					flags.add(field);
				} else {
					values.set(field.slice(0, separator), field.slice(separator + 1));
				}
			}
			return {
				path: values.get("worktree") ?? "",
				head: values.get("HEAD") ?? "",
				branchRef: values.get("branch"),
				locked: flags.has("locked") || values.has("locked"),
				prunable: flags.has("prunable") || values.has("prunable"),
			};
		})
		.filter((worktree) => Boolean(worktree.path && worktree.head));
}

async function inspectGitContext(
	pi: ExtensionAPI,
	cwd: string,
	signal?: AbortSignal,
): Promise<GitContext> {
	const rootResult = await runChecked(pi, GIT_BIN, ["rev-parse", "--show-toplevel"], {
		cwd,
		signal,
	});
	const repoRoot = await realpath(rootResult.stdout.trim());
	const commonDirResult = await runChecked(pi, GIT_BIN, ["rev-parse", "--git-common-dir"], {
		cwd: repoRoot,
		signal,
	});
	const rawCommonDir = commonDirResult.stdout.trim();
	const commonDir = await realpath(resolve(repoRoot, rawCommonDir));
	const repoName = basename(commonDir) === ".git" ? basename(dirname(commonDir)) : basename(commonDir);
	const worktreeResult = await runChecked(
		pi,
		GIT_BIN,
		["worktree", "list", "--porcelain", "-z"],
		{ cwd: repoRoot, signal },
	);
	const primaryWorktree = parseGitWorktrees(worktreeResult.stdout)[0];
	const primaryWorktreePath = primaryWorktree?.path
		? await canonicalPath(primaryWorktree.path)
		: repoRoot;

	const branchResult = await runCommand(pi, GIT_BIN, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd: repoRoot,
		signal,
	});
	const currentRef = branchResult.code === 0 ? branchResult.stdout.trim() : "HEAD";

	await runChecked(pi, GIT_BIN, ["rev-parse", "--verify", "HEAD^{commit}"], {
		cwd: repoRoot,
		signal,
	});
	return { repoRoot, primaryWorktreePath, repoName, commonDir, currentRef };
}

async function resolveCommit(pi: ExtensionAPI, repoRoot: string, ref: string): Promise<string> {
	const result = await runChecked(pi, GIT_BIN, ["rev-parse", "--verify", `${ref}^{commit}`], {
		cwd: repoRoot,
	});
	return result.stdout.trim();
}

async function localBranchExists(pi: ExtensionAPI, repoRoot: string, branch: string): Promise<boolean> {
	const result = await runCommand(pi, GIT_BIN, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
		cwd: repoRoot,
	});
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	throw commandFailure(GIT_BIN, ["show-ref", "--verify", `refs/heads/${branch}`], result);
}

async function validateNewBranch(pi: ExtensionAPI, repoRoot: string, branch: string): Promise<void> {
	await runChecked(pi, GIT_BIN, ["check-ref-format", "--branch", branch], { cwd: repoRoot });
	if (await localBranchExists(pi, repoRoot, branch)) {
		throw new Error(`Local branch already exists: ${branch}`);
	}
}

async function validateWorktreePath(
	pi: ExtensionAPI,
	repoRoot: string,
	worktreePath: string,
): Promise<void> {
	const parentPath = dirname(worktreePath);
	if (!isPathContained(parentPath, worktreePath)) {
		throw new Error("The derived worktree path is not safely contained by its parent directory.");
	}
	if (await pathExists(worktreePath)) {
		throw new Error(`Worktree path already exists: ${worktreePath}`);
	}

	const listResult = await runChecked(pi, GIT_BIN, ["worktree", "list", "--porcelain", "-z"], { cwd: repoRoot });
	const registered = parseGitWorktrees(listResult.stdout).some(
		(worktree) => resolve(worktree.path) === resolve(worktreePath),
	);
	if (registered) {
		throw new Error(`Git already has a worktree registered at: ${worktreePath}`);
	}
}

async function isUsableRepositoryWorktree(
	pi: ExtensionAPI,
	git: GitContext,
	worktree: GitWorktree,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!worktree.branchRef || worktree.prunable || !(await pathExists(worktree.path))) return false;
	try {
		const commonResult = await runChecked(pi, GIT_BIN, ["rev-parse", "--git-common-dir"], {
			cwd: worktree.path,
			signal,
		});
		const commonDir = await realpath(resolve(worktree.path, commonResult.stdout.trim()));
		return commonDir === git.commonDir;
	} catch {
		signal?.throwIfAborted();
		return false;
	}
}

async function discoverBranchCatalog(
	pi: ExtensionAPI,
	git: GitContext,
	signal?: AbortSignal,
): Promise<BranchCatalog> {
	const [localResult, remoteResult, worktreeResult] = await Promise.all([
		runChecked(
			pi,
			GIT_BIN,
			["for-each-ref", "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(worktreepath)%00", "refs/heads"],
			{ cwd: git.repoRoot, signal },
		),
		runChecked(
			pi,
			GIT_BIN,
			["for-each-ref", "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(symref)%00", "refs/remotes"],
			{ cwd: git.repoRoot, signal },
		),
		runChecked(pi, GIT_BIN, ["worktree", "list", "--porcelain", "-z"], {
			cwd: git.repoRoot,
			signal,
		}),
	]);

	const parsedWorktrees = parseGitWorktrees(worktreeResult.stdout);
	const usableWorktrees: GitWorktree[] = [];
	for (const worktree of parsedWorktrees) {
		if (await isUsableRepositoryWorktree(pi, git, worktree, signal)) usableWorktrees.push(worktree);
	}
	const worktreeByBranch = new Map(
		usableWorktrees
			.filter((worktree) => worktree.branchRef)
			.map((worktree) => [worktree.branchRef!, worktree.path]),
	);
	const locals = parseLocalBranches(localResult.stdout).map((branch) => ({
		...branch,
		worktreePath: worktreeByBranch.get(branch.fullRef) ?? branch.worktreePath,
	}));
	return {
		locals,
		remotes: parseRemoteBranches(remoteResult.stdout),
		worktrees: usableWorktrees,
	};
}

type SearchableItem<T> = {
	item: T;
	selectItem: SelectItem;
	searchText: string;
};

async function searchableSelect<T>(
	ctx: ExtensionCommandContext,
	title: string,
	items: T[],
	format: (item: T) => string,
): Promise<T | undefined> {
	const searchableItems: SearchableItem<T>[] = items.map((item, index) => {
		const label = format(item);
		return {
			item,
			selectItem: { value: String(index), label },
			searchText: label,
		};
	});

	const selectedValue = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
		const container = new Container();
		const input = new Input();
		let selectList: SelectList;
		let focused = false;

		const rebuild = () => {
			const query = input.getValue();
			const filtered = query
				? fuzzyFilter(searchableItems, query, (entry) => entry.searchText)
				: searchableItems;
			selectList = new SelectList(
				filtered.map((entry) => entry.selectItem),
				Math.min(Math.max(filtered.length, 1), 12),
				{
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: () => theme.fg("warning", "  No matching items"),
				},
				{ minPrimaryColumnWidth: 32, maxPrimaryColumnWidth: 100 },
			);
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.clear();
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
			container.addChild(new Text(theme.fg("dim", "Type to fuzzy-filter"), 1, 0));
			container.addChild(input);
			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
			container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		};
		rebuild();

		return {
			get focused() {
				return focused;
			},
			set focused(value: boolean) {
				focused = value;
				input.focused = value;
			},
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (
					keybindings.matches(data, "tui.select.up") ||
					keybindings.matches(data, "tui.select.down") ||
					keybindings.matches(data, "tui.select.confirm")
				) {
					selectList.handleInput(data);
				} else if (keybindings.matches(data, "tui.select.cancel")) {
					done(null);
				} else {
					const previousQuery = input.getValue();
					input.handleInput(data);
					if (input.getValue() !== previousQuery) rebuild();
				}
				tui.requestRender();
			},
		};
	});

	if (selectedValue === null) return undefined;
	const selectedIndex = Number.parseInt(selectedValue, 10);
	return Number.isInteger(selectedIndex) ? items[selectedIndex] : undefined;
}

function chooseMappedItem<T>(
	ctx: ExtensionCommandContext,
	title: string,
	items: T[],
	format: (item: T) => string,
): Promise<T | undefined> {
	return searchableSelect(ctx, title, items, format);
}

async function promptNewBranchName(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repoRoot: string,
	placeholder: string,
	blankDefault?: string,
): Promise<string | undefined> {
	while (true) {
		const entered = await ctx.ui.input("New local branch name", placeholder);
		if (entered === undefined) return undefined;
		const branch = entered.trim() || blankDefault || "";
		if (!branch) {
			ctx.ui.notify("A branch name is required.", "warning");
			continue;
		}
		try {
			await validateNewBranch(pi, repoRoot, branch);
			return branch;
		} catch (error) {
			ctx.ui.notify(formatError(error), "warning");
		}
	}
}

async function promptWorktreeDestination(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	git: GitContext,
	branch: string,
): Promise<{ worktreeName: string; worktreePath: string } | undefined> {
	const suggestedName = defaultWorktreeName(branch);
	while (true) {
		const entered = await ctx.ui.input("Worktree and Herdr workspace name", suggestedName);
		if (entered === undefined) return undefined;
		const worktreeName = entered.trim() || suggestedName;
		if (!isValidWorktreeName(worktreeName)) {
			ctx.ui.notify(
				"Use one path segment containing only letters, numbers, dots, underscores, or hyphens.",
				"warning",
			);
			continue;
		}
		const worktreePath = join(homedir(), ".worktrees", git.repoName, worktreeName);
		try {
			await validateWorktreePath(pi, git.repoRoot, worktreePath);
			return { worktreeName, worktreePath };
		} catch (error) {
			ctx.ui.notify(formatError(error), "warning");
		}
	}
}

function existingWorktreeName(git: GitContext, worktree: GitWorktree): string {
	const directory = basename(worktree.path);
	const repositoryPrefix = `${git.repoName}-`;
	const candidate = directory.startsWith(repositoryPrefix)
		? directory.slice(repositoryPrefix.length)
		: directory;
	if (isValidWorktreeName(candidate)) return candidate;
	const branch = worktree.branchRef?.replace(/^refs\/heads\//, "") ?? directory;
	return defaultWorktreeName(branch);
}

function availableLocalBranches(catalog: BranchCatalog): LocalBranch[] {
	return catalog.locals.filter((branch) => !branch.worktreePath);
}

function availableRemoteBranches(catalog: BranchCatalog): RemoteBranch[] {
	const tracked = new Set(catalog.locals.map((branch) => branch.upstream).filter(Boolean));
	return catalog.remotes.filter((branch) => !tracked.has(branch.shortName));
}

function reusableWorktrees(catalog: BranchCatalog, git: GitContext): GitWorktree[] {
	return catalog.worktrees.filter(
		(worktree) => resolve(worktree.path) !== resolve(git.repoRoot) && Boolean(worktree.branchRef),
	);
}

function normalizeAutomatedHandoffText(
	value: string,
	field: string,
	maxLength: number,
	stripLeadingAt = false,
): string {
	const prepared = stripLeadingAt ? value.replace(/^@(?=\S)/, "") : value;
	const normalized = prepared.replaceAll("\r\n", "\n").trim();
	if (!normalized) throw new Error(`${field} is required.`);
	if (normalized.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters.`);
	if (/[^\P{Cc}\n\t]/u.test(normalized)) {
		throw new Error(`${field} contains unsupported control characters.`);
	}
	return normalized;
}

async function canonicalizePotentialPath(path: string): Promise<string> {
	let cursor = resolve(path);
	const suffix: string[] = [];
	while (!(await pathExists(cursor))) {
		const parent = dirname(cursor);
		if (parent === cursor) return resolve(path);
		suffix.unshift(basename(cursor));
		cursor = parent;
	}
	return resolve(await realpath(cursor), ...suffix);
}

async function runReadOnlyGit(
	pi: ExtensionAPI,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<CommandResult> {
	return runChecked(pi, "env", ["GIT_OPTIONAL_LOCKS=0", GIT_BIN, ...args], {
		cwd,
		signal,
	});
}

export async function resolveAutomatedWorktreeTarget(
	pi: ExtensionAPI,
	git: GitContext,
	cwd: string,
	selectorInput: string,
	signal?: AbortSignal,
): Promise<ExistingWorktreeTarget> {
	const selector = normalizeAutomatedHandoffText(
		selectorInput,
		"Worktree selector",
		MAX_WORKTREE_SELECTOR_LENGTH,
		true,
	);
	const catalog = await discoverBranchCatalog(pi, git, signal);
	const currentPath = await canonicalPath(git.repoRoot);
	const primaryPath = await canonicalPath(git.primaryWorktreePath);
	const pathLike = isAbsolute(selector) || selector.startsWith(".") || /[\\/]/.test(selector)
		|| await pathExists(resolve(cwd, selector));
	const selectorPath = pathLike
		? await canonicalizePotentialPath(isAbsolute(selector) ? selector : resolve(cwd, selector))
		: undefined;
	const matches = new Map<string, { worktree: GitWorktree; mechanisms: Set<string> }>();
	for (const worktree of catalog.worktrees) {
		if (!worktree.branchRef) continue;
		const checkoutPath = await canonicalPath(worktree.path);
		const mechanisms: string[] = [];
		if (selectorPath && isSameOrContained(checkoutPath, selectorPath)) mechanisms.push("path");
		const branchName = worktree.branchRef.replace(/^refs\/heads\//, "");
		if (selector === branchName || selector === worktree.branchRef) mechanisms.push("branch");
		if (selector === basename(checkoutPath)) mechanisms.push("basename");
		if (mechanisms.length === 0) continue;
		const match = matches.get(checkoutPath) ?? { worktree, mechanisms: new Set<string>() };
		for (const mechanism of mechanisms) match.mechanisms.add(mechanism);
		matches.set(checkoutPath, match);
	}
	if (matches.size === 0) {
		throw new Error(
			`No branch-attached Git worktree matches ${JSON.stringify(selector)}. Detached worktrees are not eligible for automatic handoff.`,
		);
	}
	if (matches.size > 1) {
		const details = [...matches.entries()]
			.map(([path, match]) => `${path} via ${[...match.mechanisms].sort().join("+")}`)
			.join("; ");
		throw new Error(`Worktree selector is ambiguous: ${details}`);
	}
	const [checkoutPath, match] = matches.entries().next().value!;
	if (checkoutPath === currentPath) {
		throw new Error("The selected worktree is the current checkout; no handoff is needed.");
	}
	const branchRef = match.worktree.branchRef;
	if (!branchRef) throw new Error("Detached worktrees are not eligible for automatic handoff.");
	const branchName = branchRef.replace(/^refs\/heads\//, "");
	return {
		kind: TargetKind.ExistingWorktree,
		branchName,
		branchRef,
		expectedCommit: match.worktree.head,
		sourceLabel: `automatic handoff to existing worktree for ${branchName}`,
		worktreeName: existingWorktreeName(git, match.worktree),
		worktreePath: checkoutPath,
		isLinkedWorktree: checkoutPath !== primaryPath,
	};
}

async function assertNoDirtySubmodules(
	pi: ExtensionAPI,
	worktreePath: string,
	signal?: AbortSignal,
): Promise<void> {
	const result = await runReadOnlyGit(
		pi,
		[
			"submodule",
			"foreach",
			"--quiet",
			"--recursive",
			"status=$(git status --porcelain=v1 --untracked-files=all); if [ -n \"$status\" ]; then printf '%s\\n' \"$displaypath\"; fi",
		],
		worktreePath,
		signal,
	);
	const dirty = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
	if (dirty.length > 0) {
		throw new Error(`Automatic handoff rejects target worktrees with dirty submodules: ${dirty.join(", ")}`);
	}
}

async function readTargetFingerprint(
	pi: ExtensionAPI,
	worktreePath: string,
	signal?: AbortSignal,
): Promise<{ status: string; fingerprint: string }> {
	await assertNoDirtySubmodules(pi, worktreePath, signal);
	const [statusResult, diffResult, untrackedResult] = await Promise.all([
		runReadOnlyGit(
			pi,
			["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
			worktreePath,
			signal,
		),
		runReadOnlyGit(pi, ["diff", "--binary", "--no-ext-diff", "HEAD", "--"], worktreePath, signal),
		runReadOnlyGit(pi, ["ls-files", "--others", "--exclude-standard", "-z"], worktreePath, signal),
	]);
	const untracked = untrackedResult.stdout.split("\0").filter(Boolean);
	const untrackedHashes: string[] = [];
	for (let index = 0; index < untracked.length; index += 100) {
		const chunk = untracked.slice(index, index + 100);
		const hashes = await runReadOnlyGit(
			pi,
			["hash-object", "--no-filters", "--", ...chunk],
			worktreePath,
			signal,
		);
		untrackedHashes.push(...hashes.stdout.split("\n").filter(Boolean));
	}
	const fingerprint = createHash("sha256")
		.update(statusResult.stdout)
		.update("\0")
		.update(diffResult.stdout)
		.update("\0")
		.update(untrackedHashes.join("\n"))
		.digest("hex");
	return { status: statusResult.stdout, fingerprint };
}

async function buildNewBranchTarget(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	git: GitContext,
	catalog: BranchCatalog,
): Promise<TargetPlan | undefined> {
	const bases = [
		...catalog.locals.map((branch) => ({
			kind: "local" as const,
			fullRef: branch.fullRef,
			shortName: branch.shortName,
			commit: branch.commit,
		})),
		...catalog.remotes.map((branch) => ({
			kind: "remote" as const,
			fullRef: branch.fullRef,
			shortName: branch.shortName,
			commit: branch.commit,
		})),
	].sort((left, right) => {
		if (left.shortName === git.currentRef) return -1;
		if (right.shortName === git.currentRef) return 1;
		return left.shortName.localeCompare(right.shortName);
	});
	const base = await chooseMappedItem(
		ctx,
		"Select the base branch/ref",
		bases,
		(item) => `${item.shortName}  [${item.kind}, ${item.commit.slice(0, 10)}]`,
	);
	if (!base) return undefined;

	const branchName = await promptNewBranchName(pi, ctx, git.repoRoot, "feature/my-branch");
	if (!branchName) return undefined;
	const destination = await promptWorktreeDestination(pi, ctx, git, branchName);
	if (!destination) return undefined;
	return {
		kind: TargetKind.NewBranch,
		branchName,
		branchRef: `refs/heads/${branchName}`,
		expectedCommit: base.commit,
		sourceLabel: `new branch from ${base.shortName}`,
		baseRef: base.fullRef,
		isLinkedWorktree: true,
		...destination,
	};
}

async function buildLocalBranchTarget(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	git: GitContext,
	catalog: BranchCatalog,
): Promise<TargetPlan | undefined> {
	const branches = availableLocalBranches(catalog);
	const branch = await chooseMappedItem(
		ctx,
		"Select an existing local branch",
		branches,
		(item) => `${item.shortName}  [${item.commit.slice(0, 10)}${item.upstream ? `, ↑ ${item.upstream}` : ""}]`,
	);
	if (!branch) return undefined;
	const destination = await promptWorktreeDestination(pi, ctx, git, branch.shortName);
	if (!destination) return undefined;
	return {
		kind: TargetKind.ExistingLocalBranch,
		branchName: branch.shortName,
		branchRef: branch.fullRef,
		expectedCommit: branch.commit,
		sourceLabel: `existing local branch ${branch.shortName}`,
		isLinkedWorktree: true,
		...destination,
	};
}

async function buildRemoteBranchTarget(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	git: GitContext,
	catalog: BranchCatalog,
): Promise<TargetPlan | undefined> {
	const remotes = availableRemoteBranches(catalog);
	const remote = await chooseMappedItem(
		ctx,
		"Select a remote branch to track",
		remotes,
		(item) => `${item.shortName}  [${item.commit.slice(0, 10)}]`,
	);
	if (!remote) return undefined;
	const separator = remote.shortName.indexOf("/");
	const suggestedLocal = separator >= 0 ? remote.shortName.slice(separator + 1) : remote.shortName;
	const branchName = await promptNewBranchName(pi, ctx, git.repoRoot, suggestedLocal, suggestedLocal);
	if (!branchName) return undefined;
	const destination = await promptWorktreeDestination(pi, ctx, git, branchName);
	if (!destination) return undefined;
	return {
		kind: TargetKind.RemoteTrackingBranch,
		branchName,
		branchRef: `refs/heads/${branchName}`,
		expectedCommit: remote.commit,
		sourceLabel: `tracking ${remote.shortName}`,
		remoteRef: remote.fullRef,
		remoteShortName: remote.shortName,
		isLinkedWorktree: true,
		...destination,
	};
}

async function buildExistingWorktreeTarget(
	ctx: ExtensionCommandContext,
	git: GitContext,
	catalog: BranchCatalog,
): Promise<TargetPlan | undefined> {
	const worktrees = reusableWorktrees(catalog, git);
	const worktree = await chooseMappedItem(
		ctx,
		"Select an existing worktree",
		worktrees,
		(item) => `${item.branchRef?.replace(/^refs\/heads\//, "")}  [${item.path}]`,
	);
	if (!worktree?.branchRef) return undefined;
	const branchName = worktree.branchRef.replace(/^refs\/heads\//, "");
	return {
		kind: TargetKind.ExistingWorktree,
		branchName,
		branchRef: worktree.branchRef,
		expectedCommit: worktree.head,
		sourceLabel: `existing worktree for ${branchName}`,
		worktreeName: existingWorktreeName(git, worktree),
		worktreePath: worktree.path,
		isLinkedWorktree: resolve(worktree.path) !== resolve(git.primaryWorktreePath),
	};
}

async function runTargetPicker(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	git: GitContext,
): Promise<TargetPlan | undefined> {
	while (true) {
		const catalog = await discoverBranchCatalog(pi, git);
		const locals = availableLocalBranches(catalog);
		const remotes = availableRemoteBranches(catalog);
		const worktrees = reusableWorktrees(catalog, git);
		const choices = [
			PICKER_LABEL.NEW_BRANCH,
			...(locals.length > 0 ? [`${PICKER_LABEL.LOCAL_BRANCH} (${locals.length})`] : []),
			...(remotes.length > 0 ? [`${PICKER_LABEL.REMOTE_BRANCH} (${remotes.length})`] : []),
			...(worktrees.length > 0 ? [`${PICKER_LABEL.EXISTING_WORKTREE} (${worktrees.length})`] : []),
			PICKER_LABEL.FETCH_REMOTES,
		];
		const selected = await chooseMappedItem(
			ctx,
			"Branch workspace action",
			choices,
			(choice) => choice,
		);
		if (!selected) return undefined;

		if (selected === PICKER_LABEL.FETCH_REMOTES) {
			ctx.ui.setStatus(COMMAND_NAME, "Fetching and pruning remotes…");
			const fetch = await runCommand(pi, GIT_BIN, ["fetch", "--all", "--prune"], {
				cwd: git.repoRoot,
				timeout: REMOTE_FETCH_TIMEOUT_MS,
			});
			ctx.ui.setStatus(COMMAND_NAME, undefined);
			if (fetch.code === 0 && !fetch.killed) {
				ctx.ui.notify("Remote refs refreshed.", "info");
			} else {
				ctx.ui.notify(
					`Fetch failed; keeping currently known refs: ${truncateMessage(fetch.stderr || fetch.stdout)}`,
					"warning",
				);
			}
			continue;
		}
		if (selected === PICKER_LABEL.NEW_BRANCH) {
			return buildNewBranchTarget(pi, ctx, git, catalog);
		}
		if (selected.startsWith(PICKER_LABEL.LOCAL_BRANCH)) {
			return buildLocalBranchTarget(pi, ctx, git, catalog);
		}
		if (selected.startsWith(PICKER_LABEL.REMOTE_BRANCH)) {
			return buildRemoteBranchTarget(pi, ctx, git, catalog);
		}
		if (selected.startsWith(PICKER_LABEL.EXISTING_WORKTREE)) {
			return buildExistingWorktreeTarget(ctx, git, catalog);
		}
	}
}

async function readGitStatus(pi: ExtensionAPI, repoRoot: string): Promise<string> {
	const result = await runChecked(
		pi,
		GIT_BIN,
		["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"],
		{ cwd: repoRoot },
	);
	return result.stdout;
}

function countStatusEntries(status: string): number {
	return status.split("\0").filter(Boolean).length;
}

async function findDirtySubmodules(pi: ExtensionAPI, repoRoot: string): Promise<string[]> {
	const stateResult = await runChecked(pi, GIT_BIN, ["submodule", "status", "--recursive"], {
		cwd: repoRoot,
	});
	const changedCommits = stateResult.stdout
		.split("\n")
		.filter((line) => line.startsWith("+") || line.startsWith("U"))
		.map((line) => line.trim());

	const workResult = await runChecked(
		pi,
		GIT_BIN,
		[
			"submodule",
			"foreach",
			"--quiet",
			"--recursive",
			'test -z "$(git status --porcelain --untracked-files=all)" || printf "%s\\n" "$sm_path"',
		],
		{ cwd: repoRoot },
	);
	const dirtyWorktrees = workResult.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
	return [...new Set([...changedCommits, ...dirtyWorktrees])];
}

async function chooseWipBehavior(
	ctx: ExtensionCommandContext,
	sourceStatus: string,
): Promise<WipChoice | undefined> {
	if (!sourceStatus) return WipChoice.Clean;
	const selected = await chooseMappedItem(
		ctx,
		`Source has ${countStatusEntries(sourceStatus)} changed path(s)`,
		[WIP_LABEL.DUPLICATE, WIP_LABEL.SKIP],
		(choice) => choice,
	);
	if (!selected) return undefined;
	return selected === WIP_LABEL.DUPLICATE ? WipChoice.Duplicate : WipChoice.Skip;
}

async function getHerdrState(
	pi: ExtensionAPI,
	herdrBin: string,
	signal?: AbortSignal,
): Promise<HerdrState> {
	const [paneResult, workspaceResult, tabResult] = await Promise.all([
		runChecked(pi, herdrBin, [HERDR_COMMAND.PANE, HERDR_SUBCOMMAND.LIST], { signal }),
		runChecked(pi, herdrBin, [HERDR_COMMAND.WORKSPACE, HERDR_SUBCOMMAND.LIST], { signal }),
		runChecked(pi, herdrBin, [HERDR_COMMAND.TAB, HERDR_SUBCOMMAND.LIST], { signal }),
	]);
	const panes = parseHerdrResult<{ panes?: HerdrPane[] }>(paneResult.stdout).panes ?? [];
	const workspaces = parseHerdrResult<{ workspaces?: HerdrWorkspace[] }>(workspaceResult.stdout).workspaces ?? [];
	const tabs = parseHerdrResult<{ tabs?: HerdrTab[] }>(tabResult.stdout).tabs ?? [];
	return { panes, workspaces, tabs };
}

export async function classifyWorktreeWorkspace(
	state: HerdrState,
	worktreePath: string,
	repoKey: string,
	expectedLinkedWorktree = true,
): Promise<WorkspaceRegistration> {
	const expectedCheckout = await canonicalPath(worktreePath);
	const expectedRepoKey = await canonicalPath(repoKey);
	const registered = new Map<string, WorkspaceMatch>();
	const conflicts = new Set<string>();

	for (const workspace of state.workspaces) {
		if (!workspace.workspace_id || !workspace.worktree?.checkout_path) continue;
		const checkoutPath = await canonicalPath(workspace.worktree.checkout_path);
		if (checkoutPath !== expectedCheckout) continue;
		const metadataRepoKey = workspace.worktree.repo_key
			? await canonicalPath(workspace.worktree.repo_key)
			: undefined;
		if (
			metadataRepoKey === expectedRepoKey &&
			workspace.worktree.is_linked_worktree === expectedLinkedWorktree
		) {
			registered.set(workspace.workspace_id, {
				workspaceId: workspace.workspace_id,
				label: workspace.label || workspace.workspace_id,
			});
		} else {
			conflicts.add(workspace.workspace_id);
		}
	}

	for (const pane of state.panes) {
		if (!pane.workspace_id || registered.has(pane.workspace_id)) continue;
		const panePaths = [pane.cwd, pane.foreground_cwd].filter(
			(value): value is string => Boolean(value),
		);
		for (const panePath of panePaths) {
			const canonicalPanePath = await canonicalPath(panePath);
			if (isSameOrContained(expectedCheckout, canonicalPanePath)) {
				conflicts.add(pane.workspace_id);
				break;
			}
		}
	}

	const matches = [...registered.values()].sort((left, right) =>
		left.workspaceId.localeCompare(right.workspaceId)
	);
	if (matches.length === 1 && conflicts.size === 0) {
		return { kind: WorkspaceRegistrationKind.Registered, registered: matches[0] };
	}
	if (matches.length > 1 || (matches.length > 0 && conflicts.size > 0)) {
		return {
			kind: WorkspaceRegistrationKind.Ambiguous,
			details: `registered=${matches.map((match) => match.workspaceId).join(",") || "none"}; conflicting=${[...conflicts].sort().join(",") || "none"}`,
		};
	}
	if (conflicts.size > 0) {
		return {
			kind: WorkspaceRegistrationKind.Conflict,
			details: [...conflicts].sort().join(", "),
		};
	}
	return { kind: WorkspaceRegistrationKind.Absent };
}

function registrationError(registration: WorkspaceRegistration, worktreePath: string): Error {
	switch (registration.kind) {
		case WorkspaceRegistrationKind.Conflict:
			return new Error(
				`Herdr workspace(s) ${registration.details} use ${worktreePath} without the expected linked-worktree registration. Close them and reopen the worktree through Herdr before retrying.`,
			);
		case WorkspaceRegistrationKind.Ambiguous:
			return new Error(
				`Herdr has ambiguous workspaces for ${worktreePath} (${registration.details}). Close the duplicates and retry.`,
			);
		case WorkspaceRegistrationKind.Invalid:
			return new Error("Invalid Herdr workspace registration state.");
		case WorkspaceRegistrationKind.Absent:
		case WorkspaceRegistrationKind.Registered:
			return new Error("Herdr workspace registration is not an error.");
		default:
			return assertNever(registration.kind);
	}
}

function targetKindLabel(plan: TargetPlan): string {
	switch (plan.kind) {
		case TargetKind.NewBranch:
			return "Create new branch";
		case TargetKind.ExistingLocalBranch:
			return "Existing local branch";
		case TargetKind.RemoteTrackingBranch:
			return "Remote tracking branch";
		case TargetKind.ExistingWorktree:
			return "Existing worktree";
		default:
			return assertNever(plan);
	}
}

function wipChoiceLabel(choice: WipChoice): string {
	switch (choice) {
		case WipChoice.Clean:
			return "Source is clean; no WIP transfer needed.";
		case WipChoice.Duplicate:
			return "Duplicate source WIP through a retained recovery stash.";
		case WipChoice.Skip:
			return "Do not copy source WIP.";
		case WipChoice.Invalid:
			throw new Error("Invalid WIP choice.");
		default:
			return assertNever(choice);
	}
}

async function confirmMutation(
	ctx: ExtensionCommandContext,
	preparation: TargetPreparation,
	wipChoice: WipChoice,
	projectTrusted: boolean,
): Promise<boolean> {
	const { plan, preferredWorkspaceId, initialTargetStatus } = preparation;
	const destination = preferredWorkspaceId
		? `Reuse registered Herdr worktree workspace ${preferredWorkspaceId} and create a new tab.`
		: "Open a registered Herdr worktree workspace grouped beneath its repository.";
	const targetState = initialTargetStatus
		? `Existing target has ${countStatusEntries(initialTargetStatus)} changed path(s).`
		: undefined;
	return ctx.ui.confirm(
		"Create branch workspace?",
		[
			`Mode: ${targetKindLabel(plan)}`,
			`Source: ${plan.sourceLabel} (${plan.expectedCommit.slice(0, 12)})`,
			`Target branch: ${plan.branchName}`,
			`Worktree: ${plan.worktreePath}`,
			destination,
			wipChoiceLabel(wipChoice),
			targetState,
			projectTrusted
				? "The new Pi process will inherit this session's trusted-project policy."
				: "The new Pi process will start with project-local resources disabled.",
		].filter(Boolean).join("\n"),
	);
}

async function createRecoveryStash(
	pi: ExtensionAPI,
	repoRoot: string,
	worktreeName: string,
	originalStatus: string,
): Promise<RecoveryStash> {
	const marker = `pi-${COMMAND_NAME}:${worktreeName}:${Date.now()}`;
	await runChecked(pi, GIT_BIN, ["stash", "push", "--include-untracked", "--message", marker], {
		cwd: repoRoot,
	});
	const stashResult = await runChecked(pi, GIT_BIN, ["rev-parse", "--verify", "refs/stash^{commit}"], {
		cwd: repoRoot,
	});
	const objectId = stashResult.stdout.trim();
	const subjectResult = await runChecked(pi, GIT_BIN, ["log", "-1", "--format=%s", objectId], {
		cwd: repoRoot,
	});
	if (!subjectResult.stdout.includes(marker)) {
		throw new Error("Could not verify the recovery stash created for this operation.");
	}

	const restoreResult = await runCommand(pi, GIT_BIN, ["stash", "apply", "--index", objectId], {
		cwd: repoRoot,
	});
	if (restoreResult.code !== 0 || restoreResult.killed) {
		throw new Error(
			`Recovery stash ${objectId} was created, but restoring the source checkout failed. ` +
			`Resolve it manually with: git stash apply --index ${shellQuote(objectId)}. ` +
			truncateMessage(restoreResult.stderr || restoreResult.stdout),
		);
	}

	const restoredStatus = await readGitStatus(pi, repoRoot);
	if (restoredStatus !== originalStatus) {
		throw new Error(
			`Recovery stash ${objectId} was retained, but the restored source status differs from its original state. ` +
			"Inspect the source checkout before continuing.",
		);
	}
	return { objectId, marker };
}

async function preflightHerdr(
	pi: ExtensionAPI,
	herdrBin: string,
	signal?: AbortSignal,
): Promise<void> {
	const paneResult = await runChecked(
		pi,
		herdrBin,
		[HERDR_COMMAND.PANE, HERDR_SUBCOMMAND.CURRENT, "--current"],
		{ signal },
	);
	const paneEnvelope = parseHerdrResult<{ pane?: HerdrPane }>(paneResult.stdout);
	if (!paneEnvelope.pane?.workspace_id) {
		throw new Error("Herdr did not report the current workspace ID.");
	}
	await getHerdrState(pi, herdrBin, signal);
}

async function preflightAutomatedHandoff(
	pi: ExtensionAPI,
	herdrBin: string,
	signal?: AbortSignal,
): Promise<void> {
	await preflightHerdr(pi, herdrBin, signal);
	const promptHelp = await runChecked(
		pi,
		herdrBin,
		[HERDR_COMMAND.AGENT, HERDR_SUBCOMMAND.PROMPT, "--help"],
		{ signal },
	);
	const contract = `${promptHelp.stdout}\n${promptHelp.stderr}`;
	if (!contract.includes("--until") || !contract.includes("working")) {
		throw new Error("Herdr lacks prompt-until-working support required for automatic handoff.");
	}
}

async function revalidateTarget(
	pi: ExtensionAPI,
	git: GitContext,
	preparation: TargetPreparation,
): Promise<void> {
	const { plan, initialTargetStatus } = preparation;
	switch (plan.kind) {
		case TargetKind.NewBranch:
			if (await resolveCommit(pi, git.repoRoot, plan.baseRef) !== plan.expectedCommit) {
				throw new Error(`Base ref moved: ${plan.baseRef}`);
			}
			await validateNewBranch(pi, git.repoRoot, plan.branchName);
			await validateWorktreePath(pi, git.repoRoot, plan.worktreePath);
			return;
		case TargetKind.ExistingLocalBranch: {
			if (await resolveCommit(pi, git.repoRoot, plan.branchRef) !== plan.expectedCommit) {
				throw new Error(`Local branch moved: ${plan.branchName}`);
			}
			const catalog = await discoverBranchCatalog(pi, git);
			const branch = catalog.locals.find((item) => item.fullRef === plan.branchRef);
			if (!branch || branch.worktreePath) {
				throw new Error(`Local branch is no longer available for a new worktree: ${plan.branchName}`);
			}
			await validateWorktreePath(pi, git.repoRoot, plan.worktreePath);
			return;
		}
		case TargetKind.RemoteTrackingBranch:
			if (await resolveCommit(pi, git.repoRoot, plan.remoteRef) !== plan.expectedCommit) {
				throw new Error(`Remote ref moved: ${plan.remoteShortName}`);
			}
			await validateNewBranch(pi, git.repoRoot, plan.branchName);
			await validateWorktreePath(pi, git.repoRoot, plan.worktreePath);
			return;
		case TargetKind.ExistingWorktree: {
			const catalog = await discoverBranchCatalog(pi, git);
			const worktree = catalog.worktrees.find(
				(item) => resolve(item.path) === resolve(plan.worktreePath),
			);
			if (!worktree || worktree.branchRef !== plan.branchRef || worktree.head !== plan.expectedCommit) {
				throw new Error(`Existing worktree changed during setup: ${plan.worktreePath}`);
			}
			const currentStatus = await readGitStatus(pi, plan.worktreePath);
			if (currentStatus !== (initialTargetStatus ?? "")) {
				throw new Error(`Existing worktree status changed during setup: ${plan.worktreePath}`);
			}
			return;
		}
		default:
			return assertNever(plan);
	}
}

async function createGitWorktree(
	pi: ExtensionAPI,
	repoRoot: string,
	plan: TargetPlan,
): Promise<void> {
	if (plan.kind === TargetKind.ExistingWorktree) return;
	await mkdir(dirname(plan.worktreePath), { recursive: true, mode: 0o700 });
	let args: string[];
	switch (plan.kind) {
		case TargetKind.NewBranch:
			args = ["worktree", "add", "-b", plan.branchName, plan.worktreePath, plan.expectedCommit];
			break;
		case TargetKind.ExistingLocalBranch:
			args = ["worktree", "add", plan.worktreePath, plan.branchName];
			break;
		case TargetKind.RemoteTrackingBranch:
			args = [
				"worktree",
				"add",
				"--track",
				"-b",
				plan.branchName,
				plan.worktreePath,
				plan.remoteRef,
			];
			break;
		default:
			return assertNever(plan);
	}
	await runChecked(pi, GIT_BIN, args, { cwd: repoRoot, timeout: WORKTREE_CREATE_TIMEOUT_MS });
}

async function isExpectedGitWorktree(
	pi: ExtensionAPI,
	repoRoot: string,
	plan: TargetPlan,
): Promise<boolean> {
	try {
		const result = await runChecked(pi, GIT_BIN, ["worktree", "list", "--porcelain", "-z"], {
			cwd: repoRoot,
		});
		const worktree = parseGitWorktrees(result.stdout).find(
			(item) => resolve(item.path) === resolve(plan.worktreePath),
		);
		if (!worktree || worktree.branchRef !== plan.branchRef || worktree.head !== plan.expectedCommit) return false;
		if (plan.kind === TargetKind.RemoteTrackingBranch) {
			const upstream = await runChecked(
				pi,
				GIT_BIN,
				["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
				{ cwd: plan.worktreePath },
			);
			return upstream.stdout.trim() === plan.remoteShortName;
		}
		return true;
	} catch {
		return false;
	}
}

async function applyWipToTarget(
	pi: ExtensionAPI,
	worktreePath: string,
	stash: RecoveryStash,
): Promise<WipResult> {
	const result = await runCommand(pi, GIT_BIN, ["stash", "apply", "--index", stash.objectId], {
		cwd: worktreePath,
	});
	if (result.code === 0 && !result.killed) return { outcome: WipOutcome.Applied };

	let conflicted = false;
	try {
		const conflicts = await runChecked(pi, GIT_BIN, ["diff", "--name-only", "--diff-filter=U"], {
			cwd: worktreePath,
		});
		conflicted = Boolean(conflicts.stdout.trim());
	} catch {
		// Preserve the original apply failure as the primary diagnostic.
	}
	return {
		outcome: conflicted ? WipOutcome.Conflicted : WipOutcome.Failed,
		details: truncateMessage(result.stderr || result.stdout || "git stash apply failed"),
	};
}

async function paneUsesWorktree(pane: HerdrPane, worktreePath: string): Promise<boolean> {
	for (const panePath of [pane.cwd, pane.foreground_cwd]) {
		if (!panePath) continue;
		if (isSameOrContained(await canonicalPath(worktreePath), await canonicalPath(panePath))) {
			return true;
		}
	}
	return false;
}

type HerdrDestinationExpectation = {
	beforePaneIds?: ReadonlySet<string>;
	expectedTabLabel?: string;
};

async function verifyHerdrDestination(
	pi: ExtensionAPI,
	herdrBin: string,
	git: GitContext,
	plan: TargetPlan,
	destination: HerdrDestination,
	signal?: AbortSignal,
	expectation: HerdrDestinationExpectation = {},
): Promise<void> {
	const state = await getHerdrState(pi, herdrBin, signal);
	const registration = await classifyWorktreeWorkspace(
		state,
		plan.worktreePath,
		git.commonDir,
		plan.isLinkedWorktree,
	);
	if (
		registration.kind !== WorkspaceRegistrationKind.Registered ||
		registration.registered?.workspaceId !== destination.workspaceId
	) {
		throw new Error(
			`Herdr destination ${destination.workspaceId} is not the sole registered worktree workspace for ${plan.worktreePath}.`,
		);
	}
	const pane = state.panes.find((candidate) => candidate.pane_id === destination.paneId);
	if (expectation.beforePaneIds?.has(destination.paneId)) {
		throw new Error("Herdr destination pane existed before this destination operation.");
	}
	if (expectation.expectedTabLabel) {
		const tab = state.tabs.find((candidate) => candidate.tab_id === destination.tabId);
		if (
			!tab ||
			tab.workspace_id !== destination.workspaceId ||
			tab.label !== expectation.expectedTabLabel
		) {
			throw new Error("Herdr destination tab does not have the operation's unique label.");
		}
	}
	if (
		!pane ||
		pane.workspace_id !== destination.workspaceId ||
		pane.tab_id !== destination.tabId ||
		!(await paneUsesWorktree(pane, plan.worktreePath))
	) {
		throw new Error("Herdr destination pane does not match the expected workspace, tab, and worktree path.");
	}
}

async function createHerdrTab(
	pi: ExtensionAPI,
	herdrBin: string,
	git: GitContext,
	workspaceId: string,
	plan: TargetPlan,
	tabLabel = `pi-${plan.worktreeName}`,
	signal?: AbortSignal,
): Promise<HerdrDestination> {
	const before = await getHerdrState(pi, herdrBin, signal);
	const beforePaneIds = new Set(
		before.panes
			.map((pane) => pane.pane_id)
			.filter((paneId): paneId is string => Boolean(paneId)),
	);
	const result = await runCommand(
		pi,
		herdrBin,
		[
			HERDR_COMMAND.TAB,
			HERDR_SUBCOMMAND.CREATE,
			"--workspace",
			workspaceId,
			"--cwd",
			plan.worktreePath,
			"--label",
			tabLabel,
			"--no-focus",
		],
		{ timeout: WORKTREE_CREATE_TIMEOUT_MS, signal },
	);
	let destination: HerdrDestination | undefined;
	let responseError: string | undefined;
	if (result.code === 0 && !result.killed) {
		try {
			const created = parseHerdrResult<{ tab?: HerdrTab; root_pane?: HerdrPane }>(result.stdout);
			const tabId = created.tab?.tab_id ?? created.root_pane?.tab_id;
			const paneId = created.root_pane?.pane_id;
			if (!tabId || !paneId) {
				throw new Error("Herdr created a tab but did not return its tab and root pane IDs.");
			}
			destination = { kind: DestinationKind.ExistingWorkspaceTab, workspaceId, tabId, paneId };
		} catch (error) {
			responseError = formatError(error);
		}
	}
	if (!destination) {
		const after = await getHerdrState(pi, herdrBin, signal);
		const expectedTabIds = new Set(
			after.tabs
				.filter((tab) => tab.workspace_id === workspaceId && tab.label === tabLabel)
				.map((tab) => tab.tab_id)
				.filter((tabId): tabId is string => Boolean(tabId)),
		);
		const candidates: HerdrPane[] = [];
		for (const pane of after.panes) {
			if (
				pane.workspace_id === workspaceId &&
				pane.pane_id &&
				!beforePaneIds.has(pane.pane_id) &&
				pane.tab_id &&
				expectedTabIds.has(pane.tab_id) &&
				(await paneUsesWorktree(pane, plan.worktreePath))
			) {
				candidates.push(pane);
			}
		}
		const tabIds = new Set(candidates.map((pane) => pane.tab_id));
		if (candidates.length === 1 && tabIds.size === 1) {
			destination = {
				kind: DestinationKind.ExistingWorkspaceTab,
				workspaceId,
				tabId: candidates[0].tab_id!,
				paneId: candidates[0].pane_id!,
			};
		} else {
			const failure = result.code !== 0 || result.killed
				? commandFailure(herdrBin, [HERDR_COMMAND.TAB, HERDR_SUBCOMMAND.CREATE], result).message
				: responseError ?? "Herdr returned an incomplete tab response.";
			throw new Error(`${failure} Unable to reconcile the new tab safely.`);
		}
	}
	await verifyHerdrDestination(pi, herdrBin, git, plan, destination, signal, {
		beforePaneIds,
		expectedTabLabel: tabLabel,
	});
	return destination;
}

async function openRegisteredWorktreeWorkspace(
	pi: ExtensionAPI,
	herdrBin: string,
	git: GitContext,
	plan: TargetPlan,
	before: HerdrState,
	tabLabel = `pi-${plan.worktreeName}`,
	signal?: AbortSignal,
): Promise<HerdrDestination> {
	const args = [
		HERDR_COMMAND.WORKTREE,
		HERDR_SUBCOMMAND.OPEN,
		"--cwd",
		git.primaryWorktreePath,
		"--path",
		plan.worktreePath,
		"--label",
		plan.worktreeName,
		"--no-focus",
	];
	const result = await runCommand(pi, herdrBin, args, {
		timeout: WORKTREE_CREATE_TIMEOUT_MS,
		signal,
	});
	let responseError: string | undefined;
	if (result.code === 0 && !result.killed) {
		try {
			const opened = parseHerdrResult<{
				already_open?: unknown;
				root_pane?: HerdrPane;
				workspace?: HerdrWorkspace;
			}>(result.stdout);
			if (typeof opened.already_open !== "boolean") {
				throw new Error("Herdr worktree open did not return a valid already_open flag.");
			}
			const workspaceId = opened.workspace?.workspace_id;
			if (!workspaceId) throw new Error("Herdr worktree open did not return a workspace ID.");
			const after = await getHerdrState(pi, herdrBin, signal);
			const registration = await classifyWorktreeWorkspace(
				after,
				plan.worktreePath,
				git.commonDir,
				plan.isLinkedWorktree,
			);
			if (
				registration.kind !== WorkspaceRegistrationKind.Registered ||
				registration.registered?.workspaceId !== workspaceId
			) {
				throw new Error("Herdr worktree open returned a workspace without the expected repository registration.");
			}
			if (opened.already_open) {
				return createHerdrTab(pi, herdrBin, git, workspaceId, plan, tabLabel, signal);
			}
			const rootPane = opened.root_pane;
			if (
				!rootPane?.pane_id ||
				!rootPane.tab_id ||
				rootPane.workspace_id !== workspaceId ||
				!(await paneUsesWorktree(rootPane, plan.worktreePath))
			) {
				throw new Error("Herdr worktree open returned a contradictory or incomplete root pane.");
			}
			const destination: HerdrDestination = {
				kind: DestinationKind.NewWorktreeWorkspace,
				workspaceId,
				tabId: rootPane.tab_id,
				paneId: rootPane.pane_id,
			};
			const beforePaneIds = new Set(
				before.panes
					.map((pane) => pane.pane_id)
					.filter((paneId): paneId is string => Boolean(paneId)),
			);
			await verifyHerdrDestination(pi, herdrBin, git, plan, destination, signal, { beforePaneIds });
			return destination;
		} catch (error) {
			responseError = formatError(error);
		}
	}

	const after = await getHerdrState(pi, herdrBin, signal);
	const registration = await classifyWorktreeWorkspace(
		after,
		plan.worktreePath,
		git.commonDir,
		plan.isLinkedWorktree,
	);
	if (registration.kind === WorkspaceRegistrationKind.Registered && registration.registered) {
		const beforePaneIds = new Set(
			before.panes
				.map((pane) => pane.pane_id)
				.filter((paneId): paneId is string => Boolean(paneId)),
		);
		const candidates: HerdrPane[] = [];
		for (const pane of after.panes) {
			if (
				pane.workspace_id === registration.registered.workspaceId &&
				pane.pane_id &&
				!beforePaneIds.has(pane.pane_id) &&
				pane.tab_id &&
				(await paneUsesWorktree(pane, plan.worktreePath))
			) {
				candidates.push(pane);
			}
		}
		if (candidates.length === 1) {
			const beforeWorkspaceIds = new Set(
				before.workspaces.map((workspace) => workspace.workspace_id).filter(Boolean),
			);
			const reconciled: HerdrDestination = {
				kind: beforeWorkspaceIds.has(registration.registered.workspaceId)
					? DestinationKind.ExistingWorkspaceTab
					: DestinationKind.NewWorktreeWorkspace,
				workspaceId: registration.registered.workspaceId,
				tabId: candidates[0].tab_id!,
				paneId: candidates[0].pane_id!,
			};
			await verifyHerdrDestination(pi, herdrBin, git, plan, reconciled, signal, { beforePaneIds });
			return reconciled;
		}
	}
	const failure = result.code !== 0 || result.killed
		? commandFailure(herdrBin, args, result).message
		: responseError ?? "Herdr returned an incomplete worktree-open response.";
	throw new Error(`${failure} The Git worktree remains at ${plan.worktreePath}.`);
}

export async function openHerdrDestination(
	pi: ExtensionAPI,
	herdrBin: string,
	git: GitContext,
	plan: TargetPlan,
	preferredWorkspaceId: string | undefined,
	tabLabel = `pi-${plan.worktreeName}`,
	signal?: AbortSignal,
): Promise<HerdrDestination> {
	const before = await getHerdrState(pi, herdrBin, signal);
	const registration = await classifyWorktreeWorkspace(
		before,
		plan.worktreePath,
		git.commonDir,
		plan.isLinkedWorktree,
	);
	switch (registration.kind) {
		case WorkspaceRegistrationKind.Registered: {
			const workspaceId = registration.registered!.workspaceId;
			if (preferredWorkspaceId && preferredWorkspaceId !== workspaceId) {
				throw new Error(`Preferred Herdr workspace disappeared or changed: ${preferredWorkspaceId}`);
			}
			return createHerdrTab(pi, herdrBin, git, workspaceId, plan, tabLabel, signal);
		}
		case WorkspaceRegistrationKind.Absent:
			if (preferredWorkspaceId) {
				throw new Error(`Preferred Herdr workspace disappeared or changed: ${preferredWorkspaceId}`);
			}
			return openRegisteredWorktreeWorkspace(
				pi,
				herdrBin,
				git,
				plan,
				before,
				tabLabel,
				signal,
			);
		case WorkspaceRegistrationKind.Conflict:
		case WorkspaceRegistrationKind.Ambiguous:
		case WorkspaceRegistrationKind.Invalid:
			throw registrationError(registration, plan.worktreePath);
		default:
			return assertNever(registration.kind);
	}
}

export function makeAgentName(worktreeName: string): string {
	const suffix = Date.now().toString(36).slice(-5);
	const base = `bw-${worktreeName.toLowerCase()}`
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-");
	const maxBaseLength = MAX_AGENT_NAME_LENGTH - suffix.length - 1;
	return `${base.slice(0, maxBaseLength).replace(/[-_]$/g, "")}-${suffix}`;
}

function makeAutomatedAgentName(worktreeName: string, requestId: string): string {
	const suffix = requestId.slice(0, AUTOMATED_HANDOFF_ID_LENGTH).toLowerCase();
	const base = `bh-${worktreeName.toLowerCase()}`
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-");
	const maxBaseLength = MAX_AGENT_NAME_LENGTH - suffix.length - 1;
	return `${base.slice(0, maxBaseLength).replace(/[-_]$/g, "")}-${suffix}`;
}

function automatedOutcomeWireValue(outcome: AutomatedHandoffOutcome): string {
	switch (outcome) {
		case AutomatedHandoffOutcome.Accepted:
			return "accepted";
		case AutomatedHandoffOutcome.Executing:
			return "executing";
		case AutomatedHandoffOutcome.DestinationReady:
			return "destination_ready";
		case AutomatedHandoffOutcome.AgentStarted:
			return "agent_started";
		case AutomatedHandoffOutcome.TaskStarted:
			return "task_started";
		case AutomatedHandoffOutcome.Succeeded:
			return "succeeded";
		case AutomatedHandoffOutcome.Failed:
			return "failed";
		case AutomatedHandoffOutcome.Partial:
			return "partial";
		case AutomatedHandoffOutcome.Cancelled:
			return "cancelled";
		case AutomatedHandoffOutcome.Abandoned:
			return "abandoned";
		case AutomatedHandoffOutcome.Invalid:
			throw new Error("Invalid automated handoff outcome.");
		default:
			return assertNever(outcome);
	}
}

function recordAutomatedHandoff(
	pi: ExtensionAPI,
	request: AutomatedHandoffRequest,
	outcome: AutomatedHandoffOutcome,
	message: string,
	location?: PartialHandoffLocation,
): void {
	const entry: AutomatedHandoffEntry = {
		requestId: request.requestId,
		outcome: automatedOutcomeWireValue(outcome),
		timestamp: Date.now(),
		sourceSessionId: request.sourceSessionId,
		targetPath: request.preparation.plan.worktreePath,
		targetBranch: request.preparation.plan.branchName,
		targetRepoKey: request.git.commonDir,
		targetIsLinkedWorktree: request.preparation.plan.isLinkedWorktree,
		agentName: request.agentName,
		tabLabel: request.tabLabel,
		message: truncateMessage(message, 2_000),
		location,
	};
	pi.appendEntry(AUTOMATED_HANDOFF_ENTRY_TYPE, entry);
}

function sanitizeHandoffField(value: string, maxLength = 2_000): string {
	return truncateMessage(value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " "), maxLength);
}

function wipResultDescription(
	choice: WipChoice,
	result: WipResult,
	stash: RecoveryStash | undefined,
): string {
	switch (result.outcome) {
		case WipOutcome.Clean:
			return "The source worktree was clean; no WIP transfer was needed.";
		case WipOutcome.Skipped:
			return "The source had uncommitted work, but the user chose not to copy it into this target.";
		case WipOutcome.Applied:
			return `Source WIP was duplicated successfully. Recovery stash ${stash?.objectId} (${stash?.marker}) was intentionally retained.`;
		case WipOutcome.Conflicted:
			return `Applying recovery stash ${stash?.objectId} produced conflicts. Inspect git status before editing. Details: ${result.details}`;
		case WipOutcome.Failed:
			return `Applying recovery stash ${stash?.objectId} failed without detected unmerged paths. Inspect git status and the retained stash. Details: ${result.details}`;
		case WipOutcome.Invalid:
			throw new Error(`Invalid WIP result for choice ${choice}.`);
		default:
			return assertNever(result.outcome);
	}
}

function buildHandoffPrompt(
	preparation: TargetPreparation,
	destination: HerdrDestination,
	wipChoice: WipChoice,
	wipResult: WipResult,
	stash: RecoveryStash | undefined,
): string {
	const { plan, initialTargetStatus } = preparation;
	const destinationText = destination.kind === DestinationKind.NewWorktreeWorkspace
		? "a repository-grouped Herdr worktree workspace"
		: "a new tab in an existing registered Herdr worktree workspace";
	return [
		`Handoff notice: this Pi session was forked into ${destinationText}.`,
		`Target mode: ${targetKindLabel(plan)}`,
		`Source: ${plan.sourceLabel}`,
		`Expected starting commit: ${plan.expectedCommit}`,
		`Current branch: ${plan.branchName}`,
		`Worktree path: ${plan.worktreePath}`,
		`Herdr workspace/tab: ${destination.workspaceId} / ${destination.tabId}`,
		initialTargetStatus
			? `The reused target already had ${countStatusEntries(initialTargetStatus)} changed path(s) before this handoff.`
			: "The target had no pre-existing reported changes.",
		wipResultDescription(wipChoice, wipResult, stash),
		"Acknowledge this handoff briefly, inspect git status without modifying files, and then wait for the user's next instruction.",
	].join("\n");
}

function buildAutomatedHandoffPrompt(
	request: AutomatedHandoffRequest,
	destination: HerdrDestination,
): string {
	const plan = request.preparation.plan;
	const changedPaths = countStatusEntries(request.preparation.initialTargetStatus ?? "");
	return [
		"Automatic cross-worktree handoff: this Pi session was forked after the source agent recognized that the task belongs in this checkout.",
		`Request ID: ${request.requestId}`,
		`Source checkout/ref: ${sanitizeHandoffField(request.sourceCwd)} / ${sanitizeHandoffField(request.sourceRef)}`,
		`Target checkout/ref: ${sanitizeHandoffField(plan.worktreePath)} / ${sanitizeHandoffField(plan.branchName)}`,
		`Expected target commit: ${plan.expectedCommit}`,
		`Herdr workspace/tab/pane: ${destination.workspaceId} / ${destination.tabId} / ${destination.paneId}`,
		`The target had ${changedPaths} changed path(s) when the handoff was accepted.`,
		"Begin the task now. Work only in the target checkout, inspect git status before mutation, preserve unrelated changes, and do not send work back to the source checkout.",
		"Task:",
		request.task,
	].join("\n");
}

async function startForkedAgent(
	pi: ExtensionAPI,
	herdrBin: string,
	destination: HerdrDestination,
	sessionFile: string,
	agentName: string,
	config: ForkedAgentConfig,
	signal?: AbortSignal,
): Promise<void> {
	const trustFlag = config.projectTrusted ? "--approve" : "--no-approve";
	await runChecked(
		pi,
		herdrBin,
		[
			HERDR_COMMAND.AGENT,
			HERDR_SUBCOMMAND.START,
			agentName,
			"--kind",
			"pi",
			"--pane",
			destination.paneId,
			"--timeout",
			String(AGENT_START_TIMEOUT_MS),
			"--",
			"--fork",
			sessionFile,
			"--model",
			config.model,
			"--thinking",
			config.thinkingLevel,
			"--name",
			config.sessionName,
			trustFlag,
		],
		{ timeout: AGENT_START_TIMEOUT_MS + EXTERNAL_COMMAND_TIMEOUT_MS, signal },
	);
}

async function getAgentInfo(
	pi: ExtensionAPI,
	herdrBin: string,
	agentName: string,
	signal?: AbortSignal,
): Promise<HerdrPane | undefined> {
	const result = await runCommand(
		pi,
		herdrBin,
		[HERDR_COMMAND.AGENT, HERDR_SUBCOMMAND.GET, agentName],
		{ signal },
	);
	if (result.code !== 0 || result.killed) return undefined;
	try {
		return parseHerdrResult<{ agent?: HerdrPane }>(result.stdout).agent;
	} catch {
		return undefined;
	}
}

async function isAgentRunningInPane(
	pi: ExtensionAPI,
	herdrBin: string,
	agentName: string,
	paneId: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const agent = await getAgentInfo(pi, herdrBin, agentName, signal);
	return agent?.pane_id === paneId
		&& (agent.agent === undefined || agent.agent === "pi")
		&& (agent.agent_session?.agent === undefined || agent.agent_session.agent === "pi");
}

async function sendHandoff(
	pi: ExtensionAPI,
	herdrBin: string,
	agentName: string,
	prompt: string,
): Promise<void> {
	await runChecked(
		pi,
		herdrBin,
		[
			HERDR_COMMAND.AGENT,
			HERDR_SUBCOMMAND.PROMPT,
			agentName,
			prompt,
			"--wait",
			"--timeout",
			String(HANDOFF_TIMEOUT_MS),
		],
		{ timeout: HANDOFF_TIMEOUT_MS + EXTERNAL_COMMAND_TIMEOUT_MS },
	);
}

async function focusDestination(
	pi: ExtensionAPI,
	herdrBin: string,
	destination: HerdrDestination,
	signal?: AbortSignal,
): Promise<void> {
	await runChecked(
		pi,
		herdrBin,
		[HERDR_COMMAND.WORKSPACE, HERDR_SUBCOMMAND.FOCUS, destination.workspaceId],
		{ signal },
	);
	await runChecked(
		pi,
		herdrBin,
		[HERDR_COMMAND.TAB, HERDR_SUBCOMMAND.FOCUS, destination.tabId],
		{ signal },
	);
}

function assistantToolCalls(ctx: ExtensionContext): Array<{ id: string; name: string }> {
	const assistant = [...ctx.sessionManager.getBranch()].reverse().find((entry) =>
		entry.type === "message" && entry.message.role === "assistant" && "content" in entry.message
	);
	if (
		!assistant ||
		assistant.type !== "message" ||
		assistant.message.role !== "assistant" ||
		!Array.isArray(assistant.message.content)
	) return [];
	return assistant.message.content.flatMap((content) =>
		content.type === "toolCall" ? [{ id: content.id, name: content.name }] : []
	);
}

function entriesContainAcceptedHandoffResult(
	branch: SessionEntry[],
	request: AutomatedHandoffRequest,
): boolean {
	if (!branch.some((entry) => entry.id === request.sourceLeafId)) return false;
	return branch.some((entry) => {
		if (entry.type !== "message" || entry.message.role !== "toolResult") return false;
		const details = entry.message.details as { requestId?: string; accepted?: boolean } | undefined;
		return entry.message.toolName === AUTOMATED_HANDOFF_TOOL_NAME
			&& entry.message.toolCallId === request.toolCallId
			&& entry.message.isError !== true
			&& details?.accepted === true
			&& details.requestId === request.requestId;
	});
}

function branchContainsAcceptedHandoffResult(
	ctx: ExtensionContext,
	request: AutomatedHandoffRequest,
): boolean {
	return entriesContainAcceptedHandoffResult(ctx.sessionManager.getBranch(), request);
}

async function verifyAcceptedHandoffOnDisk(request: AutomatedHandoffRequest): Promise<void> {
	let lines: string[];
	try {
		lines = (await readFile(request.sourceSessionFile, "utf8"))
			.split("\n")
			.filter((line) => line.trim().length > 0);
	} catch (error) {
		throw new Error(`Could not read the source session file before handoff: ${formatError(error)}`);
	}
	if (lines.length < 2) throw new Error("The source session file is empty or incomplete.");
	let records: Array<Record<string, unknown>>;
	try {
		records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch (error) {
		throw new Error(`The source session file is not valid JSONL: ${formatError(error)}`);
	}
	const header = records[0];
	if (header.type !== "session" || header.id !== request.sourceSessionId) {
		throw new Error("The source session file no longer identifies the accepted source session.");
	}
	const entries = records.slice(1) as unknown as SessionEntry[];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const visited = new Set<string>();
	let current = entries.at(-1);
	while (current) {
		if (visited.has(current.id)) throw new Error("The source session file contains a parent cycle.");
		visited.add(current.id);
		branch.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	branch.reverse();
	if (!entriesContainAcceptedHandoffResult(branch, request)) {
		throw new Error("The accepted handoff result is not durably present on the source session's active branch.");
	}
	const assistant = [...branch].reverse().find((entry) =>
		entry.type === "message" && entry.message.role === "assistant" && "content" in entry.message
	);
	const calls = assistant?.type === "message"
		&& assistant.message.role === "assistant"
		&& Array.isArray(assistant.message.content)
		? assistant.message.content.filter((content) => content.type === "toolCall")
		: [];
	if (
		calls.length !== 1 ||
		calls[0]?.id !== request.toolCallId ||
		calls[0]?.name !== AUTOMATED_HANDOFF_TOOL_NAME
	) {
		throw new Error("The durable assistant message does not contain exactly the accepted handoff tool call.");
	}
}

function branchContainsEntry(ctx: ExtensionContext, entryId: string | undefined): boolean {
	if (!entryId) return true;
	return ctx.sessionManager.getBranch().some((entry) => entry.id === entryId);
}

async function prepareAutomatedHandoff(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	input: AutomatedHandoffToolInput,
	toolCallId: string,
	herdrBin: string,
	signal?: AbortSignal,
): Promise<AutomatedHandoffRequest> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		throw new Error("Automatic worktree handoff requires interactive TUI mode.");
	}
	if (process.env.HERDR_ENV !== "1") {
		throw new Error("Automatic worktree handoff requires Pi to run inside Herdr.");
	}
	if (ctx.hasPendingMessages()) {
		throw new Error("Automatic worktree handoff requires no queued steering or follow-up messages.");
	}
	const sourceSessionFile = ctx.sessionManager.getSessionFile();
	if (!sourceSessionFile) throw new Error("The current Pi session is not persisted and cannot be forked.");
	if (!ctx.model) throw new Error("No active Pi model is selected.");
	const task = normalizeAutomatedHandoffText(input.task, "Handoff task", MAX_HANDOFF_TASK_LENGTH);
	const git = await inspectGitContext(pi, ctx.cwd, signal);
	await preflightAutomatedHandoff(pi, herdrBin, signal);
	const plan = await resolveAutomatedWorktreeTarget(pi, git, ctx.cwd, input.worktree, signal);
	const target = await readTargetFingerprint(pi, plan.worktreePath, signal);
	const initialHerdrState = await getHerdrState(pi, herdrBin, signal);
	const initialRegistration = await classifyWorktreeWorkspace(
		initialHerdrState,
		plan.worktreePath,
		git.commonDir,
		plan.isLinkedWorktree,
	);
	let preferredWorkspaceId: string | undefined;
	switch (initialRegistration.kind) {
		case WorkspaceRegistrationKind.Absent:
			break;
		case WorkspaceRegistrationKind.Registered:
			preferredWorkspaceId = initialRegistration.registered!.workspaceId;
			break;
		case WorkspaceRegistrationKind.Conflict:
		case WorkspaceRegistrationKind.Ambiguous:
		case WorkspaceRegistrationKind.Invalid:
			throw registrationError(initialRegistration, plan.worktreePath);
		default:
			assertNever(initialRegistration.kind);
	}
	const requestId = randomUUID().replaceAll("-", "").slice(0, AUTOMATED_HANDOFF_ID_LENGTH);
	const agentName = makeAutomatedAgentName(plan.worktreeName, requestId);
	if (await getAgentInfo(pi, herdrBin, agentName, signal)) {
		throw new Error(`Herdr agent name collision: ${agentName}`);
	}
	return {
		requestId,
		toolCallId,
		sourceSessionId: ctx.sessionManager.getSessionId(),
		sourceSessionFile,
		sourceLeafId: ctx.sessionManager.getLeafId() ?? undefined,
		sourceCwd: ctx.cwd,
		sourceRef: git.currentRef,
		sourceSessionName: pi.getSessionName(),
		model: `${ctx.model.provider}/${ctx.model.id}`,
		thinkingLevel: pi.getThinkingLevel(),
		projectTrusted: ctx.isProjectTrusted(),
		task,
		git,
		preparation: {
			plan,
			preferredWorkspaceId,
			initialTargetStatus: target.status,
		},
		targetFingerprint: target.fingerprint,
		agentName,
		tabLabel: `pi-handoff-${requestId}`,
		acceptedAt: Date.now(),
	};
}

async function revalidateAutomatedTarget(
	pi: ExtensionAPI,
	request: AutomatedHandoffRequest,
	herdrBin: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const plan = request.preparation.plan;
	const catalog = await discoverBranchCatalog(pi, request.git, signal);
	const targetPath = await canonicalPath(plan.worktreePath);
	const target = catalog.worktrees.find(
		(worktree) => resolve(worktree.path) === resolve(targetPath),
	);
	if (!target || target.branchRef !== plan.branchRef || target.head !== plan.expectedCommit) {
		throw new Error(`Target worktree changed after handoff acceptance: ${plan.worktreePath}`);
	}
	const primaryPath = await canonicalPath(request.git.primaryWorktreePath);
	if ((targetPath !== primaryPath) !== plan.isLinkedWorktree) {
		throw new Error(`Target worktree linkage changed after handoff acceptance: ${plan.worktreePath}`);
	}
	const fingerprint = await readTargetFingerprint(pi, plan.worktreePath, signal);
	if (fingerprint.fingerprint !== request.targetFingerprint) {
		throw new Error(`Target worktree contents changed after handoff acceptance: ${plan.worktreePath}`);
	}
	const state = await getHerdrState(pi, herdrBin, signal);
	const registration = await classifyWorktreeWorkspace(
		state,
		plan.worktreePath,
		request.git.commonDir,
		plan.isLinkedWorktree,
	);
	switch (registration.kind) {
		case WorkspaceRegistrationKind.Absent:
			return undefined;
		case WorkspaceRegistrationKind.Registered:
			return registration.registered!.workspaceId;
		case WorkspaceRegistrationKind.Conflict:
		case WorkspaceRegistrationKind.Ambiguous:
		case WorkspaceRegistrationKind.Invalid:
			throw registrationError(registration, plan.worktreePath);
		default:
			return assertNever(registration.kind);
	}
}

async function recoverPartialHandoffLocation(
	pi: ExtensionAPI,
	herdrBin: string,
	request: AutomatedHandoffRequest,
	before: HerdrState | undefined,
	existing: PartialHandoffLocation | undefined,
): Promise<PartialHandoffLocation | undefined> {
	const location: PartialHandoffLocation = { ...existing, agentName: request.agentName };
	try {
		const agent = await getAgentInfo(pi, herdrBin, request.agentName);
		if (agent?.pane_id) {
			location.paneId = agent.pane_id;
			location.workspaceId = agent.workspace_id;
			location.tabId = agent.tab_id;
		}
		const after = await getHerdrState(pi, herdrBin);
		const registration = await classifyWorktreeWorkspace(
			after,
			request.preparation.plan.worktreePath,
			request.git.commonDir,
			request.preparation.plan.isLinkedWorktree,
		);
		if (registration.kind === WorkspaceRegistrationKind.Registered && registration.registered) {
			location.workspaceId ??= registration.registered.workspaceId;
			const beforePaneIds = new Set(before?.panes.map((pane) => pane.pane_id).filter(Boolean) ?? []);
			const requestTabIds = new Set(
				after.tabs
					.filter((tab) => tab.workspace_id === location.workspaceId && tab.label === request.tabLabel)
					.map((tab) => tab.tab_id)
					.filter((tabId): tabId is string => Boolean(tabId)),
			);
			const candidates = after.panes.filter((pane) =>
				pane.workspace_id === location.workspaceId
				&& pane.pane_id
				&& !beforePaneIds.has(pane.pane_id)
				&& pane.tab_id
				&& requestTabIds.has(pane.tab_id)
			);
			if (candidates.length === 1) {
				location.paneId ??= candidates[0].pane_id;
				location.tabId ??= candidates[0].tab_id;
			}
		}
	} catch {
		// Preserve every identifier already known by the caller.
	}
	return Object.values(location).some(Boolean) ? location : undefined;
}

async function recoverJournaledHandoffLocation(
	pi: ExtensionAPI,
	herdrBin: string,
	entry: AutomatedHandoffEntry,
): Promise<PartialHandoffLocation | undefined> {
	const location: PartialHandoffLocation = { ...entry.location, agentName: entry.agentName };
	try {
		const agent = await getAgentInfo(pi, herdrBin, entry.agentName);
		if (agent?.pane_id) {
			location.paneId = agent.pane_id;
			location.workspaceId = agent.workspace_id;
			location.tabId = agent.tab_id;
		}
		const state = await getHerdrState(pi, herdrBin);
		if (entry.targetRepoKey && typeof entry.targetIsLinkedWorktree === "boolean") {
			const registration = await classifyWorktreeWorkspace(
				state,
				entry.targetPath,
				entry.targetRepoKey,
				entry.targetIsLinkedWorktree,
			);
			if (registration.kind === WorkspaceRegistrationKind.Registered && registration.registered) {
				location.workspaceId ??= registration.registered.workspaceId;
			}
		}
		if (location.workspaceId && !location.paneId) {
			const tabIds = new Set(
				state.tabs
					.filter((tab) => tab.workspace_id === location.workspaceId && tab.label === entry.tabLabel)
					.map((tab) => tab.tab_id)
					.filter((tabId): tabId is string => Boolean(tabId)),
			);
			const candidates = state.panes.filter((pane) =>
				pane.workspace_id === location.workspaceId
					&& pane.pane_id
					&& pane.tab_id
					&& tabIds.has(pane.tab_id)
			);
			if (candidates.length === 1) {
				location.paneId = candidates[0].pane_id;
				location.tabId = candidates[0].tab_id;
			}
		}
	} catch {
		// Preserve identifiers already recorded in the durable journal.
	}
	return Object.values(location).some(Boolean) ? location : undefined;
}

async function sendAutomatedHandoff(
	pi: ExtensionAPI,
	herdrBin: string,
	request: AutomatedHandoffRequest,
	destination: HerdrDestination,
	signal?: AbortSignal,
): Promise<boolean> {
	const before = await getAgentInfo(pi, herdrBin, request.agentName, signal);
	if (before?.pane_id !== destination.paneId) {
		throw new Error("The reserved destination agent is not attached to the expected pane.");
	}
	if (before.agent_status === "working") {
		throw new Error("The reserved destination agent was already working before task submission.");
	}
	const args = [
		HERDR_COMMAND.AGENT,
		HERDR_SUBCOMMAND.PROMPT,
		request.agentName,
		buildAutomatedHandoffPrompt(request, destination),
		"--wait",
		"--until",
		"working",
		"--timeout",
		String(AUTOMATED_HANDOFF_START_TIMEOUT_MS),
	];
	const result = await runCommand(pi, herdrBin, args, {
		timeout: AUTOMATED_HANDOFF_START_TIMEOUT_MS + EXTERNAL_COMMAND_TIMEOUT_MS,
		signal,
	});
	const after = await getAgentInfo(pi, herdrBin, request.agentName, signal);
	const sequenceAdvanced = typeof after?.state_change_seq === "number"
		&& after.state_change_seq > (before.state_change_seq ?? -1);
	if (after?.pane_id === destination.paneId && sequenceAdvanced) {
		return result.code !== 0 || Boolean(result.killed);
	}
	if (result.code === 0 && !result.killed) {
		throw new Error("Herdr returned prompt success without a destination-agent state transition.");
	}
	throw commandFailure(herdrBin, args, result);
}

async function executeAutomatedHandoff(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	runtime: AutomatedHandoffRuntime,
	herdrBin: string,
): Promise<void> {
	const request = runtime.request;
	if (!request) throw new Error("Automatic handoff request was not prepared.");
	if (ctx.sessionManager.getSessionId() !== request.sourceSessionId
		|| ctx.sessionManager.getSessionFile() !== request.sourceSessionFile) {
		throw new Error("Source Pi session changed before automatic handoff execution.");
	}
	if (!ctx.isIdle() || ctx.hasPendingMessages()) {
		throw new Error("Source Pi is not idle or has queued messages; automatic handoff was cancelled.");
	}
	if (!branchContainsEntry(ctx, request.sourceLeafId)
		|| !branchContainsAcceptedHandoffResult(ctx, request)) {
		throw new Error("The accepted handoff tool result is not on the active session branch.");
	}
	await verifyAcceptedHandoffOnDisk(request);

	runtime.phase = AutomatedHandoffPhase.Executing;
	runtime.abortController = new AbortController();
	const signal = runtime.abortController.signal;
	let beforeHerdr: HerdrState | undefined;
	let destination: HerdrDestination | undefined;
	const warnings: string[] = [];
	ctx.ui.setStatus(COMMAND_NAME, "Handing off to worktree…");
	recordAutomatedHandoff(
		pi,
		request,
		AutomatedHandoffOutcome.Executing,
		"Validated the persisted tool result; revalidating the target.",
	);
	try {
		let preferredWorkspaceId = await revalidateAutomatedTarget(pi, request, herdrBin, signal);
		beforeHerdr = await getHerdrState(pi, herdrBin, signal);
		runtime.mutationStarted = true;
		destination = await openHerdrDestination(
			pi,
			herdrBin,
			request.git,
			request.preparation.plan,
			preferredWorkspaceId,
			request.tabLabel,
			signal,
		);
		runtime.location = {
			workspaceId: destination.workspaceId,
			tabId: destination.tabId,
			paneId: destination.paneId,
			agentName: request.agentName,
		};
		recordAutomatedHandoff(
			pi,
			request,
			AutomatedHandoffOutcome.DestinationReady,
			"Herdr destination is ready and verified.",
			runtime.location,
		);

		preferredWorkspaceId = await revalidateAutomatedTarget(pi, request, herdrBin, signal);
		if (preferredWorkspaceId !== destination.workspaceId) {
			throw new Error("Herdr destination registration changed before agent startup.");
		}
		await verifyHerdrDestination(
			pi,
			herdrBin,
			request.git,
			request.preparation.plan,
			destination,
			signal,
		);
		if (await getAgentInfo(pi, herdrBin, request.agentName, signal)) {
			throw new Error(`A Herdr agent already uses the reserved name ${request.agentName}.`);
		}
		await verifyAcceptedHandoffOnDisk(request);
		let startupReconciled = false;
		try {
			await startForkedAgent(
				pi,
				herdrBin,
				destination,
				request.sourceSessionFile,
				request.agentName,
				{
					model: request.model,
					thinkingLevel: request.thinkingLevel,
					projectTrusted: request.projectTrusted,
					sessionName: request.preparation.plan.worktreeName,
				},
				signal,
			);
		} catch (error) {
			startupReconciled = await isAgentRunningInPane(
				pi,
				herdrBin,
				request.agentName,
				destination.paneId,
				signal,
			);
			if (!startupReconciled) throw error;
			warnings.push("Agent startup returned an error, but Herdr verified the reserved Pi agent.");
		}
		recordAutomatedHandoff(
			pi,
			request,
			AutomatedHandoffOutcome.AgentStarted,
			"Forked Pi agent started in the destination pane.",
			runtime.location,
		);

		try {
			const promptReconciled = await sendAutomatedHandoff(pi, herdrBin, request, destination, signal);
			if (promptReconciled) {
				warnings.push("Prompt command returned an error, but Herdr observed destination work start.");
			}
		} catch (error) {
			runtime.phase = AutomatedHandoffPhase.Partial;
			warnings.push(`Task prompt was not verified: ${truncateMessage(formatError(error))}`);
			try {
				await focusDestination(pi, herdrBin, destination, signal);
			} catch (focusError) {
				warnings.push(`Destination focus failed: ${truncateMessage(formatError(focusError))}`);
			}
			recordAutomatedHandoff(
				pi,
				request,
				AutomatedHandoffOutcome.Partial,
				warnings.join(" "),
				runtime.location,
			);
			ctx.ui.notify(
				`Pi ${request.agentName} is running in ${destination.workspaceId}/${destination.tabId}, but the task prompt needs recovery. ${warnings.join(" ")}`,
				"warning",
			);
			return;
		}
		recordAutomatedHandoff(
			pi,
			request,
			AutomatedHandoffOutcome.TaskStarted,
			"Herdr observed the destination Pi begin the handed-off task.",
			runtime.location,
		);
		try {
			await focusDestination(pi, herdrBin, destination, signal);
		} catch (error) {
			warnings.push(`Destination focus failed: ${truncateMessage(formatError(error))}`);
		}
		const outcome = warnings.length > 0
			? AutomatedHandoffOutcome.Partial
			: AutomatedHandoffOutcome.Succeeded;
		recordAutomatedHandoff(
			pi,
			request,
			outcome,
			warnings.length > 0 ? warnings.join(" ") : "Automatic handoff completed successfully.",
			runtime.location,
		);
		ctx.ui.notify(
			`Handed off ${request.preparation.plan.branchName} to Pi ${request.agentName} in ${destination.workspaceId}/${destination.tabId}.${warnings.length > 0 ? ` ${warnings.join(" ")}` : ""}`,
			warnings.length > 0 ? "warning" : "info",
		);
	} catch (error) {
		if (runtime.terminalRecorded) return;
		const recovered = runtime.mutationStarted
			? await recoverPartialHandoffLocation(
				pi,
				herdrBin,
				request,
				beforeHerdr,
				runtime.location,
			)
			: undefined;
		runtime.location = recovered;
		const partial = runtime.mutationStarted && Boolean(recovered?.workspaceId || recovered?.tabId || recovered?.paneId);
		runtime.phase = partial ? AutomatedHandoffPhase.Partial : AutomatedHandoffPhase.Terminal;
		const message = truncateMessage(formatError(error), 2_000);
		recordAutomatedHandoff(
			pi,
			request,
			partial ? AutomatedHandoffOutcome.Partial : AutomatedHandoffOutcome.Failed,
			message,
			recovered,
		);
		ctx.ui.notify(
			partial
				? `Automatic handoff partially created destination state (${recovered?.workspaceId ?? "unknown"}/${recovered?.tabId ?? "unknown"}/${recovered?.paneId ?? "unknown"}, agent ${request.agentName}). ${message}`
				: `Automatic handoff failed before a verified destination was created: ${message}`,
			partial ? "warning" : "error",
		);
	} finally {
		runtime.abortController = undefined;
		runtime.phase = AutomatedHandoffPhase.Terminal;
		ctx.ui.setStatus(COMMAND_NAME, undefined);
	}
}

export default function branchWorkspaceExtension(pi: ExtensionAPI) {
	let commandRunning = false;
	let automatedRuntime: AutomatedHandoffRuntime | undefined;

	const handoffIsActive = () => automatedRuntime !== undefined
		&& automatedRuntime.phase !== AutomatedHandoffPhase.Terminal;

	pi.on("tool_call", (event, ctx) => {
		if (isToolCallEventType<typeof AUTOMATED_HANDOFF_TOOL_NAME, AutomatedHandoffToolInput>(
			AUTOMATED_HANDOFF_TOOL_NAME,
			event,
		)) {
			if (commandRunning || handoffIsActive()) {
				return {
					block: true,
					reason: "A branch-workspace operation is already active.",
					terminate: true,
				};
			}
			const calls = assistantToolCalls(ctx);
			if (
				calls.length !== 1 ||
				calls[0]?.id !== event.toolCallId ||
				calls[0]?.name !== AUTOMATED_HANDOFF_TOOL_NAME
			) {
				return {
					block: true,
					reason: `${AUTOMATED_HANDOFF_TOOL_NAME} must be the only tool call in its persisted assistant message. Call it again by itself.`,
				};
			}
			automatedRuntime = {
				phase: AutomatedHandoffPhase.Reserved,
				toolCallId: event.toolCallId,
				mutationStarted: false,
				terminalRecorded: false,
			};
			return;
		}
		if (handoffIsActive()) {
			return {
				block: true,
				reason: "Source tools are blocked while an automatic worktree handoff is pending.",
				terminate: true,
			};
		}
	});

	pi.on("tool_execution_end", (event) => {
		if (
			automatedRuntime?.phase === AutomatedHandoffPhase.Reserved &&
			automatedRuntime.toolCallId === event.toolCallId
		) {
			automatedRuntime = undefined;
		}
	});

	pi.on("input", (_event, ctx) => {
		if (!handoffIsActive()) return { action: "continue" as const };
		ctx.ui.notify("The source Pi is waiting for its automatic worktree handoff to finish.", "warning");
		return { action: "handled" as const };
	});

	pi.registerTool({
		name: AUTOMATED_HANDOFF_TOOL_NAME,
		label: "Worktree Handoff",
		description: "Fork this Pi session into another existing branch-attached Git worktree, open or reuse its Herdr workspace in a new tab, start the exact task there, focus it, and leave this source Pi idle.",
		promptSnippet: "Hand off work to another existing Git worktree and begin it in a forked Pi session",
		promptGuidelines: [
			`Use ${AUTOMATED_HANDOFF_TOOL_NAME} as the sole final tool call when the user asks to modify files in a Git worktree other than the current checkout.`,
			`Before calling ${AUTOMATED_HANDOFF_TOOL_NAME}, reads may identify the destination, but do not edit, write, or run mutating shell commands in another worktree from the source Pi.`,
			`After calling ${AUTOMATED_HANDOFF_TOOL_NAME}, do not call more tools or continue the task in the source Pi; the forked destination Pi will begin the supplied task.`,
		],
		parameters: automatedHandoffToolSchema,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const runtime = automatedRuntime;
			if (
				!runtime ||
				runtime.phase !== AutomatedHandoffPhase.Reserved ||
				runtime.toolCallId !== toolCallId
			) {
				throw new Error("Automatic handoff did not acquire its sole-tool reservation.");
			}
			onUpdate?.({
				content: [{ type: "text", text: "Validating the destination worktree and Herdr state…" }],
				details: { phase: "preflight" },
			});
			const herdrBin = process.env.HERDR_BIN?.trim() || HERDR_DEFAULT_BIN;
			try {
				const request = await prepareAutomatedHandoff(
					pi,
					ctx,
					params,
					toolCallId,
					herdrBin,
					signal,
				);
				runtime.request = request;
				runtime.phase = AutomatedHandoffPhase.Accepted;
				recordAutomatedHandoff(
					pi,
					request,
					AutomatedHandoffOutcome.Accepted,
					"Read-only preflight passed; waiting for the source agent to settle.",
				);
				return {
					content: [{
						type: "text",
						text: `Accepted automatic handoff ${request.requestId} to ${request.preparation.plan.branchName} at ${request.preparation.plan.worktreePath}. The source Pi will stop and the destination Pi will begin the task.`,
					}],
					details: {
						accepted: true,
						requestId: request.requestId,
						targetBranch: request.preparation.plan.branchName,
						targetPath: request.preparation.plan.worktreePath,
						agentName: request.agentName,
					},
					terminate: true,
				};
			} catch (error) {
				automatedRuntime = undefined;
				throw error;
			}
		},
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const runtime = automatedRuntime;
		if (!runtime) return;
		if (runtime.phase === AutomatedHandoffPhase.Reserved) {
			automatedRuntime = undefined;
			ctx.ui.setStatus(COMMAND_NAME, undefined);
			return;
		}
		if (runtime.phase !== AutomatedHandoffPhase.Accepted || !runtime.request) return;
		const request = runtime.request;
		const herdrBin = process.env.HERDR_BIN?.trim() || HERDR_DEFAULT_BIN;
		try {
			await executeAutomatedHandoff(pi, ctx, runtime, herdrBin);
		} catch (error) {
			if (!runtime.terminalRecorded) {
				recordAutomatedHandoff(
					pi,
					request,
					AutomatedHandoffOutcome.Failed,
					formatError(error),
					runtime.location,
				);
				ctx.ui.notify(`Automatic handoff cancelled: ${truncateMessage(formatError(error))}`, "error");
			}
		} finally {
			if (automatedRuntime === runtime) automatedRuntime = undefined;
			ctx.ui.setStatus(COMMAND_NAME, undefined);
		}
	});

	pi.on("session_shutdown", (_event) => {
		const runtime = automatedRuntime;
		if (!runtime?.request || runtime.phase === AutomatedHandoffPhase.Terminal) return;
		runtime.abortController?.abort();
		runtime.terminalRecorded = true;
		runtime.phase = AutomatedHandoffPhase.Terminal;
		recordAutomatedHandoff(
			pi,
			runtime.request,
			runtime.mutationStarted ? AutomatedHandoffOutcome.Partial : AutomatedHandoffOutcome.Cancelled,
			runtime.mutationStarted
				? "Source session shut down after destination mutation began; inspect the recorded destination identifiers."
				: "Source session shut down before destination mutation began.",
			runtime.location,
		);
	});

	pi.on("session_start", async (_event, ctx) => {
		const latest = new Map<string, AutomatedHandoffEntry>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== AUTOMATED_HANDOFF_ENTRY_TYPE) continue;
			const data = entry.data as AutomatedHandoffEntry;
			if (data?.requestId) latest.set(data.requestId, data);
		}
		const terminal = new Set(["succeeded", "failed", "cancelled", "abandoned"]);
		for (const entry of latest.values()) {
			if (entry.sourceSessionId !== ctx.sessionManager.getSessionId() || terminal.has(entry.outcome)) continue;
			const location = await recoverJournaledHandoffLocation(
				pi,
				process.env.HERDR_BIN?.trim() || HERDR_DEFAULT_BIN,
				entry,
			);
			const hasDestination = Boolean(location?.workspaceId || location?.tabId || location?.paneId);
			const recovered: AutomatedHandoffEntry = {
				...entry,
				outcome: hasDestination ? "failed" : "abandoned",
				timestamp: Date.now(),
				message: hasDestination
					? "Reconciled an interrupted handoff with partial destination state; inspect the recorded workspace, tab, pane, and agent before retrying."
					: "Reconciled an interrupted handoff without finding destination state; the request was abandoned before retry.",
				location,
			};
			pi.appendEntry(AUTOMATED_HANDOFF_ENTRY_TYPE, recovered);
			ctx.ui.notify(recovered.message, hasDestination ? "warning" : "error");
		}
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Fork this Pi session into a repository-grouped Herdr worktree workspace",
		handler: async (_args, ctx) => {
			if (commandRunning || handoffIsActive()) {
				ctx.ui.notify("A branch-workspace operation is already running.", "warning");
				return;
			}
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify(`/${COMMAND_NAME} requires interactive TUI mode.`, "error");
				return;
			}
			if (process.env.HERDR_ENV !== "1") {
				ctx.ui.notify(`/${COMMAND_NAME} must run inside Herdr.`, "error");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify("Wait for the current agent turn to finish, then try again.", "warning");
				return;
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("The current Pi session is not persisted and cannot be forked.", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("Select a Pi model before creating the branch workspace.", "error");
				return;
			}

			commandRunning = true;
			const herdrBin = process.env.HERDR_BIN?.trim() || HERDR_DEFAULT_BIN;
			try {
				const git = await inspectGitContext(pi, ctx.cwd);
				await preflightHerdr(pi, herdrBin);
				const plan = await runTargetPicker(pi, ctx, git);
				if (!plan) {
					ctx.ui.notify("Branch workspace creation cancelled.", "info");
					return;
				}

				const sourceStatus = await readGitStatus(pi, git.repoRoot);
				const wipChoice = await chooseWipBehavior(ctx, sourceStatus);
				if (wipChoice === undefined) {
					ctx.ui.notify("Branch workspace creation cancelled; nothing was changed.", "info");
					return;
				}
				if (wipChoice === WipChoice.Duplicate) {
					const dirtySubmodules = await findDirtySubmodules(pi, git.repoRoot);
					if (dirtySubmodules.length > 0) {
						throw new Error(
							"Dirty or moved submodules cannot be duplicated safely: " + dirtySubmodules.join(", "),
						);
					}
				}

				let initialTargetStatus: string | undefined;
				let preferredWorkspaceId: string | undefined;
				if (plan.kind === TargetKind.ExistingWorktree) {
					initialTargetStatus = await readGitStatus(pi, plan.worktreePath);
				}
				const initialHerdrState = await getHerdrState(pi, herdrBin);
				const initialRegistration = await classifyWorktreeWorkspace(
					initialHerdrState,
					plan.worktreePath,
					git.commonDir,
					plan.isLinkedWorktree,
				);
				switch (initialRegistration.kind) {
					case WorkspaceRegistrationKind.Absent:
						break;
					case WorkspaceRegistrationKind.Registered:
						if (plan.kind !== TargetKind.ExistingWorktree) {
							throw new Error(
								`A registered Herdr worktree workspace already exists at the new target path: ${plan.worktreePath}`,
							);
						}
						preferredWorkspaceId = initialRegistration.registered!.workspaceId;
						break;
					case WorkspaceRegistrationKind.Conflict:
					case WorkspaceRegistrationKind.Ambiguous:
					case WorkspaceRegistrationKind.Invalid:
						throw registrationError(initialRegistration, plan.worktreePath);
					default:
						assertNever(initialRegistration.kind);
				}
				const preparation: TargetPreparation = {
					plan,
					preferredWorkspaceId,
					initialTargetStatus,
				};

				const confirmed = await confirmMutation(
					ctx,
					preparation,
					wipChoice,
					ctx.isProjectTrusted(),
				);
				if (!confirmed) {
					ctx.ui.notify("Branch workspace creation cancelled; nothing was changed.", "info");
					return;
				}

				await revalidateTarget(pi, git, preparation);
				const currentSourceStatus = await readGitStatus(pi, git.repoRoot);
				if (currentSourceStatus !== sourceStatus) {
					throw new Error(`Source Git status changed during setup. Run /${COMMAND_NAME} again.`);
				}

				let stash: RecoveryStash | undefined;
				if (wipChoice === WipChoice.Duplicate) {
					ctx.ui.setStatus(COMMAND_NAME, "Saving and restoring source WIP…");
					stash = await createRecoveryStash(pi, git.repoRoot, plan.worktreeName, sourceStatus);
				}

				if (plan.kind !== TargetKind.ExistingWorktree) {
					ctx.ui.setStatus(COMMAND_NAME, "Creating Git worktree…");
					try {
						await createGitWorktree(pi, git.repoRoot, plan);
					} catch (error) {
						const reconciled = await isExpectedGitWorktree(pi, git.repoRoot, plan);
						if (!reconciled) {
							const branchRetained = await localBranchExists(pi, git.repoRoot, plan.branchName);
							throw new Error(
								`${formatError(error)} Expected worktree was not verified at ${plan.worktreePath}.` +
								(branchRetained ? ` Branch ${plan.branchName} may have been retained.` : ""),
							);
						}
					}
				}

				let wipResult: WipResult;
				if (wipChoice === WipChoice.Clean) {
					wipResult = { outcome: WipOutcome.Clean };
				} else if (wipChoice === WipChoice.Skip) {
					wipResult = { outcome: WipOutcome.Skipped };
				} else if (stash) {
					ctx.ui.setStatus(COMMAND_NAME, "Duplicating WIP…");
					wipResult = await applyWipToTarget(pi, plan.worktreePath, stash);
				} else {
					throw new Error("WIP duplication was selected without a recovery stash.");
				}

				ctx.ui.setStatus(COMMAND_NAME, "Preparing Herdr destination…");
				const destination = await openHerdrDestination(
					pi,
					herdrBin,
					git,
					plan,
					preferredWorkspaceId,
				);
				const agentName = makeAgentName(plan.worktreeName);
				let startupError: string | undefined;
				let startupReconciled = false;
				let handoffError: string | undefined;

				ctx.ui.setStatus(COMMAND_NAME, "Starting forked Pi agent…");
				try {
					await startForkedAgent(
						pi,
						herdrBin,
						destination,
						sessionFile,
						agentName,
						{
							model: `${ctx.model!.provider}/${ctx.model!.id}`,
							thinkingLevel: pi.getThinkingLevel(),
							projectTrusted: ctx.isProjectTrusted(),
							sessionName: plan.worktreeName,
						},
					);
				} catch (error) {
					startupReconciled = await isAgentRunningInPane(
						pi,
						herdrBin,
						agentName,
						destination.paneId,
					);
					if (!startupReconciled) startupError = formatError(error);
				}

				if (!startupError) {
					ctx.ui.setStatus(COMMAND_NAME, "Sending handoff…");
					try {
						await sendHandoff(
							pi,
							herdrBin,
							agentName,
							buildHandoffPrompt(preparation, destination, wipChoice, wipResult, stash),
						);
					} catch (error) {
						handoffError = formatError(error);
					}
				}

				ctx.ui.setStatus(COMMAND_NAME, "Focusing new workspace/tab…");
				let focusError: string | undefined;
				try {
					await focusDestination(pi, herdrBin, destination);
				} catch (error) {
					focusError = formatError(error);
				}

				const recovery = stash
					? ` Recovery stash retained: ${stash.objectId}. Locate its selector with git stash list --grep=${shellQuote(stash.marker)} before dropping it.`
					: "";
				if (startupError) {
					ctx.ui.notify(
						`Worktree ${plan.worktreePath} and Herdr destination ${destination.workspaceId}/${destination.tabId} were prepared, but Pi failed to start: ${truncateMessage(startupError)}.${recovery}`,
						"error",
					);
					return;
				}
				if (handoffError) {
					ctx.ui.notify(
						`Pi agent ${agentName} started in ${destination.workspaceId}/${destination.tabId}, but the handoff failed: ${truncateMessage(handoffError)}.${recovery}`,
						"warning",
					);
					return;
				}

				const warnings = [
					wipResult.outcome === WipOutcome.Conflicted ? "WIP application produced conflicts." : undefined,
					wipResult.outcome === WipOutcome.Failed ? "WIP application failed and needs inspection." : undefined,
					startupReconciled ? "Agent startup returned an error, but Herdr confirmed it in the expected pane." : undefined,
					focusError ? `Destination focus failed: ${truncateMessage(focusError)}` : undefined,
				].filter(Boolean).join(" ");
				ctx.ui.notify(
					`Ready: ${plan.branchName} at ${plan.worktreePath}; Pi agent ${agentName} is in ${destination.workspaceId}/${destination.tabId}. ${warnings}${recovery}`.trim(),
					warnings ? "warning" : "info",
				);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			} finally {
				ctx.ui.setStatus(COMMAND_NAME, undefined);
				commandRunning = false;
			}
		},
	});
}
