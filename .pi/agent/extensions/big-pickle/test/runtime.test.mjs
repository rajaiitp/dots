import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extensionRoot, loader } from "./host.mjs";

const PROXY_NAMES = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
];

test("runtime checks are lazy, configurable, cached and fail closed", async () => {
	const {
		createRuntimeResolver,
		RuntimeConfigurationError,
		RuntimeDependencyError,
	} = await loader().import(join(extensionRoot, "runtime.ts"));
	const directory = mkdtempSync(join(tmpdir(), "big-pickle-runtime-"));
	const binary = join(directory, "bun");
	writeFileSync(binary, "fixture", { mode: 0o700 });
	const env = Object.fromEntries(PROXY_NAMES.map((name) => [name, undefined]));
	Object.assign(env, {
		PI_BIG_PICKLE_RUNTIME: binary,
		NODE_OPTIONS: "untrusted",
		BUN_OPTIONS: "untrusted",
		BUN_CONFIG_VERBOSE_FETCH: "curl",
		BUN_BE_BUN: "0",
	});
	let probes = 0;
	const resolveRuntime = createRuntimeResolver((runtime) => {
		probes++;
		assert.equal(runtime.binary, binary);
		assert.equal(runtime.env.NODE_OPTIONS, undefined);
		assert.equal(runtime.env.BUN_OPTIONS, undefined);
		assert.equal(runtime.env.BUN_CONFIG_VERBOSE_FETCH, undefined);
		assert.equal(runtime.env.BUN_BE_BUN, "1");
		return "1.4.0";
	});
	try {
		assert.equal(probes, 0);
		assert.equal(resolveRuntime(env).binary, binary);
		assert.equal(probes, 1);
		resolveRuntime(env);
		assert.equal(probes, 1);
		writeFileSync(binary, "changed fixture");
		resolveRuntime(env);
		assert.equal(probes, 2);
		assert.throws(
			() => resolveRuntime({ ...env, PI_BIG_PICKLE_RUNTIME: "bun" }),
			RuntimeConfigurationError,
		);
		assert.throws(
			() =>
				resolveRuntime({
					...env,
					PI_BIG_PICKLE_RUNTIME: join(directory, "missing"),
				}),
			RuntimeDependencyError,
		);
		assert.throws(
			() => resolveRuntime({ ...env, PI_BIG_PICKLE_RUNTIME: directory }),
			RuntimeDependencyError,
		);
		assert.throws(
			() => resolveRuntime({ ...env, HTTPS_PROXY: "http://127.0.0.1:9" }),
			RuntimeConfigurationError,
		);
		chmodSync(binary, 0o600);
		assert.throws(() => resolveRuntime(env), RuntimeDependencyError);
		chmodSync(binary, 0o700);
		assert.throws(
			() => createRuntimeResolver(() => "not Bun")(env),
			RuntimeDependencyError,
		);
		let attempts = 0;
		const recover = createRuntimeResolver(() =>
			++attempts === 1 ? "" : "1.4.0",
		);
		assert.throws(() => recover(env), RuntimeDependencyError);
		recover(env);
		assert.equal(attempts, 2);
		assert.throws(
			() =>
				createRuntimeResolver()({
					...env,
					PI_BIG_PICKLE_RUNTIME: process.execPath,
				}),
			RuntimeDependencyError,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
