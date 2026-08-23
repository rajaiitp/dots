import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrToolParameters } from "./herdr-types.js";
import { HerdrActionRuntime } from "./herdr-action-context.js";
import { HerdrClient } from "./herdr-client.js";
import { handlePaneAction } from "./herdr-pane-actions.js";
import { renderHerdrCall, renderHerdrResult } from "./herdr-render.js";
import { PaneAliasStore } from "./herdr-state.js";
import { PaneRunRegistry } from "./herdr-run-protocol.js";
import { handleWorkspaceAction } from "./herdr-workspace-actions.js";

export default function (pi: ExtensionAPI) {
	const herdrEnv = process.env.HERDR_ENV;
	const currentPaneTargetEnv = process.env.HERDR_PANE_ID;
	if (!herdrEnv || !currentPaneTargetEnv) {
		return;
	}
	const currentPaneTarget = currentPaneTargetEnv;

	const aliasStore = new PaneAliasStore();
	const client = new HerdrClient(pi, currentPaneTarget);
	const runRegistry = new PaneRunRegistry();

	pi.on("session_start", async (_event, ctx) => aliasStore.reconstruct(ctx));

	pi.registerTool({
		name: "herdr",
		label: "herdr",
		description:
			"Herdr-native pane orchestration for persistent, visible, interactive, or parallel workflows. " +
			"Normal run waits for a finite command to finish and returns its final pane output; use detached only for persistent processes.",
		promptGuidelines: [
			"Use Pi bash or hypa_shell for short finite commands that do not need a persistent pane.",
			"Use herdr only for visible, persistent, interactive, or parallel processes such as servers, REPLs, SSH sessions, and subagents.",
			"Use herdr run for a finite command in an existing idle Bash or Zsh pane. It waits for completion and returns final output, so do not poll with herdr read afterward.",
			"Use herdr run with detached: true only for intentionally long-running servers, watchers, REPLs, or other processes that should retain the pane.",
			"Use herdr read only for an immediate snapshot of a pane, including to inspect or recover a detached or timed-out command.",
			"Use herdr send with C-c to interrupt a process after a timed-out or detached run; do not submit another run until its foreground process returns to the shell.",
			"When you want to submit a line or prompt to a pane, prefer herdr run over send plus Enter so text and Enter happen atomically.",
			"Use herdr send only for low-level literal text or key injection when you do not want command-style submission semantics.",
			"Preserve the current UI focus by default. Do not change workspace or tab focus unless the user explicitly asks or the workflow truly requires visible interaction there.",
			"Pane actions like run, read, watch, wait_agent, send, and stop must target pane aliases or pane ids, not tab ids. For pane_split, omit pane to split the agent's own pane, or pass a pane alias/id to split that explicit source pane.",
			"Use herdr workspace, tab, and pane_split actions to organize parallel work instead of piling everything into one pane stack.",
			"Use herdr watch for normal pane output readiness, including server readiness; it waits inside Herdr rather than requiring polling reads.",
			"Use herdr wait_agent only for panes running a recognized coding agent. It waits on agent statuses, not normal process completion.",
			"For agent panes, background finished panes usually become done while focused finished panes usually become idle.",
			"Use recent-unwrapped when you need log matching or reads that ignore soft wrapping.",
			"Pane references can be either friendly aliases you created earlier or real herdr pane ids from list.",
			"Use pane_split, tab_create, or workspace_create to establish new pane targets. pane_split defaults to the agent's own pane when pane is omitted and splits right when direction is omitted. run only works with an existing pane alias or pane id.",
			"Use friendly pane aliases like server, reviewer, or tests so later reads, watches, and sends can reuse them across the session.",
			"When starting a fresh pi instance in another pane and the model matters, either specify --model explicitly or ask the user which model/provider they want.",
		],
		parameters: HerdrToolParameters,

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const currentPane = await client.getCurrentPaneInfo(signal);
			const runtime = new HerdrActionRuntime(
				client,
				aliasStore,
				currentPane.pane_id,
				currentPane.workspace_id,
				signal,
				onUpdate,
				runRegistry,
			);
			const result = await handleWorkspaceAction(params, runtime) ?? await handlePaneAction(params, runtime);
			if (result) return result;
			throw new Error(`Unknown action: ${params.action}`);
		},

		renderCall: renderHerdrCall,
		renderResult: renderHerdrResult,
	});
}
