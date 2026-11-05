import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
	AGENT_READY_TIMEOUT_MS,
	isRecord,
	responseRecords,
	responseString,
	type TuiosClient,
	TuiosError,
	TuiosErrorKind,
} from "./client.ts";

const MAX_SESSION_PREFIX_LENGTH = 42;
const REQUEST_ID_LENGTH = 10;

export enum DestinationKind {
	Invalid = 0,
	NewSession,
	ExistingSessionPane,
}

export enum SessionRegistrationKind {
	Invalid = 0,
	Absent,
	Registered,
	Ambiguous,
}

export type NativePane = {
	id: string;
	cwd?: string;
	workspace: number;
	name?: string;
};
export type NativeSession = {
	name: string;
	id: string;
	worktreePath?: string;
	repoRoot?: string;
	panes: NativePane[];
};
export type NativeState = { sessions: NativeSession[] };
export type NativeDestination = {
	kind: DestinationKind;
	sessionName: string;
	sessionId: string;
	cwd: string;
	paneId?: string;
	workspace?: number;
	beforePaneIds: string[];
};
export type ForkedAgentConfig = {
	model: string;
	thinkingLevel: string;
	sessionName: string;
};

async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return resolve(path);
		throw error;
	}
}

export async function getTuiosState(
	client: TuiosClient,
	signal?: AbortSignal,
): Promise<NativeState> {
	const response = await client.call("list-sessions", {}, signal);
	const sessions: NativeSession[] = [];
	for (const row of responseRecords(response, "sessions")) {
		const name = responseString(row, "name");
		let listing: Record<string, unknown>;
		try {
			listing = await client.call("list-windows", { session: name }, signal);
		} catch (error) {
			if (error instanceof TuiosError && error.code === "session_not_found")
				continue;
			throw error;
		}
		const worktree = isRecord(row.worktree) ? row.worktree : undefined;
		sessions.push({
			name,
			id: responseString(row, "id"),
			worktreePath:
				typeof worktree?.path === "string" ? worktree.path : undefined,
			repoRoot:
				typeof worktree?.repo_root === "string"
					? worktree.repo_root
					: undefined,
			panes: responseRecords(listing, "windows").map((pane) => {
				if (typeof pane.workspace !== "number")
					throw new TuiosError(
						TuiosErrorKind.Protocol,
						"tuios omitted the pane workspace.",
					);
				return {
					id: responseString(pane, "window_id"),
					cwd: typeof pane.cwd === "string" ? pane.cwd : undefined,
					workspace: pane.workspace,
					name:
						typeof pane.display_name === "string"
							? pane.display_name
							: undefined,
				};
			}),
		});
	}
	return { sessions };
}

export async function classifyWorktreeSession(
	state: NativeState,
	path: string,
) {
	const expected = await canonicalPath(path);
	const matches: NativeSession[] = [];
	for (const session of state.sessions) {
		if (session.worktreePath) {
			if ((await canonicalPath(session.worktreePath)) === expected)
				matches.push(session);
			continue;
		}
		for (const pane of session.panes) {
			if (pane.cwd && (await canonicalPath(pane.cwd)) === expected) {
				matches.push(session);
				break;
			}
		}
	}
	if (matches.length > 1)
		return {
			kind: SessionRegistrationKind.Ambiguous,
			details: matches.map((item) => item.name).join(", "),
		};
	if (matches.length === 1)
		return { kind: SessionRegistrationKind.Registered, registered: matches[0] };
	return { kind: SessionRegistrationKind.Absent };
}

