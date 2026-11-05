import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	UserMessageSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import { TuiosClient } from "../tuios/client.ts";
import { forkRuntimeArgs, launchFork, sourcePane } from "./launch.ts";
import {
	forkMessages,
	PREFILL_SESSION_ENV,
	prefillText,
	SHORT_ID_LENGTH,
	saveFork,
} from "./session.ts";

const COMMAND = "fork-pane";

export function createForkPaneCommand(
	pi: ExtensionAPI,
	invocation = { argv: process.argv.slice(2), entrypoint: process.argv[1] },
) {
	let running = false;
	return {
		description: "Pick a message and fork into an unfocused tuios pane",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui" || process.env.TUIOS_ENV !== "1") {
				ctx.ui.notify("/fork-pane requires Pi running inside tuios.", "error");
				return;
			}
			if (running) {
				ctx.ui.notify("A pane fork is already in progress.", "warning");
				return;
			}
			running = true;
			let savedPath: string | undefined;
			try {
				const session = process.env.TUIOS_SESSION;
				const paneId = process.env.TUIOS_PANE_ID;
				if (!session || !paneId)
					throw new Error("The source tuios pane is unknown.");
				if (!ctx.sessionManager.getSessionFile())
					throw new Error("/fork-pane requires a saved session.");
				if (!invocation.entrypoint)
					throw new Error("The Pi executable is unknown.");
				const messages = forkMessages(ctx.sessionManager);
				if (!messages.length) {
					ctx.ui.notify("No messages to fork from.", "info");
					return;
				}
				const selectedId = await ctx.ui.custom<string | undefined>(
					(tui, _theme, _keys, done) => {
						const selector = new UserMessageSelectorComponent(
							messages,
							done,
							() => done(undefined),
							messages.at(-1)?.id,
						);
						return {
							render: (width: number) => selector.render(width),
							invalidate: () => selector.invalidate(),
							handleInput: (data: string) => {
								selector.getMessageList().handleInput(data);
								tui.requestRender();
							},
						};
					},
				);
				if (!selectedId) return;
				const runtimeArgs = forkRuntimeArgs(invocation.argv);
				runtimeArgs.push("--extension", fileURLToPath(import.meta.url));
				const target = await sourcePane(new TuiosClient(pi), session, paneId);
				const fork = await saveFork(ctx.sessionManager, selectedId);
				savedPath = fork.path;
				const childPane = await launchFork(
					pi,
					target,
					fork,
					ctx.cwd,
					ctx.sessionManager.getSessionDir(),
					runtimeArgs,
					invocation.entrypoint,
				);
				ctx.ui.notify(
					`Fork opened in pane ${childPane.slice(0, SHORT_ID_LENGTH)}.`,
					"info",
				);
			} catch (error) {
				const recovery = savedPath
					? ` Saved fork: ${savedPath}. Inspect tuios before retrying.`
					: "";
				ctx.ui.notify(
					`${error instanceof Error ? error.message : String(error)}${recovery}`,
					"error",
				);
			} finally {
				running = false;
			}
		},
	};
}

export default function forkPaneExtension(pi: ExtensionAPI) {
	pi.registerCommand(COMMAND, createForkPaneCommand(pi));
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup" || ctx.mode !== "tui") return;
		const expected = process.env[PREFILL_SESSION_ENV];
		if (!expected) return;
		delete process.env[PREFILL_SESSION_ENV];
		if (expected !== ctx.sessionManager.getSessionId()) return;
		ctx.ui.setEditorText(prefillText(ctx.sessionManager));
	});
}
