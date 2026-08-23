import {
	COMPRESSION_MODE,
	HERDR_ACTION,
	READ_SOURCE,
	SPLIT_DIRECTION,
	WAIT_MODE,
	type AgentStatus,
	type CompressionMode,
	type HerdrToolInput,
	type PaneInfo,
	type PaneReadResult,
} from "./herdr-types.js";
import {
	formatReadOutput,
	formatStatusList,
	rejectUnexpectedParams,
	sleepWithSignal,
	throwIfAborted,
} from "./herdr-format.js";
import type { HerdrActionRuntime, HerdrToolResult } from "./herdr-action-context.js";
import { isAbortError } from "./herdr-client.js";
import {
	createCommandProtocol,
	DEFAULT_CAPTURE_LINES,
	DEFAULT_RUN_TIMEOUT_MS,
	extractCommandOutput,
	getIdleSupportedShell,
	parseCompletion,
	shouldAutoCompress,
} from "./herdr-run-protocol.js";

export async function handlePaneAction(
	params: HerdrToolInput,
	runtime: HerdrActionRuntime,
): Promise<HerdrToolResult | undefined> {
	switch (params.action) {
		case HERDR_ACTION.PANE_SPLIT: {
			rejectUnexpectedParams("pane_split", params, ["workspace", "tab"]);
			const paneRef = params.pane ?? runtime.currentPaneId;
			const direction = params.direction ?? SPLIT_DIRECTION.RIGHT;

			const sourcePane = await runtime.requirePaneRef(paneRef);
			const args = ["pane", "split", sourcePane.pane.pane_id, "--direction", direction];
			if (params.cwd) args.push("--cwd", params.cwd);
			if (params.focus !== true) args.push("--no-focus");

			const response = await runtime.client.json<{ result: { pane: PaneInfo } }>(args, runtime.signal);
			const splitPane = response.result.pane;
			if (params.newPane) {
				runtime.aliasStore.recordAlias(params.newPane, splitPane.pane_id, splitPane.workspace_id);
			}

			const sourceLabel = sourcePane.alias || paneRef;
			const aliasText = params.newPane ? `, aliased as '${params.newPane}'` : "";
			return {
				content: [{
					type: "text",
					text: `Created pane '${splitPane.pane_id}' by splitting '${sourceLabel}' ${direction}${aliasText}`,
				}],
				details: runtime.withSnapshot({
					action: HERDR_ACTION.PANE_SPLIT,
					pane: sourceLabel,
					paneId: sourcePane.pane.pane_id,
					newPane: params.newPane || splitPane.pane_id,
					newPaneId: splitPane.pane_id,
					direction,
					workspaceId: splitPane.workspace_id,
				}),
			};
		}

		case HERDR_ACTION.RUN: {
			rejectUnexpectedParams("run", params, ["workspace", "tab"]);
			validateRunParams(params);
			const paneRef = params.pane;
			const command = params.command;
			if (!paneRef) throw new Error("'pane' is required for run");
			if (!command) throw new Error("'command' is required for run");

			const targetPane = await runtime.requirePaneRef(paneRef);
			const paneId = targetPane.pane.pane_id;
			const paneLabel = targetPane.alias || paneRef;
			const currentState = runtime.runRegistry.get(paneId);
			if (currentState) {
				const processInfo = await runtime.client.getPaneProcessInfo(paneId, runtime.signal);
				runtime.runRegistry.clearIfShellIsIdle(paneId, processInfo);
			}

			const processInfo = await runtime.client.getPaneProcessInfo(paneId, runtime.signal);
			const shell = getIdleSupportedShell(processInfo);
			if (!shell) {
				throw new Error(
					`Pane '${paneLabel}' is not at an idle Bash or Zsh prompt. Do not inject a command into its current foreground process; use read, send C-c, or stop to recover it.`,
				);
			}

			if (params.detached) {
				runtime.runRegistry.markDetached(paneId);
				try {
					await runtime.client.exec(["pane", "run", paneId, command], runtime.signal);
				} catch (error) {
					runtime.runRegistry.clear(paneId);
					throw error;
				}
				return {
					content: [{
						type: "text",
						text: `Started detached command in pane '${paneLabel}' (${paneId}). Use read to inspect it; do not run another command until its foreground process returns to ${shell.name}.`,
					}],
					details: runtime.withSnapshot({
						action: HERDR_ACTION.RUN,
						pane: paneLabel,
						paneId,
						command,
						detached: true,
						workspaceId: runtime.currentWorkspaceId,
					}),
				};
			}

			const protocol = createCommandProtocol(command, shell.name);
			runtime.runRegistry.reserveWaiting(paneId, protocol.token);
			const timeout = params.timeout ?? DEFAULT_RUN_TIMEOUT_MS;
			const lines = params.lines ?? DEFAULT_CAPTURE_LINES;
			const startedAt = Date.now();
			const publishProgress = () => runtime.onUpdate?.({
				content: [{ type: "text", text: `Waiting for '${command}' in ${paneLabel}...` }],
				details: runtime.withSnapshot({
					action: HERDR_ACTION.RUN,
					pane: paneLabel,
					paneId,
					command,
					elapsed: Math.floor((Date.now() - startedAt) / 1000),
					state: "waiting",
				}),
			});
			publishProgress();
			const updateTimer = runtime.onUpdate ? setInterval(publishProgress, 1_000) : undefined;
			let completionObserved = false;

			try {
				await runtime.client.exec(["pane", "run", paneId, protocol.wrappedCommand], runtime.signal);
				const waited = await runtime.client.waitForPaneOutput(
					paneId,
					protocol.donePrefix,
					{ source: READ_SOURCE.RECENT_UNWRAPPED, lines, timeout, raw: params.raw },
					runtime.signal,
				);

				let captured = waited.read?.text ?? "";
				let completion = parseCompletion(captured, protocol.token) ?? parseCompletion(waited.matched_line ?? "", protocol.token);
				const captureTruncated = waited.read?.truncated === true;
				let usedFallbackRead = false;
				if (!completion) {
					captured = await runtime.client.readPane(
						paneId,
						{ source: READ_SOURCE.RECENT_UNWRAPPED, lines, raw: params.raw },
						runtime.signal,
					);
					completion = parseCompletion(captured, protocol.token);
					usedFallbackRead = true;
				}
				if (!completion) {
					throw new Error(`Herdr reported a completion match for pane '${paneLabel}', but the completion marker could not be parsed.`);
				}

				completionObserved = true;
				runtime.runRegistry.clear(paneId);
				if (!extractCommandOutput(captured, protocol.token).doneFound && !usedFallbackRead) {
					captured = await runtime.client.readPane(
						paneId,
						{ source: READ_SOURCE.RECENT_UNWRAPPED, lines, raw: params.raw },
						runtime.signal,
					);
					usedFallbackRead = true;
				}
				const extracted = extractCommandOutput(captured, protocol.token);
				const output = extracted.doneFound
					? extracted.text
					: `[Completion marker was outside retained pane scrollback; showing available output.]\n${captured}`;
				const rendered = await reduceRunOutput(output, params, runtime);
				const elapsed = Math.floor((Date.now() - startedAt) / 1000);
				const resultText = rendered.text || "[Command produced no output.]";

				return {
					content: [{
						type: "text",
						text: `Command exited with code ${completion.exitCode} in pane '${paneLabel}' (${elapsed}s).\n\n${resultText}`,
					}],
					details: runtime.withSnapshot({
						action: HERDR_ACTION.RUN,
						pane: paneLabel,
						paneId,
						command,
						exitCode: completion.exitCode,
						elapsed,
						outputCompressed: rendered.compressed,
						compressionFallback: rendered.fallback,
						captureTruncated,
						captureFallbackRead: usedFallbackRead,
						beginMarkerFound: extracted.beginFound,
						workspaceId: runtime.currentWorkspaceId,
					}),
				};
			} catch (error) {
				if (!completionObserved) {
					const reason = isAbortError(error, runtime.signal)
						? "aborted"
						: /timed? out/i.test(error instanceof Error ? error.message : String(error))
							? "timed_out"
							: "wait_failed";
					runtime.runRegistry.markPossiblyRunning(paneId, protocol.token, reason);
					if (reason === "timed_out") {
						throw new Error(`Timed out waiting for '${command}' in pane '${paneLabel}'. The command may still be running; use read, send C-c, or stop before another run.`);
					}
				}
				throw error;
			} finally {
				if (updateTimer) clearInterval(updateTimer);
			}
		}

		case HERDR_ACTION.READ: {
			rejectUnexpectedParams("read", params, ["workspace", "tab"]);
			const paneRef = params.pane;
			if (!paneRef) throw new Error("'pane' is required for read");

			const resolved = await runtime.requirePaneRef(paneRef);

			const output = await runtime.client.readPane(
				resolved.pane.pane_id,
				{
					source: params.source ?? READ_SOURCE.RECENT,
					lines: params.lines ?? 20,
					raw: params.raw,
				},
				runtime.signal,
			);

			return {
				content: [{ type: "text", text: formatReadOutput(output) }],
				details: runtime.withSnapshot({
					action: HERDR_ACTION.READ,
					pane: resolved.alias || paneRef,
					paneId: resolved.pane.pane_id,
					source: params.source ?? READ_SOURCE.RECENT,
				}),
			};
		}

		case HERDR_ACTION.WATCH: {
			rejectUnexpectedParams("watch", params, ["workspace", "tab"]);
			const paneRef = params.pane;
			const match = params.match;
			if (!paneRef) throw new Error("'pane' is required for watch");
			if (!match) throw new Error("'match' is required for watch");

			const resolved = await runtime.requirePaneRef(paneRef);
			const paneLabel = resolved.alias || paneRef;
			const startTime = Date.now();

			const publishWatchUpdate = () => {
				runtime.onUpdate?.({
					content: [{ type: "text", text: `Watching ${paneLabel}...` }],
					details: runtime.withSnapshot({
						action: HERDR_ACTION.WATCH,
						pane: paneLabel,
						paneId: resolved.pane.pane_id,
						match,
						elapsed: Math.floor((Date.now() - startTime) / 1000),
					}),
				});
			};

			publishWatchUpdate();
			const updateTimer = runtime.onUpdate ? setInterval(publishWatchUpdate, 1000) : null;

			try {
				const args = ["pane", "wait-output", resolved.pane.pane_id, "--match", match];
				if (params.source) args.push("--source", params.source);
				if (params.lines != null) args.push("--lines", String(params.lines));
				if (params.timeout != null) args.push("--timeout", String(params.timeout));
				if (params.regex) args.push("--regex");
				if (params.raw) args.push("--raw");

				const response = await runtime.client.json<{
					result: {
						type: string;
						pane_id: string;
						revision: number;
						matched_line: string;
						read: PaneReadResult;
					};
				}>(args, runtime.signal);
				const matched = response.result;
				const text = matched.read?.text ? formatReadOutput(matched.read.text) : matched.matched_line;

				return {
					content: [{ type: "text", text: `Matched: ${matched.matched_line}\n\n${text}` }],
					details: runtime.withSnapshot({
						action: HERDR_ACTION.WATCH,
						pane: paneLabel,
						paneId: resolved.pane.pane_id,
						matchedLine: matched.matched_line,
						elapsed: Math.floor((Date.now() - startTime) / 1000),
					}),
				};
			} finally {
				if (updateTimer) clearInterval(updateTimer);
			}
		}

		case HERDR_ACTION.WAIT_AGENT: {
			rejectUnexpectedParams("wait_agent", params, ["workspace", "tab"]);
			throwIfAborted(runtime.signal, "wait_agent");
			const paneRefs = params.panes?.length ? params.panes : params.pane ? [params.pane] : [];
			const statuses = params.statuses?.length ? params.statuses : params.status ? [params.status] : [];
			const mode = params.mode ?? WAIT_MODE.ALL;
			if (!paneRefs.length) throw new Error("'pane' or 'panes' is required for wait_agent");
			if (!statuses.length) throw new Error("'status' or 'statuses' is required for wait_agent");

			const resolvedPanes: Array<{ pane: PaneInfo; aliasOrRef: string }> = [];
			for (const paneRef of paneRefs) {
				throwIfAborted(runtime.signal, "wait_agent");
				const resolved = await runtime.requirePaneRef(paneRef);
				resolvedPanes.push({
					pane: resolved.pane,
					aliasOrRef: resolved.alias || paneRef,
				});
			}

			const deadline = params.timeout != null ? Date.now() + params.timeout : null;
			let snapshot: Array<{
				pane: string;
				paneId: string;
				status: AgentStatus;
				agent?: string;
			}> = [];

			while (true) {
				throwIfAborted(runtime.signal, "wait_agent");
				snapshot = [];
				for (const resolved of resolvedPanes) {
					throwIfAborted(runtime.signal, "wait_agent");
					const pane = await runtime.client.getPaneInfo(resolved.pane.pane_id, runtime.signal);
					if (!pane) throw new Error(`Pane '${resolved.aliasOrRef}' no longer exists.`);
					snapshot.push({
						pane: resolved.aliasOrRef,
						paneId: pane.pane_id,
						status: pane.agent_status,
						agent: pane.agent,
					});
				}

				const satisfied =
					mode === WAIT_MODE.ALL
						? snapshot.every((item) => statuses.includes(item.status))
						: snapshot.some((item) => statuses.includes(item.status));
				if (satisfied) break;
				if (deadline != null && Date.now() >= deadline) {
					throw new Error(
						`Timed out waiting for panes [${snapshot.map((item) => item.pane).join(", ")}] to reach ${mode} of statuses '${formatStatusList(statuses)}'. Last statuses: ${snapshot.map((item) => `${item.pane}=${item.status}`).join(", ")}`,
					);
				}
				await sleepWithSignal(250, runtime.signal);
			}

			const summary = snapshot.map((item) => `${item.pane}=${item.status}`).join(", ");
			return {
				content: [{
					type: "text",
					text: `wait_agent satisfied (${mode}: ${formatStatusList(statuses)})\n\n${summary}`,
				}],
				details: runtime.withSnapshot({
					action: HERDR_ACTION.WAIT_AGENT,
					pane: paneRefs.length === 1 ? resolvedPanes[0]?.aliasOrRef : undefined,
					panes: snapshot.map((item) => item.pane),
					paneIds: snapshot.map((item) => item.paneId),
					status: paneRefs.length === 1 && statuses.length === 1 ? snapshot[0]?.status : undefined,
					statuses,
					mode,
					agents: snapshot.map((item) => item.agent).filter(Boolean),
					snapshot,
				}),
			};
		}

		case HERDR_ACTION.SEND: {
			rejectUnexpectedParams("send", params, ["workspace", "tab"]);
			const paneRef = params.pane;
			if (!paneRef) throw new Error("'pane' is required for send");
			if (!params.text && !params.keys) throw new Error("'text' or 'keys' is required for send");

			const resolved = await runtime.requirePaneRef(paneRef);

			if (params.text) {
				await runtime.client.exec(["pane", "send-text", resolved.pane.pane_id, params.text], runtime.signal);
			}
			if (params.keys) {
				const keys = params.keys.split(/\s+/).filter(Boolean);
				await runtime.client.exec(["pane", "send-keys", resolved.pane.pane_id, ...keys], runtime.signal);
			}

			const desc = [params.text && `"${params.text}"`, params.keys].filter(Boolean).join(" + ");
			return {
				content: [{ type: "text", text: `Sent ${desc} to pane '${resolved.alias || paneRef}'` }],
				details: runtime.withSnapshot({
					action: HERDR_ACTION.SEND,
					pane: resolved.alias || paneRef,
					paneId: resolved.pane.pane_id,
					text: params.text,
					keys: params.keys,
				}),
			};
		}

		case HERDR_ACTION.STOP: {
			rejectUnexpectedParams("stop", params, ["workspace", "tab"]);
			const paneRef = params.pane;
			if (!paneRef) throw new Error("'pane' is required for stop");

			const resolved = await runtime.requirePaneRef(paneRef);
			if (resolved.pane.pane_id === runtime.currentPaneId) {
				throw new Error("Refusing to close the pane pi is running in.");
			}

			await runtime.client.exec(["pane", "close", resolved.pane.pane_id], runtime.signal);
			if (resolved.alias) runtime.aliasStore.forgetAlias(resolved.alias);

			return {
				content: [{ type: "text", text: `Closed pane '${resolved.alias || paneRef}'` }],
				details: runtime.withSnapshot({
					action: HERDR_ACTION.STOP,
					pane: resolved.alias || paneRef,
					paneId: resolved.pane.pane_id,
				}),
			};
		}

		default:
			return undefined;
	}
}

