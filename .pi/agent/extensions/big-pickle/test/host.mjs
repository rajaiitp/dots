import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SDK_NAME = "@earendil-works/pi-coding-agent";
export const extensionRoot = fileURLToPath(new URL("..", import.meta.url));

function packageRoot(file, name) {
	let directory = dirname(realpathSync(file));
	for (;;) {
		const manifest = join(directory, "package.json");
		if (
			existsSync(manifest) &&
			JSON.parse(readFileSync(manifest, "utf8")).name === name
		)
			return directory;
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

function findSdk() {
	try {
		const local = createRequire(import.meta.url).resolve(SDK_NAME);
		const root = packageRoot(local, SDK_NAME);
		if (root) return root;
	} catch (error) {
		if (
			error.code !== "MODULE_NOT_FOUND" &&
			error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED"
		)
			throw error;
	}
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		const binary = resolve(directory, "pi");
		if (!existsSync(binary)) continue;
		const root = packageRoot(binary, SDK_NAME);
		if (root) return root;
	}
	throw new Error(
		"Tests require an installed Pi SDK, locally or through pi on PATH.",
	);
}

export const sdkRoot = findSdk();
export const hostRequire = createRequire(join(sdkRoot, "package.json"));
const aiManifest = (hostRequire.resolve.paths("@earendil-works/pi-ai") ?? [])
	.map((directory) => join(directory, "@earendil-works/pi-ai/package.json"))
	.find((file) => existsSync(file));
export const aiRoot = aiManifest
	? packageRoot(aiManifest, "@earendil-works/pi-ai")
	: undefined;
if (!aiRoot)
	throw new Error("Cannot locate Pi AI alongside the installed Pi SDK.");
export const compatPath = join(aiRoot, "dist", "compat.js");
const { createJiti } = hostRequire("jiti");

export function loader() {
	return createJiti(import.meta.url, {
		moduleCache: false,
		alias: { "@earendil-works/pi-ai/compat": compatPath },
	});
}

export async function loadProvider() {
	const factory = await loader().import(join(extensionRoot, "index.ts"), {
		default: true,
	});
	let providerId;
	let config;
	const handlers = new Map();
	factory({
		on(event, handler) {
			handlers.set(event, handler);
			return () => {};
		},
		registerProvider(id, value) {
			providerId = id;
			config = value;
		},
	});
	return {
		providerId,
		config,
		handlers,
		model: {
			...config.models[0],
			type: "chat",
			provider: providerId,
			api: config.api,
			baseUrl: config.baseUrl,
		},
	};
}

export async function validateToolCall(tools, call) {
	const validation = await import(
		pathToFileURL(join(aiRoot, "dist", "utils", "validation.js")).href
	);
	return validation.validateToolCall(tools, call);
}
