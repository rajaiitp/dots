import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const THINKING_LEVEL: ModelThinkingLevel = "xhigh";

const TARGET_MODELS = {
	sol: "gpt-5.6-sol",
	terra: "gpt-5.6-terra",
} as const;

type PendingRestore = {
	model: Model<Api> | undefined;
	thinkingLevel: ModelThinkingLevel;
};

export default function oneShotModelCommands(pi: ExtensionAPI) {
	let pendingRestore: PendingRestore | undefined;

	async function runOneShot(
		commandName: keyof typeof TARGET_MODELS,
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const prompt = args.trim();
		if (!prompt) {
			ctx.ui.notify(`Usage: /${commandName} <prompt>`, "warning");
			return;
		}

		if (!ctx.isIdle()) {
			ctx.ui.notify("The agent is busy. Try again when the current turn finishes.", "warning");
			return;
		}

		if (pendingRestore) {
			ctx.ui.notify("A one-shot model request is already running.", "warning");
			return;
		}

		const targetId = TARGET_MODELS[commandName];
		const targetModel = ctx.modelRegistry.find(PROVIDER, targetId);
		if (!targetModel) {
			ctx.ui.notify(`Model not found: ${PROVIDER}/${targetId}`, "error");
			return;
		}

		const previous: PendingRestore = {
			model: ctx.model,
			thinkingLevel: pi.getThinkingLevel(),
		};

		if (!(await pi.setModel(targetModel))) {
			ctx.ui.notify(`Could not use ${PROVIDER}/${targetId}; check its authentication.`, "error");
			return;
		}

		pi.setThinkingLevel(THINKING_LEVEL);
		pendingRestore = previous;

		try {
			pi.sendUserMessage(prompt);
			ctx.ui.notify(`One-shot: ${targetId} (${THINKING_LEVEL})`, "info");
		} catch (error) {
			pendingRestore = undefined;
			await restore(previous, ctx);
			throw error;
		}
	}

	async function restore(previous: PendingRestore, ctx: ExtensionContext): Promise<void> {
		if (previous.model) {
			await pi.setModel(previous.model);
		}
		pi.setThinkingLevel(previous.thinkingLevel);
		ctx.ui.notify("Restored the previous model and thinking level.", "info");
	}

	pi.registerCommand("sol", {
		description: "Run one prompt with GPT-5.6 Sol at xhigh, then restore the current model",
		handler: async (args, ctx) => runOneShot("sol", args, ctx),
	});

	pi.registerCommand("terra", {
		description: "Run one prompt with GPT-5.6 Terra at xhigh, then restore the current model",
		handler: async (args, ctx) => runOneShot("terra", args, ctx),
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!pendingRestore) return;

		const previous = pendingRestore;
		pendingRestore = undefined;
		await restore(previous, ctx);
	});

	pi.on("session_shutdown", async () => {
		if (!pendingRestore) return;

		const previous = pendingRestore;
		pendingRestore = undefined;
		if (previous.model) {
			await pi.setModel(previous.model);
		}
		pi.setThinkingLevel(previous.thinkingLevel);
	});
}
