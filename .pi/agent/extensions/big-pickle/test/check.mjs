import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { aiRoot, extensionRoot, hostRequire, sdkRoot } from "./host.mjs";

const directory = mkdtempSync(join(tmpdir(), "big-pickle-check-"));
try {
	execFileSync(
		"npm",
		[
			"exec",
			"--yes",
			"--package",
			"@biomejs/biome@2.6.4",
			"--",
			"biome",
			"check",
			".",
		],
		{ cwd: extensionRoot, stdio: "inherit" },
	);
	const config = join(directory, "tsconfig.json");
	writeFileSync(
		config,
		JSON.stringify({
			compilerOptions: {
				target: "ES2023",
				module: "ESNext",
				moduleResolution: "Bundler",
				strict: true,
				noEmit: true,
				skipLibCheck: true,
				allowImportingTsExtensions: true,
				lib: ["ES2023", "DOM", "DOM.Iterable"],
				types: ["node"],
				typeRoots: [
					dirname(dirname(hostRequire.resolve("@types/node/package.json"))),
				],
				paths: {
					"@earendil-works/pi-ai/compat": [join(aiRoot, "dist", "compat.d.ts")],
					"@earendil-works/pi-coding-agent": [
						join(sdkRoot, "dist", "index.d.ts"),
					],
				},
			},
			files: [
				join(extensionRoot, "index.ts"),
				join(extensionRoot, "runtime.ts"),
				join(extensionRoot, "models.ts"),
				join(extensionRoot, "test", "fixtures", "tool-guard.ts"),
				join(extensionRoot, "test", "fixtures", "text-guard.ts"),
			],
		}),
	);
	execFileSync(
		"npm",
		[
			"exec",
			"--yes",
			"--package",
			"typescript@5.9.3",
			"--",
			"tsc",
			"--project",
			config,
		],
		{ cwd: extensionRoot, stdio: "inherit" },
	);
} finally {
	rmSync(directory, { recursive: true, force: true });
}
