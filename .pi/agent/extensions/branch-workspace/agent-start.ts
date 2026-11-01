import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SHELL_READY_TIMEOUT_MS = 10_000;
const SHELL_READY_RETRY_MS = 100;
const HERDR_PANE_BUSY_CODE = "agent_pane_busy";
const HERDR_START_FAILED_CODE = "agent_start_failed";

enum StartOutcome {
	Invalid = 0,
	Started,
	PaneBusy,
	CheckExisting,
	Failed,
}

export enum AgentStartErrorKind {
	Invalid = 0,
	Command,
	ShellTimeout,
}

export class AgentStartError extends Error {
	constructor(
		readonly kind: AgentStartErrorKind,
		message: string,
	) {
		super(message);
		this.name = "AgentStartError";
	}
}

type CommandResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;
type Runtime = {
	now: () => number;
	wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};
type Envelope = {
	result?: unknown;
	error?: { code?: unknown; message?: unknown };
};

const runtime: Runtime = {
	now: () => performance.now(),
	wait: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envelope(text: string): Envelope | undefined {
	try {
		const value: unknown = JSON.parse(text);
		if (!isRecord(value)) return undefined;
		return value as Envelope;
	} catch {
		return undefined;
	}
}

function startOutcome(result: CommandResult): StartOutcome {
	if (result.killed) return StartOutcome.Failed;
	const stdout = envelope(result.stdout);
	const stderr = envelope(result.stderr);
	const responses = [stdout, stderr].filter(
		(value): value is Envelope => value !== undefined,
	);
	const errors = responses.filter((value) => value.error !== undefined);
	const acknowledged = responses.some((value) => value.result !== undefined);
	if (result.code === 0 && isRecord(stdout?.result) && errors.length === 0)
		return StartOutcome.Started;
	// Only this explicit refusal guarantees that no launch command was typed.
	if (
		result.code === 1 &&
		!acknowledged &&
		errors.length > 0 &&
		errors.every((value) => value.error?.code === HERDR_PANE_BUSY_CODE)
	)
		return StartOutcome.PaneBusy;
	if (
		result.code === 1 &&
		!acknowledged &&
		errors.length > 0 &&
		errors.every((value) => value.error?.code === HERDR_START_FAILED_CODE)
	)
		return StartOutcome.CheckExisting;
	return StartOutcome.Failed;
}

async function confirmStartedAgent(
	pi: Pick<ExtensionAPI, "exec">,
	binary: string,
	args: string[],
	options: { timeout: number; signal?: AbortSignal },
): Promise<boolean> {
	const paneIndex = args.indexOf("--pane");
	const kindIndex = args.indexOf("--kind");
	const name = args[2];
	if (
		args[0] !== "agent" ||
		args[1] !== "start" ||
		!name ||
		paneIndex < 0 ||
		kindIndex < 0
	)
		return false;
	try {
		const result = await pi.exec(binary, ["agent", "get", name], options);
		if (result.code !== 0 || result.killed) return false;
		const response = envelope(result.stdout);
		if (response?.error !== undefined || !isRecord(response?.result))
			return false;
		const agent = response.result.agent;
		return (
			isRecord(agent) &&
			agent.name === name &&
			agent.pane_id === args[paneIndex + 1] &&
			agent.agent === args[kindIndex + 1] &&
			(agent.agent_status === "idle" || agent.agent_status === "done")
		);
	} catch {
		options.signal?.throwIfAborted();
		return false;
	}
}

function failureMessage(
	binary: string,
	args: string[],
	result: CommandResult,
): string {
	return `${binary} ${args.slice(0, 3).join(" ")} failed: ${(result.stderr || result.stdout || `exit ${result.code}`).trim()}`;
}

export async function runAgentStart(
	pi: Pick<ExtensionAPI, "exec">,
	binary: string,
	args: string[],
	options: { timeout: number; signal?: AbortSignal },
	clock: Runtime = runtime,
): Promise<void> {
	const deadline = clock.now() + SHELL_READY_TIMEOUT_MS;
	let lastRefusal: string | undefined;
	const timeoutError = (refusal: string) =>
		new AgentStartError(
			AgentStartErrorKind.ShellTimeout,
			`Destination shell was not available within ${SHELL_READY_TIMEOUT_MS}ms. ${refusal}`,
		);
	for (;;) {
		options.signal?.throwIfAborted();
		if (lastRefusal && clock.now() >= deadline) throw timeoutError(lastRefusal);
		const result = await pi.exec(binary, args, options);
		const outcome = startOutcome(result);
		switch (outcome) {
			case StartOutcome.Started:
				return;
			case StartOutcome.PaneBusy: {
				lastRefusal = failureMessage(binary, args, result);
				const remaining = deadline - clock.now();
				if (remaining <= 0) throw timeoutError(lastRefusal);
				await clock.wait(
					Math.min(SHELL_READY_RETRY_MS, remaining),
					options.signal,
				);
				continue;
			}
			case StartOutcome.CheckExisting:
				if (await confirmStartedAgent(pi, binary, args, options)) return;
				break;
			case StartOutcome.Failed:
				break;
			case StartOutcome.Invalid:
				throw new Error("Invalid agent-start outcome.");
			default: {
				const unexpected: never = outcome;
				throw new Error(`Unknown agent-start outcome: ${unexpected}`);
			}
		}
		throw new AgentStartError(
			AgentStartErrorKind.Command,
			failureMessage(binary, args, result),
		);
	}
}
