import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import {
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	type SelectItem,
	SelectList,
	Text,
} from "@earendil-works/pi-tui";
import {
	registerDirectoryHandoff,
	resolveHandoffDirectory,
} from "./branch-workspace/handoff.ts";
import { TuiosClient, tuiosBinary } from "./tuios/client.ts";
import {
	classifyWorktreeSession,
	DestinationKind,
	focusDestination as focusTuiosDestination,
	startForkedAgent as launchForkedAgent,
	type NativeDestination,
	openTuiosDestination as prepareTuiosDestination,
	getTuiosState as readTuiosState,
	SessionRegistrationKind,
	submitHandoff,
} from "./tuios/runtime.ts";

const COMMAND_NAME = "branch-workspace";

const GIT_BIN = "git";
const EXTERNAL_COMMAND_TIMEOUT_MS = 30_000;
const WORKTREE_CREATE_TIMEOUT_MS = 120_000;
const REMOTE_FETCH_TIMEOUT_MS = 180_000;
const MAX_AGENT_NAME_LENGTH = 32;
const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

export type AutomatedHandoffToolInput = { worktree: string; task: string };

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

export { DestinationKind, SessionRegistrationKind } from "./tuios/runtime.ts";

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
	preferredSessionName?: string;
	initialTargetStatus?: string;
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