export async function openTuiosDestination(
	client: TuiosClient,
	path: string,
	label: string,
	requestId = randomUUID().replaceAll("-", "").slice(0, REQUEST_ID_LENGTH),
	preferredSession?: string,
	signal?: AbortSignal,
): Promise<NativeDestination> {
	const state = await getTuiosState(client, signal);
	const registration = await classifyWorktreeSession(state, path);
	switch (registration.kind) {
		case SessionRegistrationKind.Ambiguous:
			throw new TuiosError(
				TuiosErrorKind.Validation,
				`Multiple tuios sessions use ${path}: ${registration.details}. Select one explicitly before retrying.`,
			);
		case SessionRegistrationKind.Registered: {
			const existing = registration.registered;
			if (!existing)
				throw new TuiosError(
					TuiosErrorKind.Protocol,
					"Session registration omitted its session.",
				);
			if (preferredSession && preferredSession !== existing.name)
				throw new TuiosError(
					TuiosErrorKind.Validation,
					"The selected tuios session changed during setup.",
				);
			return {
				kind: DestinationKind.ExistingSessionPane,
				sessionName: existing.name,
				sessionId: existing.id,
				cwd: path,
				beforePaneIds: existing.panes.map((pane) => pane.id),
			};
		}
		case SessionRegistrationKind.Absent: {
			if (preferredSession)
				throw new TuiosError(
					TuiosErrorKind.Validation,
					"The selected tuios session disappeared during setup.",
				);
			const prefix =
				label
					.replace(/[^A-Za-z0-9_-]+/g, "-")
					.replace(/^-+|-+$/g, "")
					.slice(0, MAX_SESSION_PREFIX_LENGTH) || "pi-handoff";
			const name = `${prefix}-${requestId}`;
			const created = await client.call(
				"new-session",
				{ name, cwd: path, window: false },
				signal,
			);
			if (responseString(created, "session") !== name)
				throw new TuiosError(
					TuiosErrorKind.Protocol,
					"tuios created a different session than requested.",
					undefined,
					created,
				);
			return {
				kind: DestinationKind.NewSession,
				sessionName: name,
				sessionId: responseString(created, "session_id"),
				cwd: path,
				beforePaneIds: [],
			};
		}
		case SessionRegistrationKind.Invalid:
			throw new TuiosError(
				TuiosErrorKind.Validation,
				"Invalid session registration.",
			);
		default: {
			const unexpected: never = registration.kind;
			throw new Error(`Unknown session registration: ${unexpected}`);
		}
	}
}

export async function startForkedAgent(
	client: TuiosClient,
	destination: NativeDestination,
	snapshot: string,
	name: string,
	config: ForkedAgentConfig,
	signal?: AbortSignal,
): Promise<NativeDestination> {
	const result = await client.call(
		"start-agent",
		{
			session: destination.sessionName,
			agent: "pi",
			args: [
				"--fork",
				snapshot,
				"--model",
				config.model,
				"--thinking",
				config.thinkingLevel,
				"--name",
				config.sessionName,
			],
			name,
			cwd: destination.cwd,
			focus: false,
			ready_timeout: AGENT_READY_TIMEOUT_MS,
			env: process.env.PATH ? { PATH: process.env.PATH } : undefined,
		},
		signal,
		AGENT_READY_TIMEOUT_MS,
	);
	const paneId = responseString(result, "window_id");
	if (result.ready !== true || result.outcome !== "ready")
		throw new TuiosError(
			TuiosErrorKind.Command,
			`Pi did not become ready in ${destination.sessionName}/${paneId}. Inspect the pane; do not relaunch blindly.`,
			undefined,
			result,
		);
	if (
		responseString(result, "session") !== destination.sessionName ||
		responseString(result, "session_id") !== destination.sessionId ||
		destination.beforePaneIds.includes(paneId)
	)
		throw new TuiosError(
			TuiosErrorKind.Protocol,
			"tuios returned an unexpected or pre-existing agent destination.",
			undefined,
			result,
		);
	const listing = await client.call(
		"list-windows",
		{ session: destination.sessionName },
		signal,
	);
	const pane = responseRecords(listing, "windows").find(
		(item) => item.window_id === paneId,
	);
	if (
		!pane ||
		typeof pane.cwd !== "string" ||
		(await canonicalPath(pane.cwd)) !==
			(await canonicalPath(destination.cwd)) ||
		typeof pane.workspace !== "number"
	)
		throw new TuiosError(
			TuiosErrorKind.Protocol,
			"The new Pi pane does not match the selected directory.",
			undefined,
			result,
		);
	return { ...destination, paneId, workspace: pane.workspace };
}

export async function submitHandoff(
	client: TuiosClient,
	destination: NativeDestination,
	text: string,
	signal?: AbortSignal,
): Promise<string> {
	if (!destination.paneId)
		throw new TuiosError(
			TuiosErrorKind.Validation,
			"The destination Pi pane has not been started.",
		);
	const result = await client.call(
		"queue-prompt",
		{ session: destination.sessionName, window: destination.paneId, text },
		signal,
	);
	return responseString(result, "id");
}

export async function focusDestination(
	client: TuiosClient,
	destination: NativeDestination,
	signal?: AbortSignal,
): Promise<void> {
	if (!destination.paneId)
		throw new TuiosError(
			TuiosErrorKind.Validation,
			"The destination pane is missing.",
		);
	await client.call(
		"focus-window",
		{ session: destination.sessionName, window: destination.paneId },
		signal,
	);
	await client.call(
		"switch-session",
		{ name: destination.sessionName },
		signal,
	);
}
