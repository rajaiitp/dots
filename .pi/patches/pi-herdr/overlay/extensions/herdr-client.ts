import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	HerdrJsonEnvelope,
	PaneInfo,
	PaneProcessInfo,
	PaneWaitForOutputResult,
	ReadSource,
	TabInfo,
	WorkspaceInfo,
} from "./herdr-types.js";

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted === true || (error instanceof Error && error.message === "Aborted");
}

function parseHerdrError(output: string): string | null {
	const trimmed = output.trim();
	if (!trimmed) return null;
	try {
		const value = JSON.parse(trimmed) as HerdrJsonEnvelope;
		return value.error?.message || value.error?.code || trimmed;
	} catch {
		return trimmed;
	}
}

export class HerdrClient {
	constructor(
		private readonly pi: ExtensionAPI,
		private readonly currentPaneTarget: string,
	) {}

	async exec(args: string[], signal?: AbortSignal) {
		const result = await this.pi.exec("herdr", args, { signal });
		if (signal?.aborted || result.killed) {
			throw new Error("Aborted");
		}
		if (result.code !== 0) {
			const message =
				parseHerdrError(result.stderr) ||
				parseHerdrError(result.stdout) ||
				`herdr ${args.join(" ")} failed with exit code ${result.code}`;
			throw new Error(message);
		}
		return result;
	}

	async json<T = unknown>(args: string[], signal?: AbortSignal): Promise<T> {
		const result = await this.exec(args, signal);
		const stdout = result.stdout.trim();
		if (!stdout) {
			throw new Error(`Expected JSON output from herdr ${args.join(" ")}`);
		}
		let value: HerdrJsonEnvelope;
		try {
			value = JSON.parse(stdout) as HerdrJsonEnvelope;
		} catch {
			throw new Error(`Failed to parse JSON from herdr ${args.join(" ")}`);
		}
		if (value.error) {
			throw new Error(value.error.message || value.error.code || `herdr ${args.join(" ")} failed`);
		}
		return value as T;
	}

	async text(args: string[], signal?: AbortSignal): Promise<string> {
		const result = await this.exec(args, signal);
		return result.stdout;
	}

	async getCurrentPaneInfo(signal?: AbortSignal): Promise<PaneInfo> {
		const response = await this.json<{ result: { pane: PaneInfo } }>(["pane", "get", this.currentPaneTarget], signal);
		return response.result.pane;
	}

	async getWorkspaceList(signal?: AbortSignal): Promise<WorkspaceInfo[]> {
		const response = await this.json<{ result: { workspaces: WorkspaceInfo[] } }>(["workspace", "list"], signal);
		return response.result.workspaces || [];
	}

	async getWorkspacePanes(workspaceId: string, signal?: AbortSignal): Promise<PaneInfo[]> {
		const response = await this.json<{ result: { panes: PaneInfo[] } }>([
			"pane",
			"list",
			"--workspace",
			workspaceId,
		], signal);
		return response.result.panes || [];
	}

	async getTabList(workspaceId?: string, signal?: AbortSignal): Promise<TabInfo[]> {
		const args = ["tab", "list"];
		if (workspaceId) args.push("--workspace", workspaceId);
		const response = await this.json<{ result: { tabs: TabInfo[] } }>(args, signal);
		return response.result.tabs || [];
	}

	async getPaneInfo(paneId: string, signal?: AbortSignal): Promise<PaneInfo | null> {
		try {
			const response = await this.json<{ result: { pane: PaneInfo } }>(["pane", "get", paneId], signal);
			return response.result.pane;
		} catch (error) {
			if (isAbortError(error, signal)) throw error;
			return null;
		}
	}

	async getPaneProcessInfo(paneId: string, signal?: AbortSignal): Promise<PaneProcessInfo> {
		const response = await this.json<{ result: { process_info: PaneProcessInfo } }>([
			"pane",
			"process-info",
			"--pane",
			paneId,
		], signal);
		return response.result.process_info;
	}

	async waitForPaneOutput(
		paneId: string,
		match: string,
		options: { source: ReadSource; lines: number; timeout: number; raw?: boolean },
		signal?: AbortSignal,
	): Promise<PaneWaitForOutputResult> {
		const args = [
			"pane",
			"wait-output",
			paneId,
			"--match",
			match,
			"--source",
			options.source,
			"--lines",
			String(options.lines),
			"--timeout",
			String(options.timeout),
		];
		if (options.raw) args.push("--raw");
		const response = await this.json<{ result: PaneWaitForOutputResult }>(args, signal);
		return response.result;
	}

	async readPane(
		paneId: string,
		options: { source?: ReadSource; lines?: number; raw?: boolean },
		signal?: AbortSignal,
	): Promise<string> {
		const args = ["pane", "read", paneId];
		if (options.source) args.push("--source", options.source);
		if (options.lines != null) args.push("--lines", String(options.lines));
		if (options.raw) args.push("--raw");
		return this.text(args, signal);
	}

	async compressShellOutput(
		text: string,
		options: { maxTokens?: number; timeout?: number },
		signal?: AbortSignal,
	): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "pi-herdr-output-"));
		const capturePath = join(directory, "capture.txt");
		try {
			await writeFile(capturePath, text, { encoding: "utf8", mode: 0o600 });
			const binary = process.env.HYPA_BIN?.trim() || "hypa";
			const args = ["compress", "--kind", "shell-output", "--file", capturePath];
			if (options.maxTokens != null) args.push("--max-tokens", String(options.maxTokens));
			const result = await this.pi.exec(binary, args, {
				signal,
				timeout: options.timeout ?? 15_000,
			});
			if (signal?.aborted || result.killed) throw new Error("Hypa compression aborted.");
			if (result.code !== 0) {
				throw new Error(result.stderr.trim() || `Hypa compression failed with exit code ${result.code}.`);
			}
			return result.stdout;
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
}
