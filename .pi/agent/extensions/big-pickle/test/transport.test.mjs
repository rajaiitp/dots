import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { loadProvider } from "./host.mjs";

const Scenario = Object.freeze({
	Success: Symbol("success"),
	Large: Symbol("large"),
	Limit: Symbol("limit"),
	NoContent: Symbol("no content"),
	BodyHang: Symbol("body hang"),
	HeaderHang: Symbol("header hang"),
	Failure: Symbol("failure"),
	Invalid: Symbol("invalid"),
	Oversized: Symbol("oversized"),
});
const PROXY_NAMES = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
];
function sse(text) {
	return (
		`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n` +
		`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`
	);
}

test("direct transport streams bytes and cleans up every success, error and cancellation path", async () => {
	const originalSpawn = childProcess.spawn;
	const originalSpawnSync = childProcess.spawnSync;
	const proxyState = Object.fromEntries(
		PROXY_NAMES.map((name) => [name, process.env[name]]),
	);
	for (const name of PROXY_NAMES) delete process.env[name];
	const directory = mkdtempSync(join(tmpdir(), "big-pickle-transport-"));
	const binary = join(directory, "bun");
	writeFileSync(binary, "fixture", { mode: 0o700 });
	const runtimeEnv = { PI_BIG_PICKLE_RUNTIME: binary };
	let scenario = Scenario.Success;
	const calls = [];
	const alive = new Set();
	let responseHook;
	childProcess.spawnSync = (command, args, options) => {
		if (command === binary) {
			assert.ok(args.includes("--eval"));
			assert.ok(args.at(-1).includes("Bun.version"));
			return { status: 0, stdout: "1.4.0", stderr: "" };
		}
		return originalSpawnSync(command, args, options);
	};
	childProcess.spawn = (command, args, options) => {
		assert.equal(command, binary);
		assert.equal(options.env.BUN_BE_BUN, "1");
		assert.equal(options.cwd, directory);
		assert.ok(
			args.includes("--no-env-file") &&
				args.includes("--no-install") &&
				args.includes("--config=/dev/null"),
		);
		assert.equal(args.includes("run"), false);
		assert.equal(options.env.NODE_OPTIONS, undefined);
		assert.ok(args.at(-1).includes("serverName: hostname"));
		assert.ok(!args.at(-1).includes("rejectUnauthorized: false"));
		const current = scenario;
		const child = new EventEmitter();
		child.exitCode = null;
		child.signalCode = null;
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		alive.add(child);
		const close = (code, signal = null) => {
			if (!alive.delete(child)) return;
			child.exitCode = code;
			child.signalCode = signal;
			child.stdout.end();
			child.stderr.end();
			queueMicrotask(() => child.emit("close", code, signal));
		};
		child.kill = (signal) => {
			close(null, signal);
			return true;
		};
		let input = "";
		child.stdin = new Writable({
			write(chunk, _encoding, callback) {
				input += chunk.toString();
				callback();
			},
			final(callback) {
				calls.push(JSON.parse(input));
				callback();
				switch (current) {
					case Scenario.HeaderHang:
						return;
					case Scenario.Failure:
						child.stderr.write("Synthetic transport failure");
						close(1);
						return;
					case Scenario.Invalid:
						child.stdout.write("not json\n");
						close(0);
						return;
					case Scenario.Oversized:
						child.stdout.write("x".repeat(65537));
						close(0);
						return;
					case Scenario.Success:
					case Scenario.Large:
					case Scenario.Limit:
					case Scenario.NoContent:
					case Scenario.BodyHang:
						break;
					default:
						throw new Error("Unknown test scenario");
				}
				const status =
					current === Scenario.Limit
						? 429
						: current === Scenario.NoContent
							? 204
							: 200;
				const headers = `${JSON.stringify({ status, statusText: "Fixture", headers: [["content-type", status === 429 ? "application/json" : "text/event-stream"]] })}\n`;
				child.stdout.write(headers.slice(0, 7));
				const body =
					current === Scenario.BodyHang || status === 204
						? ""
						: status === 429
							? '{"error":{"message":"Fixture limit"}}'
							: sse(current === Scenario.Large ? "x".repeat(70000) : "OK");
				child.stdout.write(headers.slice(7) + body);
				if (current !== Scenario.BodyHang) close(0);
			},
		});
		return child;
	};
	syncBuiltinESMExports();
	try {
		const { config, model, handlers } = await loadProvider();
		const context = {
			messages: [
				{ role: "system", content: "Worker policy sentinel", timestamp: 0 },
				{ role: "user", content: "Reply OK", timestamp: 1 },
			],
		};
		const invoke = async (name, options = {}) => {
			scenario = name;
			const result = await config
				.streamSimple(model, context, {
					maxTokens: 32,
					timeoutMs: 2000,
					env: runtimeEnv,
					onResponse: async (response) => {
						responseHook = response;
					},
					...options,
				})
				.result();
			await new Promise(setImmediate);
			assert.equal(alive.size, 0, `Leaked ${String(name)} worker`);
			return result;
		};
		const first = await invoke(Scenario.Success);
		assert.equal(first.stopReason, "stop", first.errorMessage);
		assert.equal(first.api, model.api);
		assert.equal(first.content[0].text, "OK");
		assert.equal(responseHook.status, 200);
		const packet = calls.at(-1);
		assert.equal(
			packet.url,
			"https://opencode.ai/inference/openai/v1/chat/completions",
		);
		const body = JSON.parse(
			Buffer.from(packet.body, "base64").toString("utf8"),
		);
		assert.ok(body.messages[0].content.includes("Worker policy sentinel"));
		assert.ok(body.messages[0].content.includes("<env>"));
		assert.equal(
			new Headers(packet.headers).get("authorization"),
			"Bearer public",
		);
		const large = await invoke(Scenario.Large);
		assert.equal(large.stopReason, "stop", large.errorMessage);
		assert.equal(large.content[0].text.length, 70000);
		for (const name of [
			Scenario.Invalid,
			Scenario.Oversized,
			Scenario.Failure,
			Scenario.NoContent,
		]) {
			assert.equal(
				(await invoke(name)).stopReason,
				"error",
				`${String(name)} was accepted`,
			);
		}
		const count = calls.length;
		assert.equal((await invoke(Scenario.Limit)).stopReason, "error");
		assert.equal(calls.length - count, 1);
		const controller = new AbortController();
		const abort = setTimeout(() => controller.abort(), 30);
		assert.equal(
			(await invoke(Scenario.HeaderHang, { signal: controller.signal }))
				.stopReason,
			"aborted",
		);
		clearTimeout(abort);
		const bodyAbort = new AbortController();
		assert.equal(
			(
				await invoke(Scenario.BodyHang, {
					signal: bodyAbort.signal,
					onResponse: () => bodyAbort.abort(),
				})
			).stopReason,
			"aborted",
		);
		assert.equal(
			(await invoke(Scenario.HeaderHang, { timeoutMs: 30 })).stopReason,
			"error",
		);
		assert.equal(
			(
				await invoke(Scenario.BodyHang, {
					onResponse: () => handlers.get("session_shutdown")({}),
				})
			).stopReason,
			"error",
		);
		const beforeInvalid = calls.length;
		const proxy = await invoke(Scenario.Success, {
			env: { ...runtimeEnv, HTTPS_PROXY: "http://127.0.0.1:9" },
		});
		assert.equal(proxy.stopReason, "error");
		assert.match(proxy.errorMessage, /proxy environment settings/);
		const missing = await invoke(Scenario.Success, {
			env: { PI_BIG_PICKLE_RUNTIME: join(directory, "missing") },
		});
		assert.equal(missing.stopReason, "error");
		assert.match(missing.errorMessage, /PI_BIG_PICKLE_RUNTIME/);
		assert.equal(calls.length, beforeInvalid);
		await handlers.get("session_shutdown")({});
	} finally {
		childProcess.spawn = originalSpawn;
		childProcess.spawnSync = originalSpawnSync;
		syncBuiltinESMExports();
		for (const [name, value] of Object.entries(proxyState)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(directory, { recursive: true, force: true });
	}
});
