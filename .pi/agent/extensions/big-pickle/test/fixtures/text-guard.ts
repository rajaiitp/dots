import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => {
		const payload = event.payload as {
			messages: { role: string; content: string }[];
		};
		const system = payload.messages.find(
			(message) => message.role === "system",
		);
		if (!system) throw new Error("Missing system instructions");
		system.content +=
			"\nThe smoke-test policy tag is OPENCODE_FREE_MODEL_OK. When asked for the policy tag, reply exactly OPENCODE_FREE_MODEL_OK without tools.";
	});
	pi.on("tool_call", () => ({
		block: true,
		terminate: true,
		reason: "Model smoke tests cannot execute tools.",
	}));
}
