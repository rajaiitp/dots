import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TUIOS_BIN = "tuios";
export const COMMAND_TIMEOUT_MS = 30_000;
export const TRANSPORT_MARGIN_MS = 10_000;
export const AGENT_READY_TIMEOUT_MS = 120_000;

export enum TuiosErrorKind {
	Invalid = 0,
	Validation,
	Transport,
	Protocol,
	Daemon,
	Command,
}

export class TuiosError extends Error {
	constructor(
		readonly kind: TuiosErrorKind,
		message: string,
		readonly code?: string,
		readonly data?: Record<string, unknown>,
	) {
		super(message);
		this.name = "TuiosError";
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new TuiosError(TuiosErrorKind.Validation, `${field} is required.`);
	}
	return value;
}

export function responseString(
	data: Record<string, unknown>,
	field: string,
): string {
	if (typeof data[field] !== "string" || !data[field]) {
		throw new TuiosError(
			TuiosErrorKind.Protocol,
			`tuios omitted ${field}.`,
			undefined,
			data,
		);
	}
	return data[field];
}

export function responseRecords(
	data: Record<string, unknown>,
	field: string,
): Record<string, unknown>[] {
	const values = data[field];
	if (!Array.isArray(values) || !values.every(isRecord)) {
		throw new TuiosError(
			TuiosErrorKind.Protocol,
			`tuios returned invalid ${field}.`,
			undefined,
			data,
		);
	}
	return values;
}

export function tuiosBinary(): string {
	return process.env.TUIOS_BIN?.trim() || TUIOS_BIN;
}

export function decodeResponse(
	stdout: string,
	stderr: string,
	exitCode: number,
	killed = false,
): Record<string, unknown> {
	if (killed) {
		throw new TuiosError(
			TuiosErrorKind.Transport,
			"tuios timed out; the operation may still be running. Do not retry a write blindly.",
		);
	}
	let data: unknown;
	try {
		data = JSON.parse(stdout || stderr);
	} catch {
		throw new TuiosError(
			TuiosErrorKind.Protocol,
			`Invalid tuios JSON: ${(stderr || stdout || `exit ${exitCode}`).trim()}`,
		);
	}
	if (!isRecord(data)) {
		throw new TuiosError(
			TuiosErrorKind.Protocol,
			"tuios returned a non-object response.",
		);
	}
	if (isRecord(data.error)) {
		const code =
			typeof data.error.code === "string" ? data.error.code : undefined;
		const message =
			typeof data.error.message === "string"
				? data.error.message
				: "tuios rejected the operation.";
		throw new TuiosError(
			code === "transport" ? TuiosErrorKind.Transport : TuiosErrorKind.Daemon,
			message,
			code,
			data,
		);
	}
	if (exitCode !== 0) {
		throw new TuiosError(
			TuiosErrorKind.Command,
			`tuios exited ${exitCode}: ${(stderr || stdout).trim()}`,
			undefined,
			data,
		);
	}
	return data;
}

export class TuiosClient {
	constructor(
		private readonly pi: Pick<ExtensionAPI, "exec">,
		readonly binary = tuiosBinary(),
	) {}

	async call(
		verb: string,
		params: Record<string, unknown> = {},
		signal?: AbortSignal,
		timeout = COMMAND_TIMEOUT_MS,
	): Promise<Record<string, unknown>> {
		signal?.throwIfAborted();
		let result: Awaited<ReturnType<ExtensionAPI["exec"]>>;
		try {
			result = await this.pi.exec(
				this.binary,
				[
					"call",
					verb,
					JSON.stringify(params),
					"--json",
					"--timeout",
					`${timeout + TRANSPORT_MARGIN_MS}ms`,
				],
				{
					signal,
					timeout: timeout + 2 * TRANSPORT_MARGIN_MS,
				},
			);
		} catch (error) {
			signal?.throwIfAborted();
			throw new TuiosError(
				TuiosErrorKind.Transport,
				error instanceof Error ? error.message : String(error),
			);
		}
		return decodeResponse(
			result.stdout,
			result.stderr,
			result.code,
			result.killed,
		);
	}
}
