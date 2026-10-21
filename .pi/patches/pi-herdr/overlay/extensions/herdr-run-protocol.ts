import { randomBytes } from "node:crypto";

export const DEFAULT_RUN_TIMEOUT_MS = 120_000;
export const DEFAULT_CAPTURE_LINES = 10_000;
export const HYPA_AUTO_MIN_BYTES = 16 * 1024;
export const HYPA_AUTO_MIN_LINES = 300;

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

export function createRunToken(): string {
	return randomBytes(18).toString("base64url");
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

export function stripTerminalControlSequences(text: string): string {
	return text
		.replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, "")
		.replace(/\u009D[\s\S]*?(?:\u0007|\u009C)/g, "")
		.replace(/\u001B(?:P|_|\^|X)[\s\S]*?\u001B\\/g, "")
		.replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001B[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
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

function basename(value: string): string {
	return value.replace(/\\/g, "/").split("/").pop() || "";
}
