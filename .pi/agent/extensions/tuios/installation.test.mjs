import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const installer = join(root, ".config/tuios/patch/install-unified-sidebar.sh");
const wrapper = join(root, ".pi/agent/skills/tuicr/tuicr-wrapper-tuios.sh");

async function fixture(t) {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "tuios-install-test-")),
	);
	t.after(() => rm(directory, { recursive: true, force: true }));
	return {
		directory,
		env: {
			...process.env,
			HOME: directory,
			XDG_CACHE_HOME: join(directory, "cache"),
		},
	};
}

test("portable installer status works with system Bash and releases its lock", async (t) => {
	const { directory, env } = await fixture(t);
	const result = execFileSync("/bin/bash", [installer, "--status"], {
		env,
		encoding: "utf8",
	});
	assert.match(result, /active: none/);
	assert.equal((await readFile(installer, "utf8")).includes("mapfile"), false);
	const state = join(directory, "cache/tuios-unified-sidebar");
	const { existsSync } = await import("node:fs");
	assert.equal(existsSync(join(state, "install.lock.d")), false);
});

test("activation validation failure preserves the installed binary", async (t) => {
	const { directory, env } = await fixture(t);
	await mkdir(join(directory, ".local/bin"), { recursive: true });
	const binary = join(directory, ".local/bin/tuios");
	await writeFile(binary, "old binary");
	const result = spawnSync("/bin/bash", [installer, "--activate"], {
		env,
		encoding: "utf8",
	});
	assert.notEqual(result.status, 0);
	assert.equal(await readFile(binary, "utf8"), "old binary");
});

test("bootstrap dry run selects tuios without reinstalling the legacy multiplexer", async (t) => {
	const { env } = await fixture(t);
	const output = execFileSync(
		"/bin/bash",
		[join(root, "install.sh"), "--dry-run", "--no-pkgs", "--yes"],
		{ env, encoding: "utf8", timeout: 30_000 },
	);
	assert.match(output, /tuios/);
	assert.doesNotMatch(output, /herdr/i);
	assert.match(output, /\.config\/tuios/);
});

test("tuicr wrapper runs native commands, forwards arguments and preserves exit status", async (t) => {
	const { directory, env } = await fixture(t);
	const bin = join(directory, "bin");
	await mkdir(bin);
	const log = join(directory, "calls.jsonl");
	await writeFile(
		join(bin, "tuios"),
		`#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'new-window') console.log(JSON.stringify({ window_id: 'review-pane' }));
else if (args[0] === 'wait-for') console.log(JSON.stringify({ exit_code: 7 }));
else if (args[0] !== 'close-window') process.exit(99);
`,
		{ mode: 0o700 },
	);
	await writeFile(join(bin, "tuicr"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	await chmod(join(bin, "tuios"), 0o700);
	const result = spawnSync("/bin/bash", [wrapper, directory, "--", "-w"], {
		env: {
			...env,
			PATH: `${bin}${delimiter}${env.PATH}`,
			TUIOS_ENV: "1",
			TUIOS_SESSION: "review-session",
			CALL_LOG: log,
		},
		encoding: "utf8",
	});
	assert.equal(result.status, 7, result.stderr);
	const calls = (await readFile(log, "utf8"))
		.trim()
		.split("\n")
		.map(JSON.parse);
	assert.deepEqual(
		calls.map((args) => args[0]),
		["new-window", "wait-for", "close-window"],
	);
	assert.ok(calls[0].includes("--keep-open"));
	assert.equal(calls[0].at(-1), "-w");
	assert.equal(calls[0][calls[0].indexOf("--cwd") + 1], resolve(directory));
	assert.ok(calls.every((args) => args.includes("review-session")));
});