export function isPathContained(
	parentPath: string,
	childPath: string,
): boolean {
	const pathFromParent = relative(resolve(parentPath), resolve(childPath));
	return (
		pathFromParent.length > 0 &&
		pathFromParent !== ".." &&
		!pathFromParent.startsWith(
			`..${process.platform === "win32" ? "\\" : "/"}`,
		) &&
		!isAbsolute(pathFromParent)
	);
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function truncateMessage(value: string, maxLength = 1_000): string {
	const trimmed = value.trim();
	return trimmed.length <= maxLength
		? trimmed
		: `${trimmed.slice(0, maxLength)}…`;
}

function commandFailure(
	command: string,
	args: string[],
	result: CommandResult,
): Error {
	const detail = truncateMessage(
		result.stderr || result.stdout || `exit code ${result.code}`,
	);
	return new Error(
		`${command} ${args.slice(0, 3).join(" ")} failed: ${detail}`,
	);
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
	const rootResult = await runChecked(
		pi,
		GIT_BIN,
		["rev-parse", "--show-toplevel"],
		{
			cwd,
			signal,
		},
	);
	const repoRoot = await realpath(rootResult.stdout.trim());
	const commonDirResult = await runChecked(
		pi,
		GIT_BIN,
		["rev-parse", "--git-common-dir"],
		{
			cwd: repoRoot,
			signal,
		},
	);
	const rawCommonDir = commonDirResult.stdout.trim();
	const commonDir = await realpath(resolve(repoRoot, rawCommonDir));
	const repoName =
		basename(commonDir) === ".git"
			? basename(dirname(commonDir))
			: basename(commonDir);
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

	const branchResult = await runCommand(
		pi,
		GIT_BIN,
		["symbolic-ref", "--quiet", "--short", "HEAD"],
		{
			cwd: repoRoot,
			signal,
		},
	);
	const currentRef =
		branchResult.code === 0 ? branchResult.stdout.trim() : "HEAD";

	await runChecked(pi, GIT_BIN, ["rev-parse", "--verify", "HEAD^{commit}"], {
		cwd: repoRoot,
		signal,
	});
	return { repoRoot, primaryWorktreePath, repoName, commonDir, currentRef };
}

async function resolveCommit(
	pi: ExtensionAPI,
	repoRoot: string,
	ref: string,
): Promise<string> {
	const result = await runChecked(
		pi,
		GIT_BIN,
		["rev-parse", "--verify", `${ref}^{commit}`],
		{
			cwd: repoRoot,
		},
	);
	return result.stdout.trim();
}

async function localBranchExists(
	pi: ExtensionAPI,
	repoRoot: string,
	branch: string,
): Promise<boolean> {
	const result = await runCommand(
		pi,
		GIT_BIN,
		["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
		{
			cwd: repoRoot,
		},
	);
	if (result.code === 0) return true;
	if (result.code === 1) return false;
	throw commandFailure(
		GIT_BIN,
		["show-ref", "--verify", `refs/heads/${branch}`],
		result,
	);
}

async function validateNewBranch(
	pi: ExtensionAPI,
	repoRoot: string,
	branch: string,
): Promise<void> {
	await runChecked(pi, GIT_BIN, ["check-ref-format", "--branch", branch], {
		cwd: repoRoot,
	});
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
		throw new Error(
			"The derived worktree path is not safely contained by its parent directory.",
		);
	}
	if (await pathExists(worktreePath)) {
		throw new Error(`Worktree path already exists: ${worktreePath}`);
	}

	const listResult = await runChecked(
		pi,
		GIT_BIN,
		["worktree", "list", "--porcelain", "-z"],
		{ cwd: repoRoot },
	);
	const registered = parseGitWorktrees(listResult.stdout).some(
		(worktree) => resolve(worktree.path) === resolve(worktreePath),
	);
	if (registered) {
		throw new Error(
			`Git already has a worktree registered at: ${worktreePath}`,
		);
	}
}

async function isUsableRepositoryWorktree(
	pi: ExtensionAPI,
	git: GitContext,
	worktree: GitWorktree,
	signal?: AbortSignal,
): Promise<boolean> {
	if (
		!worktree.branchRef ||
		worktree.prunable ||
		!(await pathExists(worktree.path))
	)
		return false;
	try {
		const commonResult = await runChecked(
			pi,
			GIT_BIN,
			["rev-parse", "--git-common-dir"],
			{
				cwd: worktree.path,
				signal,
			},
		);
		const commonDir = await realpath(
			resolve(worktree.path, commonResult.stdout.trim()),
		);
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
			[
				"for-each-ref",
				"--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(worktreepath)%00",
				"refs/heads",
			],
			{ cwd: git.repoRoot, signal },
		),
		runChecked(
			pi,
			GIT_BIN,
			[
				"for-each-ref",
				"--format=%(refname)%00%(refname:short)%00%(objectname)%00%(symref)%00",
				"refs/remotes",
			],
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
		if (await isUsableRepositoryWorktree(pi, git, worktree, signal))
			usableWorktrees.push(worktree);
	}
	const worktreeByBranch = new Map(
		usableWorktrees.flatMap((worktree) =>
			worktree.branchRef ? [[worktree.branchRef, worktree.path] as const] : [],
		),
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

	const selectedValue = await ctx.ui.custom<string | null>(
		(tui, theme, keybindings, done) => {
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
				container.addChild(
					new DynamicBorder((text: string) => theme.fg("accent", text)),
				);
				container.addChild(
					new Text(theme.fg("accent", theme.bold(title)), 1, 0),
				);
				container.addChild(
					new Text(theme.fg("dim", "Type to fuzzy-filter"), 1, 0),
				);
				container.addChild(input);
				container.addChild(selectList);
				container.addChild(
					new Text(
						theme.fg("dim", "↑↓ navigate • enter select • esc cancel"),
						1,
						0,
					),
				);
				container.addChild(
					new DynamicBorder((text: string) => theme.fg("accent", text)),
				);
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
		},
	);

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
		const entered = await ctx.ui.input(
			"Worktree and tuios session name",
			suggestedName,
		);
		if (entered === undefined) return undefined;
		const worktreeName = entered.trim() || suggestedName;
		if (!isValidWorktreeName(worktreeName)) {
			ctx.ui.notify(
				"Use one path segment containing only letters, numbers, dots, underscores, or hyphens.",
				"warning",
			);
			continue;
		}
		const worktreePath = join(
			homedir(),
			".worktrees",
			git.repoName,
			worktreeName,
		);
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
	const tracked = new Set(
		catalog.locals.map((branch) => branch.upstream).filter(Boolean),
	);
	return catalog.remotes.filter((branch) => !tracked.has(branch.shortName));
}

function reusableWorktrees(
	catalog: BranchCatalog,
	git: GitContext,
): GitWorktree[] {
	return catalog.worktrees.filter(
		(worktree) =>
			resolve(worktree.path) !== resolve(git.repoRoot) &&
			Boolean(worktree.branchRef),
	);
}

export async function resolveAutomatedWorktreeTarget(
	pi: ExtensionAPI,
	_git: GitContext,
	cwd: string,
	selectorInput: string,
	signal?: AbortSignal,
): Promise<ExistingWorktreeTarget> {
	const target = await resolveHandoffDirectory(pi, cwd, selectorInput, signal);
	if (!target.git || !target.commit) {
		throw new Error(
			"This Git worktree resolver requires a checkout with a commit; directory handoff does not.",
		);
	}
	const checkoutPath = target.git.repoRoot;
	const worktree = {
		path: checkoutPath,
		head: target.commit,
		branchRef: target.branchRef,
		locked: false,
		prunable: false,
	};
	return {
		kind: TargetKind.ExistingWorktree,
		branchName: target.git.currentRef,
		branchRef: target.branchRef ?? "HEAD",
		expectedCommit: target.commit,
		sourceLabel: `handoff to ${checkoutPath}`,
		worktreeName: existingWorktreeName(target.git, worktree),
		worktreePath: checkoutPath,
		isLinkedWorktree: checkoutPath !== target.git.primaryWorktreePath,
	};
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

	const branchName = await promptNewBranchName(
		pi,
		ctx,
		git.repoRoot,
		"feature/my-branch",
	);
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
		(item) =>
			`${item.shortName}  [${item.commit.slice(0, 10)}${item.upstream ? `, ↑ ${item.upstream}` : ""}]`,
	);
	if (!branch) return undefined;
	const destination = await promptWorktreeDestination(
		pi,
		ctx,
		git,
		branch.shortName,
	);
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
	const suggestedLocal =
		separator >= 0 ? remote.shortName.slice(separator + 1) : remote.shortName;
	const branchName = await promptNewBranchName(
		pi,
		ctx,
		git.repoRoot,
		suggestedLocal,
		suggestedLocal,
	);
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
		(item) =>
			`${item.branchRef?.replace(/^refs\/heads\//, "")}  [${item.path}]`,
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
		isLinkedWorktree:
			resolve(worktree.path) !== resolve(git.primaryWorktreePath),
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
			...(locals.length > 0
				? [`${PICKER_LABEL.LOCAL_BRANCH} (${locals.length})`]
				: []),
			...(remotes.length > 0
				? [`${PICKER_LABEL.REMOTE_BRANCH} (${remotes.length})`]
				: []),
			...(worktrees.length > 0
				? [`${PICKER_LABEL.EXISTING_WORKTREE} (${worktrees.length})`]
				: []),
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
			const fetch = await runCommand(
				pi,
				GIT_BIN,
				["fetch", "--all", "--prune"],
				{
					cwd: git.repoRoot,
					timeout: REMOTE_FETCH_TIMEOUT_MS,
				},
			);
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

async function readGitStatus(
	pi: ExtensionAPI,
	repoRoot: string,
): Promise<string> {
	const result = await runChecked(
		pi,
		GIT_BIN,
		[
			"status",
			"--porcelain=v1",
			"-z",
			"--untracked-files=all",
			"--ignore-submodules=none",
		],
		{ cwd: repoRoot },
	);
	return result.stdout;
}

function countStatusEntries(status: string): number {
	return status.split("\0").filter(Boolean).length;
}

async function findDirtySubmodules(
	pi: ExtensionAPI,
	repoRoot: string,
): Promise<string[]> {
	const stateResult = await runChecked(
		pi,
		GIT_BIN,
		["submodule", "status", "--recursive"],
		{
			cwd: repoRoot,
		},
	);
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
	const dirtyWorktrees = workResult.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
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
	return selected === WIP_LABEL.DUPLICATE
		? WipChoice.Duplicate
		: WipChoice.Skip;
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
): Promise<boolean> {
	const { plan, preferredSessionName, initialTargetStatus } = preparation;
	const destination = preferredSessionName
		? `Open a new Pi pane in tuios session ${preferredSessionName}.`
		: "Create a detached tuios session in the target worktree.";
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
			"The new Pi process will use the destination's project-trust policy.",
		]
			.filter(Boolean)
			.join("\n"),
	);
}

