import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

export const RUNTIME_ENV = "PI_BIG_PICKLE_RUNTIME";
export const RUNTIME_ARGUMENTS = [
	"--config=/dev/null",
	"--no-env-file",
	"--no-install",
	"--no-addons",
	"--eval",
];
const DEFAULT_RUNTIME = "/usr/bin/opencode";
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BYTES = 4096;
const PROBE_SCRIPT =
	"process.stdout.write(typeof Bun === 'undefined' ? '' : Bun.version)";
const BUN_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const PROXY_ENV_NAMES = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
];

export interface Runtime {
	binary: string;
	env: NodeJS.ProcessEnv;
}
export type RuntimeProbe = (runtime: Runtime) => string;

export class RuntimeConfigurationError extends Error {
	name = "RuntimeConfigurationError";
}
export class RuntimeDependencyError extends Error {
	name = "RuntimeDependencyError";
}

function probeRuntime(runtime: Runtime): string {
	const result = spawnSync(
		runtime.binary,
		[...RUNTIME_ARGUMENTS, PROBE_SCRIPT],
		{
			cwd: dirname(runtime.binary),
			env: runtime.env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: PROBE_TIMEOUT_MS,
			maxBuffer: PROBE_MAX_BYTES,
		},
	);
	if (result.error || result.status !== 0) {
		throw new RuntimeDependencyError(
			`Cannot start the OpenCode Free Bun runtime at ${runtime.binary}. Set ${RUNTIME_ENV} to a working Bun-compatible executable.`,
		);
	}
	return result.stdout.trim();
}

export function createRuntimeResolver(probe: RuntimeProbe = probeRuntime) {
	let verifiedFingerprint: string | undefined;
	return (
		overrides?: Readonly<Record<string, string | undefined>>,
	): Runtime => {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			...overrides,
			BUN_BE_BUN: "1",
		};
		if (PROXY_ENV_NAMES.some((name) => env[name])) {
			throw new RuntimeConfigurationError(
				"OpenCode Free direct IPv4 transport does not support proxy environment settings; no request was sent.",
			);
		}
		const binary = env[RUNTIME_ENV] ?? DEFAULT_RUNTIME;
		if (!isAbsolute(binary)) {
			throw new RuntimeConfigurationError(
				`${RUNTIME_ENV} must be an absolute executable path.`,
			);
		}
		let fingerprint: string;
		try {
			accessSync(binary, constants.X_OK);
			const stat = statSync(binary);
			if (!stat.isFile()) throw new Error("Not an executable file");
			fingerprint = JSON.stringify([
				binary,
				stat.dev,
				stat.ino,
				stat.size,
				stat.mtimeMs,
				stat.ctimeMs,
			]);
		} catch {
			throw new RuntimeDependencyError(
				`OpenCode Free needs an executable Bun runtime at ${binary}. Install OpenCode or set ${RUNTIME_ENV} to an absolute Bun-compatible executable path.`,
			);
		}
		delete env.BUN_CONFIG_VERBOSE_FETCH;
		delete env.BUN_OPTIONS;
		delete env.NODE_OPTIONS;
		const runtime = { binary, env };
		if (fingerprint !== verifiedFingerprint) {
			if (!BUN_VERSION.test(probe(runtime))) {
				throw new RuntimeDependencyError(
					`${binary} did not report a Bun version. Set ${RUNTIME_ENV} to a Bun-compatible executable.`,
				);
			}
			verifiedFingerprint = fingerprint;
		}
		return runtime;
	};
}
