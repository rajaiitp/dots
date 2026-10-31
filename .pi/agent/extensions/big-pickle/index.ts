import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import {
	type Api,
	type Model,
	openAICompletionsApi,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isFreeChatModel, modelDefinitions } from "./models.ts";
import {
	createRuntimeResolver,
	RUNTIME_ARGUMENTS,
	type Runtime,
} from "./runtime.ts";

// Preserve model selection in existing sessions.
const PROVIDER_ID = "opencode-pickle-temp";
const BASE_URL = "https://opencode.ai/inference/openai/v1";
const COMPLETIONS_URL = `${BASE_URL}/chat/completions`;
const PUBLIC_API_KEY = "public";
const OPENCODE_USER_AGENT =
	"opencode/1.18.29 ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.0";
const OPENCODE_INTRO =
	"You are opencode, an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.";
const REQUEST_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 1_000;
const HTTP_RETRIES = 0;
const DEFAULT_OUTPUT_TOKENS = 32_000;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 4096;
const MIN_FINAL_HTTP_STATUS = 200;
const MAX_HTTP_STATUS = 599;
const MAX_TRACKED_USER_TURNS = 256;
const NO_BODY_STATUSES = new Set([204, 205, 304]);
const SDK_HEADER_PREFIX = "x-stainless-";
const ID_ALPHABET =
	"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_RANDOM_BYTES = 14;
const ID_TIMESTAMP_BYTES = 6;
const ID_COUNTER_BITS = 12n;
let lastTimestamp = 0;
let counter = 0;

type Fetcher = NonNullable<SimpleStreamOptions["fetch"]>;
interface WorkerHandle {
	stop(): void;
	done: Promise<number | null>;
}
interface ResponseMetadata {
	status: number;
	statusText: string;
	headers: [string, string][];
}

class OpencodePayloadError extends Error {
	name = "OpencodePayloadError";
}
class OpencodeTransportError extends Error {
	name = "OpencodeTransportError";
}

const HTTP_WORKER = String.raw`
import { lookup } from "node:dns/promises";
try {
  const input = JSON.parse(await Bun.stdin.text());
  const target = new URL(input.url);
  if (target.protocol !== "https:" || target.hostname !== "opencode.ai") throw new Error("Invalid target");
  const hostname = target.hostname;
  const host = target.host;
  const { address } = await lookup(hostname, { family: 4 });
  target.hostname = address;
  const headers = new Headers(input.headers);
  for (const name of ["host", "connection", "content-length", "transfer-encoding", "accept", "accept-encoding", "accept-language", "sec-fetch-mode", "proxy-authorization", "proxy-authenticate", "upgrade", "te", "trailer"]) headers.delete(name);
  for (const name of [...headers.keys()]) if (name.startsWith("x-stainless-")) headers.delete(name);
  headers.set("host", host);
  const response = await fetch(target, {
    method: input.method,
    headers,
    body: Buffer.from(input.body, "base64"),
    tls: { serverName: hostname },
    proxy: false,
    redirect: "manual",
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  await Bun.write(Bun.stdout, JSON.stringify({ status: response.status, statusText: response.statusText, headers: [...response.headers] }) + "\n");
  if (response.body) for await (const chunk of response.body) await Bun.write(Bun.stdout, chunk);
} catch (error) {
  const name = error instanceof Error ? error.name : "Error";
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? " (" + error.code + ")" : "";
  console.error(name + code + ": direct HTTP transport failed");
  process.exitCode = 1;
}
`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nativeId(prefix: "ses" | "msg"): string {
	const timestamp = Date.now();
	counter = timestamp === lastTimestamp ? counter + 1 : 1;
	lastTimestamp = timestamp;
	const value = (BigInt(timestamp) << ID_COUNTER_BITS) + BigInt(counter);
	const ordered = prefix === "ses" ? ~value : value;
	const time = Array.from({ length: ID_TIMESTAMP_BYTES }, (_, index) =>
		Number((ordered >> BigInt(8 * (ID_TIMESTAMP_BYTES - index - 1))) & 0xffn)
			.toString(16)
			.padStart(2, "0"),
	).join("");
	const random = Array.from(
		randomBytes(ID_RANDOM_BYTES),
		(byte) => ID_ALPHABET[byte % ID_ALPHABET.length],
	).join("");
	return `${prefix}_${time}${random}`;
}

function environmentPreamble(cwd: string, modelId: string): string {
	const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const worktree = git.status === 0 ? git.stdout.trim() : undefined;
	const root = worktree || cwd;
	const repository = worktree
		? "yes"
		: git.stderr?.includes("not a git repository")
			? "no"
			: "unknown";
	return `${OPENCODE_INTRO}\n\nYou are powered by the model named ${modelId}. The exact model ID is opencode/${modelId}\nHere is some useful information about the environment you are running in:\n<env>\n  Working directory: ${cwd}\n  Workspace root folder: ${root}\n  Is directory a git repo: ${repository}\n  Platform: ${process.platform}\n  Today's date: ${new Date().toDateString()}\n</env>`;
}

