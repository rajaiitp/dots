import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostRequire, sdkRoot } from "../big-pickle/test/host.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const extension = join(directory, "..", "branch-workspace.ts");
const temporary = mkdtempSync(join(tmpdir(), "pi-handoff-check-"));
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
			extension,
			directory,
			join(directory, "..", "tuios"),
		],
		{ stdio: "inherit" },
	);
	const config = join(temporary, "tsconfig.json");
	writeFileSync(
		config,
		JSON.stringify({
			compilerOptions: {
				target: "ES2023",
				module: "ESNext",
				moduleResolution: "Bundler",
				strict: true,
				noUnusedLocals: true,
				noUnusedParameters: true,
				noEmit: true,
				skipLibCheck: true,
				allowImportingTsExtensions: true,
				lib: ["ES2023", "DOM", "DOM.Iterable"],
				types: ["node"],
				typeRoots: [
					dirname(dirname(hostRequire.resolve("@types/node/package.json"))),
				],
				paths: {
					"@earendil-works/pi-coding-agent": [
						join(sdkRoot, "dist", "index.d.ts"),
					],
					"@earendil-works/pi-tui": [
						join(
							dirname(hostRequire.resolve("@earendil-works/pi-tui")),
							"index.d.ts",
						),
					],
					typebox: [hostRequire.resolve("typebox").replace(/\.mjs$/, ".d.mts")],
				},
			},
			files: [
				extension,
				join(directory, "handoff.ts"),
				join(directory, "..", "tuios", "index.ts"),
				join(directory, "..", "tuios", "runtime.ts"),
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
		{ stdio: "inherit" },
	);
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
