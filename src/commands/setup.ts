import { access, constants, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { bold, dim, green, yellow } from "kolorist";
import { debug } from "../utils/debug.js";

/** Marker files for each tool. First match wins per tool. */
const TOOL_MARKERS: Record<ToolName, readonly string[]> = {
	biome: ["biome.json", "biome.jsonc"],
	eslint: [
		"eslint.config.js",
		"eslint.config.mjs",
		"eslint.config.ts",
		"eslint.config.cjs",
		".eslintrc.js",
		".eslintrc.cjs",
		".eslintrc.json",
		".eslintrc.yml",
		".eslintrc.yaml",
		".eslintrc",
	],
	typescript: ["tsconfig.json"],
	vitest: ["vitest.config.js", "vitest.config.mts", "vitest.config.ts", "vitest.config.mjs"],
} as const;

export type ToolName = "biome" | "eslint" | "typescript" | "vitest";

export type DetectedTools = Record<ToolName, boolean>;

/** Indent for generated config — matches biome.json `indentStyle: "tab"`. */
const TAB = "\t";

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Scan a directory for marker files that indicate which tools the project uses.
 * Returns a map of tool name to detected status. Order within each tool's list
 * is priority order (first match wins).
 */
export async function detectTools(cwd: string): Promise<DetectedTools> {
	const result: DetectedTools = { biome: false, eslint: false, typescript: false, vitest: false };
	for (const [tool, files] of Object.entries(TOOL_MARKERS) as [ToolName, readonly string[]][]) {
		for (const file of files) {
			if (await exists(join(cwd, file))) {
				result[tool] = true;
				debug("setup: detected %s via %s", tool, file);
				break;
			}
		}
	}
	debug("setup: detection result %o", result);
	return result;
}

/**
 * Build the string content of a .cmintrc file from a detection result.
 * Returns tabs-indented TS/JS object literal with trailing commas. Biome is
 * preferred when both biome and eslint are present — overlapping globs would
 * cause both tools to run on the same files, which is wasteful and noisy.
 */
export function buildCmintrcContent(tools: DetectedTools): string {
	const entries: string[] = [];

	const linter = tools.biome || tools.eslint;
	if (linter) {
		const cmd = tools.biome
			? "biome check --write --no-errors-on-unmatched --error-on-warnings"
			: "eslint --fix";
		const ext = tools.biome ? "{js,ts,json}" : "{js,ts}";
		entries.push(`${TAB}"*.${ext}": "${cmd}",`);
	}

	const tsChecks: string[] = [];
	if (tools.typescript) tsChecks.push("tsc --noEmit");
	if (tools.vitest) tsChecks.push("vitest run --passWithNoTests");
	if (tsChecks.length > 0) {
		const body = tsChecks.map((c) => `"${c}"`).join(", ");
		const fn = tsChecks.length === 1 ? `() => ${body}` : `() => [${body}]`;
		entries.push(`${TAB}"*.ts": ${fn},`);
	}

	if (entries.length === 0) {
		return `export default {\n};\n`;
	}

	return `export default {\n${entries.join("\n")}\n};\n`;
}

/** Choose the file extension based on whether the project uses TypeScript. */
export function pickFileName(tools: DetectedTools): string {
	return tools.typescript ? ".cmintrc.ts" : ".cmintrc";
}

function formatDetection(tools: DetectedTools): string {
	return (Object.entries(tools) as [ToolName, boolean][])
		.map(([tool, found]) => `  ${found ? green("✓") : dim("✗")} ${tool}`)
		.join("\n");
}

/**
 * Interactive setup for `.cmintrc`. Detects biome/eslint/typescript/vitest in
 * the current working directory, previews the generated config, and writes
 * the file after confirmation. Refuses to overwrite without explicit consent.
 */
export async function setupCmintrcCommand(): Promise<void> {
	debug("setupCmintrcCommand: starting");
	const cwd = process.cwd();
	const tools = await detectTools(cwd);

	p.log.info(`Detected tools in ${bold(cwd)}:`);
	p.log.message(formatDetection(tools));

	const foundAny = Object.values(tools).some(Boolean);
	if (!foundAny) {
		p.log.warn("No recognized tools found. Writing an empty config to fill in manually.");
	} else if (tools.biome && tools.eslint) {
		p.log.warn(
			yellow("Both biome and eslint detected — using biome (remove this line to switch)."),
		);
	}

	const fileName = pickFileName(tools);
	const filePath = join(cwd, fileName);

	if (await exists(filePath)) {
		const overwrite = await p.confirm({
			message: `${fileName} already exists. Overwrite?`,
		});
		if (p.isCancel(overwrite) || !overwrite) {
			p.log.info(dim("Cancelled — existing file left untouched."));
			return;
		}
	}

	const content = buildCmintrcContent(tools);
	p.log.info(dim(`\nPreview of ${fileName}:`));
	p.log.message(dim(content));

	const confirm = await p.confirm({
		message: `Write ${fileName}?`,
	});
	if (p.isCancel(confirm) || !confirm) {
		p.log.info(dim("Cancelled."));
		return;
	}

	await writeFile(filePath, content, "utf-8");
	debug("setupCmintrcCommand: wrote %s", filePath);
	p.log.success(green(`Wrote ${fileName}`));
}
