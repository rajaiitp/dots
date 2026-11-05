import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import {
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

type ReadonlySessionManager = ExtensionContext["sessionManager"];

export const SHORT_ID_LENGTH = 8;
export const PREFILL_SESSION_ENV = "PI_FORK_PANE_PREFILL_SESSION";
const PREFILL_ENTRY = "fork-pane-editor";

export function forkMessages(source: ReadonlySessionManager) {
	return source.getEntries().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "user") return [];
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("");
		return text ? [{ id: entry.id, text }] : [];
	});
}

export function prepareFork(source: ReadonlySessionManager, entryId: string) {
	const header = source.getHeader();
	const selected = source.getEntry(entryId);
	if (!header || !source.getSessionFile())
		throw new Error("/fork-pane requires a saved session.");
	if (selected?.type !== "message" || selected.message.role !== "user")
		throw new Error("Select a user message to fork.");
	const text =
		forkMessages(source).find((message) => message.id === entryId)?.text ?? "";
	const fork = selected.parentId
		? SessionManager.inMemory(source.getCwd(), undefined, [
				header,
				...source.getEntries(),
			])
		: SessionManager.inMemory(source.getCwd());
	if (selected.parentId) fork.createBranchedSession(selected.parentId);
	fork.appendCustomEntry(PREFILL_ENTRY, { text });
	const forkHeader = fork.getHeader();
	if (!forkHeader) throw new Error("Fork session has no header.");
	return {
		id: fork.getSessionId(),
		header: { ...forkHeader, parentSession: source.getSessionFile() },
		entries: fork.getEntries(),
	};
}

export async function saveFork(
	source: ReadonlySessionManager,
	entryId: string,
) {
	const fork = prepareFork(source, entryId);
	const directory = source.getSessionDir();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const timestamp = fork.header.timestamp.replace(/[:.]/g, "-");
	const path = join(directory, `${timestamp}_${fork.id}.jsonl`);
	const file = await open(path, "wx", 0o600);
	try {
		await file.writeFile(
			`${[fork.header, ...fork.entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
		await file.sync();
	} finally {
		await file.close();
	}
	return { path, id: fork.id };
}

export function prefillText(source: ReadonlySessionManager): string {
	const entry = source
		.getBranch()
		.findLast(
			(item) => item.type === "custom" && item.customType === PREFILL_ENTRY,
		);
	if (
		entry?.type !== "custom" ||
		typeof entry.data !== "object" ||
		entry.data === null ||
		!("text" in entry.data) ||
		typeof entry.data.text !== "string"
	)
		throw new Error("Fork editor text is missing.");
	return entry.data.text;
}
