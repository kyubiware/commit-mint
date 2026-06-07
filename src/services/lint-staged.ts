import { access, constants, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { debug } from "../utils/debug.js";

const CONFIG_FILES = [
	".lintstagedrc",
	".lintstagedrc.json",
	".lintstagedrc.yaml",
	".lintstagedrc.yml",
	".lintstagedrc.mjs",
	".lintstagedrc.cjs",
	"lint-staged.config.mjs",
	"lint-staged.config.cjs",
	"lint-staged.config.js",
	"lint-staged.config.ts",
];

export async function hasLintStagedConfig(repoRoot: string): Promise<boolean> {
	debug("hasLintStagedConfig: checking in %s", repoRoot);

	// Check dedicated config files
	for (const file of CONFIG_FILES) {
		const path = join(repoRoot, file);
		try {
			await access(path, constants.F_OK);
			debug("hasLintStagedConfig: found %s", file);
			return true;
		} catch {
			// File doesn't exist, continue checking
		}
	}

	// Check package.json for "lint-staged" key
	const packageJsonPath = join(repoRoot, "package.json");
	try {
		const raw = await readFile(packageJsonPath, "utf8");
		const pkg = JSON.parse(raw) as Record<string, unknown>;
		if ("lint-staged" in pkg) {
			debug("hasLintStagedConfig: found lint-staged in package.json");
			return true;
		}
	} catch {
		// package.json doesn't exist or can't be parsed
	}

	debug("hasLintStagedConfig: no config found");
	return false;
}

export async function runLintStaged(): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	debug("runLintStaged: starting npx lint-staged");
	const { failed, stdout, stderr } = await execa("npx", ["lint-staged"], { reject: false });
	debug("runLintStaged: finished, failed=%s", failed);
	return { ok: !failed, stdout, stderr };
}
