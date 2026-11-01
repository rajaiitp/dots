import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { hostRequire } from "../big-pickle/test/host.mjs";

const { createJiti } = hostRequire("jiti");
const jiti = createJiti(import.meta.url);
const { runAgentStart, AgentStartErrorKind, SHELL_READY_TIMEOUT_MS } =
	await jiti.import("./agent-start.ts");

const args = [
	"agent",
	"start",
	"bh-readiness",
	"--kind",
	"pi",
	"--pane",
	"new-pane",
];
const options = { timeout: 150_000 };
const started = () => ({
	code: 0,
	stdout: JSON.stringify({ result: { type: "agent_started" } }),
	stderr: "",
	killed: false,
});
const refused = (code = "agent_pane_busy") => ({
	code: 1,
	stdout: "",
	stderr: JSON.stringify({ error: { code, message: "pane not ready" } }),
	killed: false,
});

function readyAgent(overrides = {}) {
	return {
		...started(),
		stdout: JSON.stringify({
			result: {
				agent: {
					name: "bh-readiness",
					agent: "pi",
					pane_id: "new-pane",
					agent_status: "idle",
					...overrides,
				},
			},
		}),
	};
}

function fakeClock() {
	let elapsed = 0;
	const waits = [];
	return {
		waits,
		now: () => elapsed,
		advance: (milliseconds) => {
			elapsed += milliseconds;
		},
		wait: async (milliseconds, signal) => {
			signal?.throwIfAborted();
			waits.push(milliseconds);
			elapsed += milliseconds;
		},
	};
}

function runner(replies) {
	const calls = [];
	const pi = {
		exec: async (...call) => {
			calls.push(call);
			const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
			if (reply instanceof Error) throw reply;
			return reply;
		},
	};
	return { calls, pi };
}

test("ready shells launch once without a readiness delay", async () => {
	const clock = fakeClock();
	const { pi, calls } = runner([started()]);
	await runAgentStart(pi, "herdr", args, options, clock);
	assert.deepEqual(calls, [["herdr", args, options]]);
	assert.deepEqual(clock.waits, []);
});

test("explicit busy refusals retry the same launch until the shell is ready", async () => {
	const clock = fakeClock();
	const { pi, calls } = runner([refused(), refused(), started()]);
	await runAgentStart(pi, "herdr", args, options, clock);
	assert.equal(calls.length, 3);
	assert.equal(clock.waits.length, 2);
	assert.ok(clock.now() < SHELL_READY_TIMEOUT_MS);
	assert.ok(
		calls.every(
			(call) => call[0] === "herdr" && call[1] === args && call[2] === options,
		),
	);
});

test("recognizes structured busy refusals returned on stdout", async () => {
	const busy = refused();
	busy.stdout = busy.stderr;
	busy.stderr = "";
	const { pi, calls } = runner([busy, started()]);
	await runAgentStart(pi, "herdr", args, options, fakeClock());
	assert.equal(calls.length, 2);
});

test("permanently busy panes hit the deadline without one last launch attempt", async () => {
	const clock = fakeClock();
	const { pi, calls } = runner([refused()]);
	await assert.rejects(
		runAgentStart(pi, "herdr", args, options, clock),
		(error) => {
			assert.equal(error.kind, AgentStartErrorKind.ShellTimeout);
			assert.match(error.message, /pane not ready/);
			return true;
		},
	);
	assert.equal(clock.now(), SHELL_READY_TIMEOUT_MS);
	assert.equal(calls.length, clock.waits.length);
});

test("time spent receiving a busy refusal counts against shell readiness", async () => {
	const clock = fakeClock();
	let calls = 0;
	const pi = {
		exec: async () => {
			calls += 1;
			clock.advance(SHELL_READY_TIMEOUT_MS);
			return refused();
		},
	};
	await assert.rejects(
		runAgentStart(pi, "herdr", args, options, clock),
		(error) => error.kind === AgentStartErrorKind.ShellTimeout,
	);
	assert.equal(calls, 1);
	assert.deepEqual(clock.waits, []);
});

for (const code of [
	"agent_not_ready",
	"agent_blocked",
	"timeout",
	"agent_pane_unavailable",
	"agent_name_taken",
	"agent_start_input_failed",
]) {
	test(`does not retry ${code}`, async () => {
		const clock = fakeClock();
		const { pi, calls } = runner([refused(code), started()]);
		await assert.rejects(
			runAgentStart(pi, "herdr", args, options, clock),
			(error) => error.kind === AgentStartErrorKind.Command,
		);
		assert.equal(calls.length, 1);
		assert.deepEqual(clock.waits, []);
	});
}