function preparePayload(value: unknown, cwd: string, modelId: string): unknown {
	if (!isRecord(value) || !Array.isArray(value.messages)) {
		throw new OpencodePayloadError("Expected a chat messages array");
	}
	if (!isFreeChatModel(modelId) || value.model !== modelId)
		throw new OpencodePayloadError("Unsupported model");
	const messages: unknown[] = [...value.messages];
	const firstSystem = messages.findIndex(
		(message) => isRecord(message) && message.role === "system",
	);
	const preamble = environmentPreamble(cwd, modelId);
	if (firstSystem < 0) {
		messages.unshift({ role: "system", content: preamble });
	} else {
		const message = messages[firstSystem];
		if (!isRecord(message) || typeof message.content !== "string") {
			throw new OpencodePayloadError("Expected text system instructions");
		}
		messages[firstSystem] = {
			...message,
			content: `${preamble}\n\n${message.content}`,
		};
	}
	const result = { ...value, messages };
	if (
		Array.isArray(value.tools) &&
		value.tools.every(
			(tool) =>
				isRecord(tool) &&
				isRecord(tool.function) &&
				typeof tool.function.name === "string",
		)
	) {
		const tools = value.tools as { function: { name: string } }[];
		Object.assign(result, {
			tools: [...tools].sort((left, right) =>
				left.function.name.localeCompare(right.function.name),
			),
		});
	}
	if (
		Array.isArray(value.tools) &&
		value.tools.length &&
		value.tool_choice === undefined
	) {
		Object.assign(result, { tool_choice: "auto" });
	}
	return result;
}

function responseMetadata(buffer: Buffer): ResponseMetadata {
	let value: unknown;
	try {
		value = JSON.parse(buffer.toString("utf8"));
	} catch {
		throw new OpencodeTransportError("Invalid HTTP worker response metadata");
	}
	if (
		!isRecord(value) ||
		typeof value.status !== "number" ||
		!Number.isInteger(value.status) ||
		value.status < MIN_FINAL_HTTP_STATUS ||
		value.status > MAX_HTTP_STATUS ||
		typeof value.statusText !== "string" ||
		!Array.isArray(value.headers) ||
		!value.headers.every(
			(pair) =>
				Array.isArray(pair) &&
				pair.length === 2 &&
				pair.every((part) => typeof part === "string"),
		)
	) {
		throw new OpencodeTransportError("Invalid HTTP worker response metadata");
	}
	return value as unknown as ResponseMetadata;
}

async function directFetch(
	input: Parameters<Fetcher>[0],
	init: Parameters<Fetcher>[1],
	workers: Set<WorkerHandle>,
	timeoutMs: number,
	runtime: Runtime,
): Promise<Response> {
	const request = new Request(input, init);
	request.signal.throwIfAborted();
	if (request.url !== COMPLETIONS_URL || request.method !== "POST") {
		throw new OpencodeTransportError("Unsupported direct HTTP target");
	}
	const body = Buffer.from(await request.arrayBuffer());
	request.signal.throwIfAborted();
	const child = spawn(runtime.binary, [...RUNTIME_ARGUMENTS, HTTP_WORKER], {
		cwd: dirname(runtime.binary),
		env: runtime.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const stop = () => {
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGTERM");
	};
	let failure: Error | undefined;
	let timedOut = false;
	let stderr: Buffer = Buffer.alloc(0);
	const errorDetail = (fallback: string) =>
		failure?.message ?? (stderr.toString("utf8").trim() || fallback);
	child.on("error", (error) => {
		failure ??= error;
	});
	child.stdin.on("error", (error) => {
		failure ??= error;
		stop();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		if (stderr.length < MAX_STDERR_BYTES)
			stderr = Buffer.concat([
				stderr,
				chunk.subarray(0, MAX_STDERR_BYTES - stderr.length),
			]);
	});
	const done = new Promise<number | null>((resolve) =>
		child.once("close", resolve),
	);
	const handle = { stop, done };
	workers.add(handle);
	request.signal.addEventListener("abort", stop, { once: true });
	const deadline = setTimeout(() => {
		timedOut = true;
		stop();
	}, timeoutMs);
	deadline.unref();
	void done.then(() => {
		clearTimeout(deadline);
		workers.delete(handle);
		request.signal.removeEventListener("abort", stop);
	});
	const iterator = child.stdout[
		Symbol.asyncIterator
	]() as AsyncIterator<Buffer>;
	try {
		request.signal.throwIfAborted();
		child.stdin.end(
			JSON.stringify({
				url: request.url,
				method: request.method,
				headers: [...request.headers],
				body: body.toString("base64"),
				timeoutMs,
			}),
		);
		let buffer: Buffer = Buffer.alloc(0);
		let newline = -1;
		while (newline < 0) {
			const chunk = await iterator.next();
			if (chunk.done)
				throw new OpencodeTransportError(
					timedOut
						? "HTTP worker timed out"
						: errorDetail("HTTP worker ended before response metadata"),
				);
			buffer = Buffer.concat([buffer, chunk.value]);
			newline = buffer.indexOf("\n");
			if ((newline < 0 ? buffer.length : newline) > MAX_HEADER_BYTES) {
				throw new OpencodeTransportError(
					"HTTP worker response metadata is too large",
				);
			}
		}
		const metadata = responseMetadata(buffer.subarray(0, newline));
		const remainder = buffer.subarray(newline + 1);
		let cancelled = false;
		let firstChunk = remainder;
		const stream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					if (firstChunk.length) {
						controller.enqueue(firstChunk);
						firstChunk = Buffer.alloc(0);
						return;
					}
					const chunk = await iterator.next();
					if (cancelled) return;
					if (!chunk.done) {
						controller.enqueue(chunk.value);
						return;
					}
					const code = await done;
					if (cancelled) return;
					if (code !== 0 || failure)
						throw new OpencodeTransportError(
							timedOut
								? "HTTP worker timed out"
								: errorDetail("HTTP worker failed"),
						);
					controller.close();
				} catch (error) {
					if (!cancelled) controller.error(error);
					stop();
					await done;
				}
			},
			async cancel() {
				cancelled = true;
				stop();
				await done;
			},
		});
		if (NO_BODY_STATUSES.has(metadata.status)) {
			await stream.cancel();
			return new Response(null, metadata);
		}
		return new Response(stream, metadata);
	} catch (error) {
		stop();
		await done;
		request.signal.throwIfAborted();
		throw error;
	}
}

