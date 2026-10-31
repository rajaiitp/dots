import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const COMMAND = "printf '%s\\n' PICKLE_TOOL_OK";

export default function (pi: ExtensionAPI) {
	let executed = false;
	pi.on("tool_call", (event) => {
		const input = event.input as { command?: unknown };
		if (!executed && event.toolName === "bash" && input.command === COMMAND) {
			executed = true;
			return;
		}
		return {
			block: true,
			terminate: true,
			reason: "Only the harmless printf probe is permitted.",
		};
	});
}