function validateRunParams(params: HerdrToolInput): void {
	if (!params.detached) return;
	const incompatible = [
		params.timeout != null && "timeout",
		params.lines != null && "lines",
		params.source != null && "source",
		params.raw === true && "raw",
		params.compression != null && "compression",
		params.maxTokens != null && "maxTokens",
	].filter(Boolean);
	if (incompatible.length) {
		throw new Error(`detached run does not capture output; remove ${incompatible.join(", ")}.`);
	}
}

async function reduceRunOutput(
	output: string,
	params: HerdrToolInput,
	runtime: HerdrActionRuntime,
): Promise<{ text: string; compressed: boolean; fallback?: string }> {
	const compression: CompressionMode = params.raw
		? COMPRESSION_MODE.NEVER
		: params.compression ?? COMPRESSION_MODE.AUTO;
	const shouldCompress = compression === COMPRESSION_MODE.ALWAYS ||
		(compression === COMPRESSION_MODE.AUTO && shouldAutoCompress(output));
	if (!shouldCompress) {
		return { text: formatReadOutput(output), compressed: false };
	}

	try {
		const compressed = await runtime.client.compressShellOutput(
			output,
			{ maxTokens: params.maxTokens },
			runtime.signal,
		);
		return { text: formatReadOutput(compressed), compressed: true };
	} catch (error) {
		if (isAbortError(error, runtime.signal)) throw error;
		const fallback = error instanceof Error ? error.message : String(error);
		return {
			text: formatReadOutput(output),
			compressed: false,
			fallback: `Hypa compression unavailable; returned raw output (${fallback})`,
		};
	}
}
