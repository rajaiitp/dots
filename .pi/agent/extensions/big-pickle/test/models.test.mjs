import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadProvider } from "./host.mjs";

const catalog = JSON.parse(
	readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8"),
);
const CONTEXT_RESERVE = 4096;
const PIXEL =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6xkAAAAASUVORK5CYII=";
const tool = {
	name: "echo",
	description: "Echo a value",
	parameters: {
		type: "object",
		properties: { value: { type: "string" } },
		required: ["value"],
	},
};

function reply(toolCall = false) {
	const delta = toolCall
		? {
				tool_calls: [
					{
						index: 0,
						id: "call_echo",
						type: "function",
						function: { name: "echo", arguments: '{"value":"safe"}' },
					},
				],
			}
		: { content: "OK" };
	return new Response(
		`data: ${JSON.stringify({ id: "model-test", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
			`data: ${JSON.stringify({ id: "model-test", choices: [{ index: 0, delta: {}, finish_reason: toolCall ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function registeredModel(config, providerId, definition) {
	return {
		...definition,
		type: "chat",
		provider: providerId,
		api: config.api,
		baseUrl: config.baseUrl,
	};
}

test("all registered models match the current zero-priced chat catalog", async () => {
	const { config } = await loadProvider();
	assert.equal(config.name, "OpenCode Free");
	assert.equal(config.models[0].id, "big-pickle");
	assert.deepEqual(
		config.models.map((model) => model.id).sort(),
		catalog.map((model) => model.id).sort(),
	);
	assert.equal(
		new Set(config.models.map((model) => model.id)).size,
		config.models.length,
	);
	assert.ok(
		!config.models.some((model) => model.id === "nemotron-3-ultra-free"),
	);
	for (const model of config.models) {
		const upstream = catalog.find((entry) => entry.id === model.id);
		assert.equal(upstream.type, "chat");
		assert.equal(upstream.cost.text.input.price, 0);
		assert.equal(upstream.cost.text.output.price, 0);
		assert.equal(upstream.capabilities.tools.supported, true);
		assert.equal(upstream.api["chat-completions"].base_url, config.baseUrl);
		assert.equal(model.name, upstream.name);
		assert.equal(model.contextWindow, upstream.limit.context - CONTEXT_RESERVE);
		assert.equal(model.maxTokens, upstream.limit.output);
		assert.equal(model.reasoning, upstream.capabilities.reasoning.supported);
		assert.equal(
			model.input.includes("image"),
			upstream.modalities.input.some((value) => value.startsWith("image/")),
		);
		assert.ok(Object.values(model.cost).every((value) => value === 0));
		if (model.thinkingLevelMap) {
			const supported = upstream.capabilities.reasoning.effort;
			assert.ok(
				Object.values(model.thinkingLevelMap).every(
					(value) => value === null || supported.includes(value),
				),
			);
		}
	}
});

test("each model keeps its own identity, prompts, schemas and native tool-result flow", async () => {
	const { providerId, config } = await loadProvider();
	for (const definition of config.models) {
		const model = registeredModel(config, providerId, definition);
		const context = {
			messages: [
				{
					role: "system",
					content: "Model policy sentinel",
					sections: { project: "Project policy sentinel" },
					toolsAdded: [tool],
					timestamp: 0,
				},
				{ role: "user", content: "Echo safe", timestamp: 1 },
			],
		};
		const original = structuredClone(context);
		const bodies = [];
		let callTool = true;
		const fetch = async (input, init) => {
			const request = new Request(input, init);
			assert.equal(
				request.url,
				"https://opencode.ai/inference/openai/v1/chat/completions",
			);
			assert.equal(request.headers.get("authorization"), "Bearer public");
			bodies.push(JSON.parse(await request.text()));
			return reply(callTool);
		};
		const options = {
			fetch,
			reasoning: "high",
			maxTokens: 64,
			onPayload: (payload) => ({ ...payload, hook_sentinel: true }),
		};
		const first = await config.streamSimple(model, context, options).result();
		assert.equal(
			first.stopReason,
			"toolUse",
			`${model.id}: ${first.errorMessage}`,
		);
		assert.equal(first.api, config.api);
		assert.equal(first.model, model.id);
		const call = first.content.find((part) => part.type === "toolCall");
		assert.deepEqual(call.arguments, { value: "safe" });
		callTool = false;
		const second = await config
			.streamSimple(
				model,
				{
					messages: [
						...context.messages,
						first,
						{
							role: "toolResult",
							toolCallId: call.id,
							toolName: "echo",
							content: [{ type: "text", text: "safe" }],
							isError: false,
							timestamp: 2,
						},
					],
				},
				options,
			)
			.result();
		assert.equal(
			second.stopReason,
			"stop",
			`${model.id}: ${second.errorMessage}`,
		);
		assert.equal(
			second.content.find((part) => part.type === "text")?.text,
			"OK",
		);
		for (const body of bodies) {
			assert.equal(body.model, model.id);
			assert.ok(
				body.messages[0].content.includes(
					`The exact model ID is opencode/${model.id}`,
				),
			);
			assert.ok(body.messages[0].content.includes("Model policy sentinel"));
			assert.ok(body.messages[0].content.includes("Project policy sentinel"));
			assert.deepEqual(body.tools[0].function.parameters, tool.parameters);
			assert.equal(body.hook_sentinel, true);
		}
		assert.equal(bodies[1].messages.at(-1).role, "tool");
		assert.deepEqual(context, original);
	}
});

test("image-capable models retain image inputs through the native serializer", async () => {
	const { providerId, config } = await loadProvider();
	for (const definition of config.models.filter((model) =>
		model.input.includes("image"),
	)) {
		const model = registeredModel(config, providerId, definition);
		let sent;
		const result = await config
			.streamSimple(
				model,
				{
					messages: [
						{ role: "system", content: "Image policy sentinel", timestamp: 0 },
						{
							role: "user",
							content: [
								{ type: "text", text: "Inspect this synthetic pixel" },
								{ type: "image", mimeType: "image/png", data: PIXEL },
							],
							timestamp: 1,
						},
					],
				},
				{
					maxTokens: 32,
					fetch: async (input, init) => {
						sent = JSON.parse(await new Request(input, init).text());
						return reply();
					},
				},
			)
			.result();
		assert.equal(
			result.stopReason,
			"stop",
			`${model.id}: ${result.errorMessage}`,
		);
		const user = sent.messages.find((message) => message.role === "user");
		assert.ok(
			user.content.some(
				(part) =>
					part.type === "image_url" &&
					part.image_url.url === `data:image/png;base64,${PIXEL}`,
			),
		);
	}
});

test("large-output models use a conservative default without limiting explicit requests", async () => {
	const { providerId, config } = await loadProvider();
	const definition = config.models.find((model) => model.id === "beam-free");
	const model = registeredModel(config, providerId, definition);
	const context = {
		messages: [{ role: "user", content: "Reply OK", timestamp: 1 }],
	};
	const budgets = [];
	const fetch = async (input, init) => {
		budgets.push(JSON.parse(await new Request(input, init).text()).max_tokens);
		return reply();
	};
	assert.equal(
		(await config.streamSimple(model, context, { fetch }).result()).stopReason,
		"stop",
	);
	assert.equal(
		(
			await config
				.streamSimple(model, context, { fetch, maxTokens: 65_536 })
				.result()
		).stopReason,
		"stop",
	);
	assert.deepEqual(budgets, [32_000, 65_536]);
});

test("payload hooks cannot silently switch to a paid or different model", async () => {
	const { config, model } = await loadProvider();
	for (const changed of ["gpt-6.1-sol", "beam-free", "nemotron-3-ultra-free"]) {
		let requests = 0;
		const result = await config
			.streamSimple(
				model,
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{
					fetch: async () => {
						requests++;
						return reply();
					},
					onPayload: (payload) => ({ ...payload, model: changed }),
				},
			)
			.result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /Unsupported model/);
		assert.equal(requests, 0);
	}
});