export default function (pi: ExtensionAPI) {
	const sessionId = nativeId("ses");
	const resolveRuntime = createRuntimeResolver();
	const workers = new Set<WorkerHandle>();
	const userTurns = new Map<string, string>();
	let cwd = process.cwd();
	pi.on("before_provider_request", (_event, context) => {
		cwd = context.cwd;
	});
	pi.on("session_shutdown", async () => {
		await Promise.all(
			[...workers].map(async (worker) => {
				worker.stop();
				await worker.done;
			}),
		);
	});
	pi.registerProvider(PROVIDER_ID, {
		name: "OpenCode Free",
		baseUrl: BASE_URL,
		apiKey: PUBLIC_API_KEY,
		api: PROVIDER_ID,
		models: modelDefinitions(),
		streamSimple(
			model: Model<Api>,
			context: TranscriptContext,
			options?: SimpleStreamOptions,
		) {
			const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
			let runtime: Runtime | undefined;
			const fetchRequest: Fetcher =
				options?.fetch ??
				((input, init) =>
					directFetch(
						input,
						init,
						workers,
						timeoutMs,
						runtime ?? resolveRuntime(options?.env),
					));
			const user = context.messages.findLast(
				(message) => message.role === "user",
			);
			let requestId: string;
			if (user) {
				const key = createHash("sha256")
					.update(
						JSON.stringify([options?.sessionId, user.timestamp, user.content]),
					)
					.digest("hex");
				const existing = userTurns.get(key);
				requestId = existing ?? nativeId("msg");
				if (!existing) {
					if (userTurns.size >= MAX_TRACKED_USER_TURNS) {
						const oldest = userTurns.keys().next().value;
						if (oldest !== undefined) userTurns.delete(oldest);
					}
					userTurns.set(key, requestId);
				}
			} else {
				requestId = nativeId("msg");
			}
			const headers = Object.fromEntries(
				Object.entries(options?.headers ?? {}).map(([key, value]) => [
					key.toLowerCase(),
					value,
				]),
			);
			return openAICompletionsApi().streamSimple(
				{
					...model,
					compat: {
						...model.compat,
						supportsStore: false,
						supportsDeveloperRole: false,
						maxTokensField: "max_tokens",
					},
				},
				context,
				{
					...options,
					apiKey: PUBLIC_API_KEY,
					maxRetries: HTTP_RETRIES,
					maxTokens:
						options?.maxTokens ??
						Math.min(model.maxTokens, DEFAULT_OUTPUT_TOKENS),
					timeoutMs,
					onPayload: async (payload, hookModel) => {
						const prepared = preparePayload(
							(await options?.onPayload?.(payload, hookModel)) ?? payload,
							cwd,
							model.id,
						);
						if (!options?.fetch) runtime = resolveRuntime(options?.env);
						return prepared;
					},
					fetch: (input, init) => {
						const requestHeaders = new Headers(
							init?.headers ??
								(input instanceof Request ? input.headers : undefined),
						);
						for (const name of [...requestHeaders.keys()])
							if (name.startsWith(SDK_HEADER_PREFIX))
								requestHeaders.delete(name);
						return fetchRequest(input, { ...init, headers: requestHeaders });
					},
					headers: {
						...headers,
						accept: null,
						authorization: `Bearer ${PUBLIC_API_KEY}`,
						"user-agent": OPENCODE_USER_AGENT,
						"x-opencode-client": "cli",
						"x-opencode-project": "global",
						"x-opencode-session": sessionId,
						"x-opencode-request": requestId,
					},
				},
			);
		},
	});
}
