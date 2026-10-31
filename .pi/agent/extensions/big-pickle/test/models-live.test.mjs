import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extensionRoot } from "./host.mjs";

const ENABLED = process.env.PI_BIG_PICKLE_LIVE_TEST === "1";
const TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const catalog = JSON.parse(
	readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8"),
);
let limited = false;

for (const model of catalog.filter((entry) => entry.id !== "big-pickle")) {
	test(`live system-policy response: ${model.id}`, {
		skip: !ENABLED,
		timeout: TIMEOUT_MS,
	}, (context) => {
		if (limited) {
			context.skip(
				"A prior request reported a rate limit; no further requests sent.",
			);
			return;
		}
		const directory = mkdtempSync(join(tmpdir(), "opencode-free-live-"));
		const agentDir = join(directory, "agent");
		mkdirSync(agentDir);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
			}),
		);
		try {
			assert.equal(
				spawnSync("git", [
					"init",
					"--quiet",
					"--initial-branch=main",
					"--template=",
					directory,
				]).status,
				0,
			);
			const args = [
				"--offline",
				"--no-session",
				"--no-extensions",
				"--no-mcp",
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"--no-themes",
				"--no-approve",
				"-e",
				extensionRoot,
				"-e",
				join(extensionRoot, "test", "fixtures", "text-guard.ts"),
				"--model",
				`opencode-pickle-temp/${model.id}`,
				"--thinking",
				"off",
				"--mode",
				"json",
				"-p",
				"Reply with the smoke-test policy tag from your system instructions. Do not use tools.",
			];
			const result = spawnSync("pi", args, {
				cwd: directory,
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
				encoding: "utf8",
				timeout: TIMEOUT_MS,
				maxBuffer: MAX_OUTPUT_BYTES,
			});
			assert.equal(result.status, 0, result.error?.message ?? result.stderr);
			const events = result.stdout.split("\n").flatMap((line) => {
				try {
					return [JSON.parse(line)];
				} catch {
					return [];
				}
			});
			const messages = events
				.filter((event) => event.type === "message_end")
				.map((event) => event.message);
			const assistant = messages.filter(
				(message) => message.role === "assistant",
			);
			const final = assistant.at(-1);
			if (final?.errorMessage?.includes("429")) limited = true;
			assert.equal(
				assistant.length,
				1,
				"Smoke test must issue one model request, without retries.",
			);
			assert.equal(
				final?.stopReason,
				"stop",
				final?.errorMessage ?? result.stderr ?? "Missing model response",
			);
			assert.equal(final.model, model.id);
			assert.equal(final.api, "opencode-pickle-temp");
			assert.equal(
				final.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("")
					.trim(),
				"OPENCODE_FREE_MODEL_OK",
			);
			assert.ok(!messages.some((message) => message.role === "toolResult"));
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
