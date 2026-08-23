import { randomBytes } from "node:crypto";

export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
export const DEFAULT_CAPTURE_LINES = 10_000;
export const HYPA_AUTO_MIN_BYTES = 16 * 1024;
export const HYPA_AUTO_MIN_LINES = 300;

const BEGIN_PREFIX = "__PI_HERDR_BEGIN__";
const DONE_PREFIX = "__PI_HERDR_DONE__";

export type SupportedShell = "bash" | "zsh";
export type PaneRunState =
	| { kind: "waiting"; token: string }
	| { kind: "possibly-running"; token: string; reason: "aborted" | "timed_out" | "wait_failed" }
	| { kind: "detached" };

export interface PaneForegroundProcess {
	argv?: string[];
	cmdline?: string;
	name?: string;
	pid?: number;
}

export interface PaneProcessInfo {
	pane_id: string;
	shell_pid?: number;
	foreground_processes?: PaneForegroundProcess[];
}

export interface PaneShell {
	name: SupportedShell;
	pid?: number;
}

export interface CommandProtocol {
	token: string;
	beginMarker: string;
	donePrefix: string;
	wrappedCommand: string;
}

export interface Completion {
	exitCode: number;
	marker: string;
}

export interface ExtractedCommandOutput {
	text: string;
	beginFound: boolean;
	doneFound: boolean;
}

export class PaneRunRegistry {
	private readonly states = new Map<string, PaneRunState>();

	get(paneId: string): PaneRunState | undefined {
		return this.states.get(paneId);
	}

	reserveWaiting(paneId: string, token: string): void {
		const existing = this.states.get(paneId);
		if (existing) {
			throw new Error(describeBusyPane(paneId, existing));
		}
		this.states.set(paneId, { kind: "waiting", token });
	}

	markPossiblyRunning(paneId: string, token: string, reason: "aborted" | "timed_out" | "wait_failed"): void {
		const existing = this.states.get(paneId);
		if (existing?.kind !== "waiting" || existing.token !== token) return;
		this.states.set(paneId, { kind: "possibly-running", token, reason });
	}

	markDetached(paneId: string): void {
		const existing = this.states.get(paneId);
		if (existing) throw new Error(describeBusyPane(paneId, existing));
		this.states.set(paneId, { kind: "detached" });
	}

	clear(paneId: string): void {
		this.states.delete(paneId);
	}

	clearIfShellIsIdle(paneId: string, processInfo: PaneProcessInfo): PaneShell | undefined {
		const shell = getIdleSupportedShell(processInfo);
		if (shell) this.clear(paneId);
		return shell;
	}
}

export function createCommandProtocol(command: string, shell: SupportedShell, token = randomBytes(18).toString("base64url")): CommandProtocol {
	const beginMarker = `${BEGIN_PREFIX}:${token}`;
	const donePrefix = `${DONE_PREFIX}:${token}:`;
	return {
		token,
		beginMarker,
		donePrefix,
		wrappedCommand: buildWrappedCommand(command, shell, token),
	};
}

/**
 * The full marker is built only at runtime. Herdr's wait-output checks current
 * scrollback before waiting, so embedding it literally would match the shell's
 * echoed wrapper before the command has completed.
 */
export function buildWrappedCommand(command: string, _shell: SupportedShell, token: string): string {
	const quotedCommand = shellQuote(command);
	const quotedToken = shellQuote(token);
	return [
		"__pi_herdr_begin='__PI_HERDR_BEGIN__'",
		"__pi_herdr_done='__PI_HERDR_DONE__'",
		`__pi_herdr_token=${quotedToken}`,
		"printf '%s:%s\\n' \"$__pi_herdr_begin\" \"$__pi_herdr_token\"",
		`eval ${quotedCommand}`,
		"__pi_herdr_status=$?",
		"printf '%s:%s:%s\\n' \"$__pi_herdr_done\" \"$__pi_herdr_token\" \"$__pi_herdr_status\"",
		"unset __pi_herdr_begin __pi_herdr_done __pi_herdr_token __pi_herdr_status",
	].join("; ");
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

export function parseCompletion(text: string, token: string): Completion | undefined {
	const escapedToken = escapeRegExp(token);
	const pattern = new RegExp(`${escapeRegExp(DONE_PREFIX)}:${escapedToken}:(-?\\d+)(?:\\r?\\n|$)`);
	const match = pattern.exec(text);
	if (!match) return undefined;
	const exitCode = Number(match[1]);
	if (!Number.isSafeInteger(exitCode)) return undefined;
	return { exitCode, marker: match[0].replace(/\r?\n$/, "") };
}

export function extractCommandOutput(text: string, token: string): ExtractedCommandOutput {
	const beginMarker = `${BEGIN_PREFIX}:${token}`;
	const donePrefix = `${DONE_PREFIX}:${token}:`;
	const beginIndex = text.lastIndexOf(beginMarker);
	const doneIndex = text.indexOf(donePrefix, beginIndex >= 0 ? beginIndex + beginMarker.length : 0);
	const doneFound = doneIndex >= 0;

	if (beginIndex >= 0 && doneFound) {
		return {
			text: trimMarkerAdjacentNewline(text.slice(beginIndex + beginMarker.length, doneIndex)),
			beginFound: true,
			doneFound: true,
		};
	}

	if (doneFound) {
		const retainedTail = trimMarkerAdjacentNewline(text.slice(0, doneIndex));
		return {
			text: retainedTail
				? `[Command began before retained pane scrollback; showing available tail.]\n${retainedTail}`
				: "[Command began before retained pane scrollback; no command output remains.]",
			beginFound: false,
			doneFound: true,
		};
	}

	return { text, beginFound: beginIndex >= 0, doneFound: false };
}

export function getIdleSupportedShell(processInfo: PaneProcessInfo): PaneShell | undefined {
	const foreground = processInfo.foreground_processes ?? [];
	if (foreground.length !== 1) return undefined;
	const process = foreground[0];
	if (typeof processInfo.shell_pid === "number" && process.pid !== processInfo.shell_pid) return undefined;
	const candidate = basename(process.argv?.[0] || process.name || process.cmdline || "").toLowerCase();
	if (candidate !== "bash" && candidate !== "zsh") return undefined;
	return { name: candidate, pid: process.pid };
}

export function shouldAutoCompress(text: string): boolean {
	return Buffer.byteLength(text, "utf8") >= HYPA_AUTO_MIN_BYTES || text.split("\n").length >= HYPA_AUTO_MIN_LINES;
}

function describeBusyPane(paneId: string, state: PaneRunState): string {
	switch (state.kind) {
		case "waiting":
			return `Pane '${paneId}' already has a command waiting for completion.`;
		case "possibly-running":
			return `Pane '${paneId}' may still be running a prior command (${state.reason}). Inspect it with read, send C-c, or stop before starting another command.`;
		case "detached":
			return `Pane '${paneId}' has a detached command. Wait until its foreground process returns to the shell before starting another command.`;
	}
}

function trimMarkerAdjacentNewline(text: string): string {
	return text.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function basename(value: string): string {
	return value.replace(/\\/g, "/").split("/").pop() || "";
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