async function createRecoveryStash(
	pi: ExtensionAPI,
	repoRoot: string,
	worktreeName: string,
	originalStatus: string,
): Promise<RecoveryStash> {
	const marker = `pi-${COMMAND_NAME}:${worktreeName}:${Date.now()}`;
	await runChecked(
		pi,
		GIT_BIN,
		["stash", "push", "--include-untracked", "--message", marker],
		{
			cwd: repoRoot,
		},
	);
	const stashResult = await runChecked(
		pi,
		GIT_BIN,
		["rev-parse", "--verify", "refs/stash^{commit}"],
		{
			cwd: repoRoot,
		},
	);
	const objectId = stashResult.stdout.trim();
	const subjectResult = await runChecked(
		pi,
		GIT_BIN,
		["log", "-1", "--format=%s", objectId],
		{
			cwd: repoRoot,
		},
	);
	if (!subjectResult.stdout.includes(marker)) {
		throw new Error(
			"Could not verify the recovery stash created for this operation.",
		);
	}

	const restoreResult = await runCommand(
		pi,
		GIT_BIN,
		["stash", "apply", "--index", objectId],
		{
			cwd: repoRoot,
		},
	);
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

async function preflightTuios(client: TuiosClient): Promise<void> {
	await client.call("session-info", { session: process.env.TUIOS_SESSION });
}

async function revalidateTarget(
	pi: ExtensionAPI,
	git: GitContext,
	preparation: TargetPreparation,
): Promise<void> {
	const { plan, initialTargetStatus } = preparation;
	switch (plan.kind) {
		case TargetKind.NewBranch:
			if (
				(await resolveCommit(pi, git.repoRoot, plan.baseRef)) !==
				plan.expectedCommit
			) {
				throw new Error(`Base ref moved: ${plan.baseRef}`);
			}
			await validateNewBranch(pi, git.repoRoot, plan.branchName);
			await validateWorktreePath(pi, git.repoRoot, plan.worktreePath);
			return;
		case TargetKind.ExistingLocalBranch: {
			if (
				(await resolveCommit(pi, git.repoRoot, plan.branchRef)) !==
				plan.expectedCommit
			) {
				throw new Error(`Local branch moved: ${plan.branchName}`);
			}
			const catalog = await discoverBranchCatalog(pi, git);
			const branch = catalog.locals.find(
				(item) => item.fullRef === plan.branchRef,
			);
			if (!branch || branch.worktreePath) {
				throw new Error(
					`Local branch is no longer available for a new worktree: ${plan.branchName}`,
				);
			}
			await validateWorktreePath(pi, git.repoRoot, plan.worktreePath);
			return;
		}
		case TargetKind.RemoteTrackingBranch:
			if (
				(await resolveCommit(pi, git.repoRoot, plan.remoteRef)) !==
				plan.expectedCommit
			) {
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
			if (
				!worktree ||
				worktree.branchRef !== plan.branchRef ||
				worktree.head !== plan.expectedCommit
			) {
				throw new Error(
					`Existing worktree changed during setup: ${plan.worktreePath}`,
				);
			}
			const currentStatus = await readGitStatus(pi, plan.worktreePath);
			if (currentStatus !== (initialTargetStatus ?? "")) {
				throw new Error(
					`Existing worktree status changed during setup: ${plan.worktreePath}`,
				);
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
			args = [
				"worktree",
				"add",
				"-b",
				plan.branchName,
				plan.worktreePath,
				plan.expectedCommit,
			];
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
	await runChecked(pi, GIT_BIN, args, {
		cwd: repoRoot,
		timeout: WORKTREE_CREATE_TIMEOUT_MS,
	});
}

async function isExpectedGitWorktree(
	pi: ExtensionAPI,
	repoRoot: string,
	plan: TargetPlan,
): Promise<boolean> {
	try {
		const result = await runChecked(
			pi,
			GIT_BIN,
			["worktree", "list", "--porcelain", "-z"],
			{
				cwd: repoRoot,
			},
		);
		const worktree = parseGitWorktrees(result.stdout).find(
			(item) => resolve(item.path) === resolve(plan.worktreePath),
		);
		if (
			!worktree ||
			worktree.branchRef !== plan.branchRef ||
			worktree.head !== plan.expectedCommit
		)
			return false;
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
	const result = await runCommand(
		pi,
		GIT_BIN,
		["stash", "apply", "--index", stash.objectId],
		{
			cwd: worktreePath,
		},
	);
	if (result.code === 0 && !result.killed)
		return { outcome: WipOutcome.Applied };

	let conflicted = false;
	try {
		const conflicts = await runChecked(
			pi,
			GIT_BIN,
			["diff", "--name-only", "--diff-filter=U"],
			{
				cwd: worktreePath,
			},
		);
		conflicted = Boolean(conflicts.stdout.trim());
	} catch {
		// Preserve the original apply failure as the primary diagnostic.
	}
	return {
		outcome: conflicted ? WipOutcome.Conflicted : WipOutcome.Failed,
		details: truncateMessage(
			result.stderr || result.stdout || "git stash apply failed",
		),
	};
}

export function makeAgentName(worktreeName: string): string {
	const suffix = Date.now().toString(36).slice(-5);
	const base = `bw-${worktreeName.toLowerCase()}`
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-");
	const maxBaseLength = MAX_AGENT_NAME_LENGTH - suffix.length - 1;
	return `${base.slice(0, maxBaseLength).replace(/[-_]$/g, "")}-${suffix}`;
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
	destination: NativeDestination,
	wipChoice: WipChoice,
	wipResult: WipResult,
	stash: RecoveryStash | undefined,
): string {
	const { plan, initialTargetStatus } = preparation;
	const destinationText =
		destination.kind === DestinationKind.NewSession
			? "a new tuios session in the target worktree"
			: "a new Pi pane in the worktree's existing tuios session";
	return [
		`Handoff notice: this Pi session was forked into ${destinationText}.`,
		`Target mode: ${targetKindLabel(plan)}`,
		`Source: ${plan.sourceLabel}`,
		`Expected starting commit: ${plan.expectedCommit}`,
		`Current branch: ${plan.branchName}`,
		`Worktree path: ${plan.worktreePath}`,
		`tuios session/pane: ${destination.sessionName} / ${destination.paneId}`,
		initialTargetStatus
			? `The reused target already had ${countStatusEntries(initialTargetStatus)} changed path(s) before this handoff.`
			: "The target had no pre-existing reported changes.",
		wipResultDescription(wipChoice, wipResult, stash),
		"Continue the current task in this workspace.",
	].join("\n");
}

export default function branchWorkspaceExtension(pi: ExtensionAPI) {
	let commandRunning = false;
	registerDirectoryHandoff(pi);

	pi.registerCommand(COMMAND_NAME, {
		description:
			"Fork this Pi session into a Git worktree and native tuios session",
		handler: async (_args, ctx) => {
			if (commandRunning) {
				ctx.ui.notify(
					"A branch-workspace operation is already running.",
					"warning",
				);
				return;
			}
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify(
					`/${COMMAND_NAME} requires interactive TUI mode.`,
					"error",
				);
				return;
			}
			if (process.env.TUIOS_ENV !== "1") {
				ctx.ui.notify(`/${COMMAND_NAME} must run inside tuios.`, "error");
				return;
			}
			if (!ctx.isIdle()) {
				ctx.ui.notify(
					"Wait for the current agent turn to finish, then try again.",
					"warning",
				);
				return;
			}

			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify(
					"The current Pi session is not persisted and cannot be forked.",
					"error",
				);
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify(
					"Select a Pi model before creating the branch workspace.",
					"error",
				);
				return;
			}

			commandRunning = true;
			const client = new TuiosClient(pi, tuiosBinary());
			try {
				const git = await inspectGitContext(pi, ctx.cwd);
				await preflightTuios(client);
				const plan = await runTargetPicker(pi, ctx, git);
				if (!plan) {
					ctx.ui.notify("Branch workspace creation cancelled.", "info");
					return;
				}

				const sourceStatus = await readGitStatus(pi, git.repoRoot);
				const wipChoice = await chooseWipBehavior(ctx, sourceStatus);
				if (wipChoice === undefined) {
					ctx.ui.notify(
						"Branch workspace creation cancelled; nothing was changed.",
						"info",
					);
					return;
				}
				if (wipChoice === WipChoice.Duplicate) {
					const dirtySubmodules = await findDirtySubmodules(pi, git.repoRoot);
					if (dirtySubmodules.length > 0) {
						throw new Error(
							"Dirty or moved submodules cannot be duplicated safely: " +
								dirtySubmodules.join(", "),
						);
					}
				}

				let initialTargetStatus: string | undefined;
				let preferredSessionName: string | undefined;
				if (plan.kind === TargetKind.ExistingWorktree) {
					initialTargetStatus = await readGitStatus(pi, plan.worktreePath);
				}
				const initialRegistration = await classifyWorktreeSession(
					await readTuiosState(client),
					plan.worktreePath,
				);
				switch (initialRegistration.kind) {
					case SessionRegistrationKind.Absent:
						break;
					case SessionRegistrationKind.Registered:
						if (plan.kind !== TargetKind.ExistingWorktree)
							throw new Error(
								`A tuios session already uses the new target path: ${plan.worktreePath}`,
							);
						preferredSessionName = initialRegistration.registered?.name;
						break;
					case SessionRegistrationKind.Ambiguous:
						throw new Error(
							`Multiple tuios sessions use ${plan.worktreePath}: ${initialRegistration.details}`,
						);
					case SessionRegistrationKind.Invalid:
						throw new Error("Invalid session registration.");
					default:
						assertNever(initialRegistration.kind);
				}
				const preparation: TargetPreparation = {
					plan,
					preferredSessionName,
					initialTargetStatus,
				};

				const confirmed = await confirmMutation(ctx, preparation, wipChoice);
				if (!confirmed) {
					ctx.ui.notify(
						"Branch workspace creation cancelled; nothing was changed.",
						"info",
					);
					return;
				}

				await revalidateTarget(pi, git, preparation);
				const currentSourceStatus = await readGitStatus(pi, git.repoRoot);
				if (currentSourceStatus !== sourceStatus) {
					throw new Error(
						`Source Git status changed during setup. Run /${COMMAND_NAME} again.`,
					);
				}

				let stash: RecoveryStash | undefined;
				if (wipChoice === WipChoice.Duplicate) {
					ctx.ui.setStatus(COMMAND_NAME, "Saving and restoring source WIP…");
					stash = await createRecoveryStash(
						pi,
						git.repoRoot,
						plan.worktreeName,
						sourceStatus,
					);
				}

				if (plan.kind !== TargetKind.ExistingWorktree) {
					ctx.ui.setStatus(COMMAND_NAME, "Creating Git worktree…");
					try {
						await createGitWorktree(pi, git.repoRoot, plan);
					} catch (error) {
						const reconciled = await isExpectedGitWorktree(
							pi,
							git.repoRoot,
							plan,
						);
						if (!reconciled) {
							const branchRetained = await localBranchExists(
								pi,
								git.repoRoot,
								plan.branchName,
							);
							throw new Error(
								`${formatError(error)} Expected worktree was not verified at ${plan.worktreePath}.` +
									(branchRetained
										? ` Branch ${plan.branchName} may have been retained.`
										: ""),
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
					throw new Error(
						"WIP duplication was selected without a recovery stash.",
					);
				}

				ctx.ui.setStatus(COMMAND_NAME, "Preparing tuios destination…");
				let destination = await prepareTuiosDestination(
					client,
					plan.worktreePath,
					plan.worktreeName,
					undefined,
					preferredSessionName,
				);
				const agentName = makeAgentName(plan.worktreeName);
				const recovery = stash
					? ` Recovery stash retained: ${stash.objectId}. Locate it with git stash list --grep=${shellQuote(stash.marker)}.`
					: "";
				ctx.ui.setStatus(COMMAND_NAME, "Starting forked Pi agent…");
				try {
					const model = ctx.model;
					if (!model) throw new Error("No active Pi model is selected.");
					destination = await launchForkedAgent(
						client,
						destination,
						sessionFile,
						agentName,
						{
							model: `${model.provider}/${model.id}`,
							thinkingLevel: pi.getThinkingLevel(),
							sessionName: plan.worktreeName,
						},
					);
				} catch (error) {
					ctx.ui.notify(
						`Worktree ${plan.worktreePath} and tuios session ${destination.sessionName} remain, but Pi startup was not confirmed: ${formatError(error)}. Inspect the destination before retrying.${recovery}`,
						"error",
					);
					return;
				}
				ctx.ui.setStatus(COMMAND_NAME, "Submitting handoff…");
				try {
					await submitHandoff(
						client,
						destination,
						buildHandoffPrompt(
							preparation,
							destination,
							wipChoice,
							wipResult,
							stash,
						),
					);
				} catch (error) {
					ctx.ui.notify(
						`Pi is in ${destination.sessionName}/${destination.paneId}, but handoff submission was not confirmed: ${formatError(error)}. Do not resubmit blindly.${recovery}`,
						"error",
					);
					return;
				}
				let focusError: string | undefined;
				try {
					await focusTuiosDestination(client, destination);
				} catch (error) {
					focusError = formatError(error);
				}
				const warnings = [
					wipResult.outcome === WipOutcome.Conflicted
						? "WIP application produced conflicts."
						: undefined,
					wipResult.outcome === WipOutcome.Failed
						? "WIP application failed and needs inspection."
						: undefined,
					focusError ? `Destination focus failed: ${focusError}` : undefined,
				]
					.filter(Boolean)
					.join(" ");
				ctx.ui.notify(
					`Ready: ${plan.branchName} at ${plan.worktreePath}; Pi is in ${destination.sessionName}/${destination.paneId}. ${warnings}${recovery}`.trim(),
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
