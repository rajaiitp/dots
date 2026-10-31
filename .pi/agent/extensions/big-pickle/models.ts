import type { ThinkingLevelMap } from "@earendil-works/pi-ai/compat";

const PROFILE_CONTEXT_RESERVE = 4096;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

interface FreeChatModel {
	id: string;
	name: string;
	context: number;
	output: number;
	images?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

// Snapshot of https://opencode.ai/inference/v1/models; no paid models or classifiers.
export const FREE_CHAT_MODELS: readonly FreeChatModel[] = [
	{ id: "big-pickle", name: "Big Pickle", context: 200_000, output: 32_000 },
	{
		id: "glm-5.3-flash-free",
		name: "GLM-5.3-Flash Free",
		context: 200_000,
		output: 32_000,
		images: true,
		thinkingLevelMap: {
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		},
	},
	{
		id: "deepseek-v4.1-flash-free",
		name: "DeepSeek V4.1 Flash Free",
		context: 200_000,
		output: 32_000,
		images: true,
		thinkingLevelMap: {
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		},
	},
	{
		id: "nemotron-3.5-lightning-free",
		name: "Nemotron 3.5 Lightning Free",
		context: 262_144,
		output: 262_144,
	},
	{
		id: "nemotron-3.5-super-vl-free",
		name: "Nemotron 3.5 Super VL Free",
		context: 1_048_576,
		output: 131_072,
		images: true,
		thinkingLevelMap: {
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		},
	},
	{
		id: "beam-free",
		name: "Beam Free",
		context: 1_048_576,
		output: 131_072,
		thinkingLevelMap: {
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	},
	{
		id: "flint-40b-free",
		name: "Flint 40B Free",
		context: 262_144,
		output: 65_536,
		thinkingLevelMap: {
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	},
	{
		id: "mimo-v2.6-flash-free",
		name: "MiMo-V2.6-Flash Free",
		context: 200_000,
		output: 32_000,
		images: true,
	},
];

export function isFreeChatModel(id: unknown): id is string {
	return (
		typeof id === "string" && FREE_CHAT_MODELS.some((model) => model.id === id)
	);
}

export function modelDefinitions() {
	return FREE_CHAT_MODELS.map((model) => ({
		type: "chat" as const,
		id: model.id,
		name: model.name,
		reasoning: true,
		input: model.images
			? ["text" as const, "image" as const]
			: ["text" as const],
		contextWindow: model.context - PROFILE_CONTEXT_RESERVE,
		maxTokens: model.output,
		cost: { ...ZERO_COST },
		...(model.thinkingLevelMap
			? { thinkingLevelMap: { ...model.thinkingLevelMap } }
			: {}),
	}));
}
