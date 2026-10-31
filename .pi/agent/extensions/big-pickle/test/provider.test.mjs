import assert from "node:assert/strict";
import test from "node:test";
import { loadProvider, validateToolCall } from "./host.mjs";

function response(chunks) {
	return new Response(
		chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
			"data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream" } },
	);
}
const textChunks = [
	{
		id: "text",
		choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
	},
	{
		id: "text",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
	},
];
function toolResponse(argumentsText) {
	return response([
		{
			id: "tools",
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								id: "call_test",
								type: "function",
								function: { name: "echo", arguments: argumentsText },
							},
						],
					},
					finish_reason: null,
				},
			],
		},
		{
			id: "tools",
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
		},
	]);
}

test("permanent branding preserves provider identity, native context, hooks and tool validation", async () => {
	const { providerId, config, model, handlers } = await loadProvider();
	assert.equal(providerId, "opencode-pickle-temp");
	assert.equal(config.name, "OpenCode Free");
	assert.equal(config.models.length, 8);
	assert.equal(model.id, "big-pickle");
	assert.equal(model.name, "Big Pickle");
	const tool = {
		name: "echo",
		description: "Echo a value",
		parameters: {
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
		},
	};
	const context = {
		messages: [
			{
				role: "system",
				content: "Base policy sentinel",
				sections: { project: "Project policy sentinel" },
				toolsAdded: [tool],
				timestamp: 0,
			},
			{ role: "user", content: "hello", timestamp: 1 },
		],
	};
	const original = structuredClone(context);
	const requests = [];
	let reply = () => response(textChunks);
	const mockFetch = async (input, init) => {
		const request = new Request(input, init);
		requests.push({
			url: request.url,
			headers: request.headers,
			body: JSON.parse(await request.text()),
		});
		return reply();
	};
	let observed = 0;
	let responseObserved = false;
	const options = {
		fetch: mockFetch,
		headers: { aUtHoRiZaTiOn: "Bearer do-not-send", "X-Test": "preserved" },
		onPayload: (payload) => ({ ...payload, test_payload_hook: true }),
		onResponse: () => {
			responseObserved = true;
		},
		onProviderStreamEvent: async () => {
			observed++;
		},
		maxTokens: 32,
	};
	const first = await config.streamSimple(model, context, options).result();
	assert.equal(first.stopReason, "stop", first.errorMessage);
	assert.equal(first.api, config.api);
	assert.equal(
		first.content.find((block) => block.type === "text")?.text,
		"ok",
	);
	assert.equal(first.usage.totalTokens, 4);
	const sent = requests[0];
	assert.equal(
		sent.url,
		"https://opencode.ai/inference/openai/v1/chat/completions",
	);
	assert.equal(sent.headers.get("authorization"), "Bearer public");
	assert.equal(sent.headers.has("accept"), false);
	assert.ok(
		[...sent.headers.keys()].every((name) => !name.startsWith("x-stainless-")),
	);
	assert.equal(
		sent.headers.get("user-agent"),
		"opencode/1.18.29 ai-sdk/provider-utils/4.0.23 runtime/bun/1.4.0",
	);
	assert.equal(sent.headers.get("x-opencode-project"), "global");
	assert.equal(sent.headers.has("x-opencode-session-id"), false);
	assert.equal(sent.headers.get("x-opencode-client"), "cli");
	assert.equal(sent.headers.get("x-test"), "preserved");
	assert.match(
		sent.headers.get("x-opencode-session"),
		/^ses_[a-f0-9]{12}[a-zA-Z0-9]{14}$/,
	);
	assert.match(
		sent.headers.get("x-opencode-request"),
		/^msg_[a-f0-9]{12}[a-zA-Z0-9]{14}$/,
	);
	const system = sent.body.messages.find(
		(message) => message.role === "system",
	);
	assert.ok(
		system.content.startsWith("You are opencode, an interactive CLI tool"),
	);
	assert.ok(
		system.content.includes("The exact model ID is opencode/big-pickle"),
	);
	assert.ok(system.content.includes("<env>"));
	assert.ok(system.content.includes("Base policy sentinel"));
	assert.ok(system.content.includes("Project policy sentinel"));
	assert.deepEqual(sent.body.tools[0].function.parameters, tool.parameters);
	assert.equal(sent.body.tools[0].function.name, "echo");
	assert.equal(sent.body.tool_choice, "auto");
	assert.deepEqual(context, original);
	assert.equal(sent.body.max_tokens, 32);
	assert.equal(sent.body.test_payload_hook, true);
	assert.ok(responseObserved && observed > 0);
	await config
		.streamSimple(model, context, { fetch: mockFetch, maxTokens: 32 })
		.result();
	assert.equal(
		requests[1].headers.get("x-opencode-session"),
		sent.headers.get("x-opencode-session"),
	);
	assert.equal(
		requests[1].headers.get("x-opencode-request"),
		sent.headers.get("x-opencode-request"),
	);

	reply = () => toolResponse('{"value":"safe"}');
	const toolCall = await config
		.streamSimple(model, context, { fetch: mockFetch, maxTokens: 32 })
		.result();
	assert.equal(toolCall.stopReason, "toolUse", toolCall.errorMessage);
	assert.deepEqual(
		toolCall.content.find((block) => block.type === "toolCall")?.arguments,
		{ value: "safe" },
	);
	reply = () => response(textChunks);
	await config
		.streamSimple(
			model,
			{
				messages: [
					...context.messages,
					toolCall,
					{
						role: "toolResult",
						toolCallId: "call_test",
						toolName: "echo",
						content: [{ type: "text", text: "safe" }],
						isError: false,
						timestamp: 2,
					},
				],
			},
			{ fetch: mockFetch, maxTokens: 32 },
		)
		.result();
	assert.equal(requests.at(-1).body.messages.at(-1).role, "tool");
	assert.equal(
		requests.at(-1).headers.get("x-opencode-request"),
		sent.headers.get("x-opencode-request"),
	);
	await config
		.streamSimple(
			model,
			{
				messages: [
					...context.messages,
					{ role: "user", content: "A new user turn", timestamp: 3 },
				],
			},
			{ fetch: mockFetch, maxTokens: 32 },
		)
		.result();
	assert.notEqual(
		requests.at(-1).headers.get("x-opencode-request"),
		sent.headers.get("x-opencode-request"),
	);

	reply = () => toolResponse('{"value":');
	const malformed = await config
		.streamSimple(model, context, { fetch: mockFetch, maxTokens: 32 })
		.result();
	const invalidCall = malformed.content.find(
		(block) => block.type === "toolCall",
	);
	if (invalidCall) {
		assert.ok(invalidCall.argumentsError);
		await assert.rejects(
			validateToolCall([tool], invalidCall),
			/JSON|arguments/i,
		);
	} else assert.equal(malformed.stopReason, "error");

	const before = requests.length;
	reply = () =>
		new Response('{"error":{"message":"quota test"}}', {
			status: 429,
			headers: { "content-type": "application/json", "retry-after": "86400" },
		});
	const limited = await config
		.streamSimple(model, context, { fetch: mockFetch, maxTokens: 32 })
		.result();
	assert.equal(limited.stopReason, "error");
	assert.equal(requests.length - before, 1);
	await handlers.get("session_shutdown")({});
});