const invalidResponses = [
	["unstructured busy text", { ...refused(), stderr: "agent_pane_busy" }],
	["killed commands", { ...refused(), killed: true }],
	["contradictory exit codes", { ...refused(), code: 0 }],
	[
		"launch acknowledgments alongside busy errors",
		{ ...refused(), stdout: started().stdout },
	],
	[
		"conflicting protocol errors",
		{ ...refused(), stdout: refused("agent_name_taken").stderr },
	],
	["malformed launch acknowledgments", { ...started(), stdout: "not JSON" }],
	[
		"empty launch acknowledgments",
		{ ...started(), stdout: JSON.stringify({ result: null }) },
	],
];
for (const [label, response] of invalidResponses) {
	test(`does not retry or accept ${label}`, async () => {
		const clock = fakeClock();
		const { pi, calls } = runner([response, started()]);
		await assert.rejects(
			runAgentStart(pi, "herdr", args, options, clock),
			(error) => error.kind === AgentStartErrorKind.Command,
		);
		assert.equal(calls.length, 1);
		assert.deepEqual(clock.waits, []);
	});
}

for (const status of ["idle", "done"]) {
	test(`reconciles a false startup exit with the named ${status} agent without relaunching`, async () => {
		const clock = fakeClock();
		const { pi, calls } = runner([
			refused("agent_start_failed"),
			readyAgent({ agent_status: status }),
		]);
		await runAgentStart(pi, "herdr", args, options, clock);
		assert.equal(calls.length, 2);
		assert.deepEqual(calls[1][1], ["agent", "get", "bh-readiness"]);
		assert.deepEqual(clock.waits, []);
	});
}

for (const [label, response] of [
	["wrong pane", readyAgent({ pane_id: "other-pane" })],
	["wrong name", readyAgent({ name: "other-agent" })],
	["wrong agent kind", readyAgent({ agent: "codex" })],
	["working agent", readyAgent({ agent_status: "working" })],
	["blocked agent", readyAgent({ agent_status: "blocked" })],
	["unknown agent", readyAgent({ agent_status: "unknown" })],
	["absent agent", refused("agent_not_found")],
	["unreadable state", new Error("state query failed")],
	["killed state query", { ...readyAgent(), killed: true }],
]) {
	test(`does not accept or relaunch a startup failure with ${label}`, async () => {
		const clock = fakeClock();
		const { pi, calls } = runner([refused("agent_start_failed"), response]);
		await assert.rejects(
			runAgentStart(pi, "herdr", args, options, clock),
			(error) =>
				error.kind === AgentStartErrorKind.Command &&
				/agent_start_failed/.test(error.message),
		);
		assert.equal(calls.length, 2);
		assert.deepEqual(clock.waits, []);
	});
}

test("transport exceptions are not retried because launch status is unknown", async () => {
	const failure = new Error("connection closed");
	const { pi, calls } = runner([failure, started()]);
	await assert.rejects(
		runAgentStart(pi, "herdr", args, options, fakeClock()),
		(error) => error === failure,
	);
	assert.equal(calls.length, 1);
});

test("an aborted launch never invokes Herdr", async () => {
	const controller = new AbortController();
	controller.abort();
	const { pi, calls } = runner([started()]);
	await assert.rejects(
		runAgentStart(
			pi,
			"herdr",
			args,
			{ ...options, signal: controller.signal },
			fakeClock(),
		),
		{ name: "AbortError" },
	);
	assert.equal(calls.length, 0);
});

test("cancellation interrupts the readiness timer without another launch", async () => {
	const controller = new AbortController();
	const { pi, calls } = runner([refused(), started()]);
	const clock = {
		now: () => performance.now(),
		wait: (milliseconds, signal) => {
			const pending = delay(milliseconds, undefined, { signal });
			controller.abort();
			return pending;
		},
	};
	await assert.rejects(
		runAgentStart(
			pi,
			"herdr",
			args,
			{ ...options, signal: controller.signal },
			clock,
		),
		{ name: "AbortError" },
	);
	assert.equal(calls.length, 1);
});

test("cancellation is rechecked after a completed readiness wait", async () => {
	const controller = new AbortController();
	const { pi, calls } = runner([refused(), started()]);
	const clock = {
		now: () => 0,
		wait: async () => {
			controller.abort();
		},
	};
	await assert.rejects(
		runAgentStart(
			pi,
			"herdr",
			args,
			{ ...options, signal: controller.signal },
			clock,
		),
		{ name: "AbortError" },
	);
	assert.equal(calls.length, 1);
});
