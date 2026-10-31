import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extensionRoot } from "./host.mjs";

const ENABLED = process.env.PI_BIG_PICKLE_LIVE_TEST === "1";
const COMMAND = "printf '%s\\n' PICKLE_TOOL_OK";
const TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

test("real Pi tool call, tool result and final text", {
	skip: !ENABLED,
	timeout: TIMEOUT_MS,
}, () => {
	const cwd = mkdtempSync(join(tmpdir(), "big-pickle-live-"));
	try {
		const git = spawnSync("git", [
			"init",
			"--quiet",
			"--initial-branch=main",
			"--template=",
			cwd,
		]);
		assert.equal(git.status, 0);
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
			join(extensionRoot, "test", "fixtures", "tool-guard.ts"),
			"--model",
			"opencode-pickle-temp/big-pickle",
			"--thinking",
			"off",
			"--mode",
			"json",
			"-p",
			`Use bash once to run exactly this command:\n${COMMAND}\n\nThen reply exactly PICKLE_TOOL_OK. Use no other tools.`,
		];
		const result = spawnSync("pi", args, {
			cwd,
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
		const tools = messages.filter((message) => message.role === "toolResult");
		assert.equal(tools.length, 1);
		assert.equal(tools[0].toolName, "bash");
		assert.equal(tools[0].isError, false);
		assert.ok(
			tools[0].content.some(
				(part) => part.type === "text" && part.text.includes("PICKLE_TOOL_OK"),
			),
		);
		const final = messages
			.filter((message) => message.role === "assistant")
			.at(-1);
		assert.equal(
			final?.stopReason,
			"stop",
			final?.errorMessage ?? "Missing final answer",
		);
		assert.equal(final.api, "opencode-pickle-temp");
		assert.equal(
			final.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("")
				.trim(),
			"PICKLE_TOOL_OK",
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
