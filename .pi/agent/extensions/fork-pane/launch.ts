import { realpath } from "node:fs/promises";
import { type ExtensionAPI, parseArgs } from "@earendil-works/pi-coding-agent";
import {
	responseRecords,
	responseString,
	TuiosClient,
} from "../tuios/client.ts";
import { PREFILL_SESSION_ENV, SHORT_ID_LENGTH } from "./session.ts";

const VALUE_OPTIONS = {
	provider: "--provider",
	model: "--model",
	apiKey: "--api-key",
	systemPrompt: "--system-prompt",
	thinking: "--thinking",
	useTheme: "--use-theme",
	tuiMode: "--tui-mode",
} as const;
const LIST_OPTIONS = {
	models: "--models",
	tools: "--tools",
	excludeTools: "--exclude-tools",
} as const;
const REPEATED_OPTIONS = {
	appendSystemPrompt: "--append-system-prompt",
	extensions: "--extension",
	skills: "--skill",
	promptTemplates: "--prompt-template",
	themes: "--theme",
} as const;
const BOOLEAN_OPTIONS = {
	noTools: "--no-tools",
	noBuiltinTools: "--no-builtin-tools",
	noExtensions: "--no-extensions",
	noMcp: "--no-mcp",
	noSkills: "--no-skills",
	noPromptTemplates: "--no-prompt-templates",
	noThemes: "--no-themes",
	noContextFiles: "--no-context-files",
	offline: "--offline",
	verbose: "--verbose",
} as const;

export function forkRuntimeArgs(argv: string[]): string[] {
	const options = parseArgs(argv);
	const error = options.diagnostics.find((item) => item.type === "error");
	if (error) throw new Error(error.message);
	const args: string[] = [];
	for (const key of Object.keys(
		VALUE_OPTIONS,
	) as (keyof typeof VALUE_OPTIONS)[]) {
		const value = options[key];
		if (value !== undefined) args.push(VALUE_OPTIONS[key], value);
	}
	for (const key of Object.keys(
		LIST_OPTIONS,
	) as (keyof typeof LIST_OPTIONS)[]) {
		const value = options[key];
		if (value) args.push(LIST_OPTIONS[key], value.join(","));
	}
	for (const key of Object.keys(
		REPEATED_OPTIONS,
	) as (keyof typeof REPEATED_OPTIONS)[]) {
		for (const value of options[key] ?? [])
			args.push(REPEATED_OPTIONS[key], value);
	}
	for (const key of Object.keys(
		BOOLEAN_OPTIONS,
	) as (keyof typeof BOOLEAN_OPTIONS)[]) {
		if (options[key]) args.push(BOOLEAN_OPTIONS[key]);
	}
	if (options.projectTrustOverride !== undefined)
		args.push(options.projectTrustOverride ? "--approve" : "--no-approve");
	for (const [name, value] of options.unknownFlags) {
		args.push(typeof value === "string" ? `--${name}=${value}` : `--${name}`);
	}
	return args;
}

export async function sourcePane(
	client: TuiosClient,
	session: string,
	paneId: string,
) {
	const listing = await client.call("list-windows", { session });
	const pane = responseRecords(listing, "windows").find(
		(item) => item.window_id === paneId,
	);
	if (
		!pane ||
		typeof pane.workspace !== "number" ||
		!Number.isInteger(pane.workspace) ||
		pane.workspace < 1
	)
		throw new Error("The source tuios pane is unavailable.");
	return { session, paneId, workspace: pane.workspace };
}

export async function launchFork(
	pi: ExtensionAPI,
	target: Awaited<ReturnType<typeof sourcePane>>,
	fork: { path: string; id: string },
	cwd: string,
	sessionDir: string,
	runtimeArgs: string[],
	entrypoint: string,
) {
	const env: Record<string, string> = { [PREFILL_SESSION_ENV]: fork.id };
	for (const key of ["PATH", "PI_CODING_AGENT_DIR", "PI_OFFLINE"]) {
		if (process.env[key]) env[key] = process.env[key];
	}
	const result = await new TuiosClient(pi).call("new-window", {
		session: target.session,
		workspace: target.workspace,
		name: `fork-${fork.id.slice(0, SHORT_ID_LENGTH)}`,
		cwd,
		focus: false,
		keep_open: true,
		command: [
			process.execPath,
			await realpath(entrypoint),
			...runtimeArgs,
			"--session",
			fork.path,
			"--session-dir",
			sessionDir,
		],
		env,
	});
	return responseString(result, "window_id");
}
