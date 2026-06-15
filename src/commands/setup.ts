import { access, constants, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as p from "@clack/prompts"
import { bold, dim, green, yellow } from "kolorist"
import { detectConfig } from "../services/checks.js"
import { debug } from "../utils/debug.js"

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
} as const

export type ToolName = "biome" | "eslint" | "typescript" | "vitest"

export type DetectedTools = Record<ToolName, boolean>

/** Indent for generated config — matches biome.json `indentStyle: "tab"`. */
const TAB = "\t"

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.R_OK)
		return true
	} catch {
		return false
	}
}

/**
 * Scan a directory for marker files that indicate which tools the project uses.
 * Returns a map of tool name to detected status. Order within each tool's list
 * is priority order (first match wins).
 */
export async function detectTools(cwd: string): Promise<DetectedTools> {
	const result: DetectedTools = { biome: false, eslint: false, typescript: false, vitest: false }
	for (const [tool, files] of Object.entries(TOOL_MARKERS) as [ToolName, readonly string[]][]) {
		for (const file of files) {
			if (await exists(join(cwd, file))) {
				result[tool] = true
				debug("setup: detected %s via %s", tool, file)
				break
			}
		}
	}
	debug("setup: detection result %o", result)
	return result
}

/**
 * Build the string content of a .cmintrc file from a detection result.
 * Returns tabs-indented TS/JS object literal with trailing commas. Biome is
 * preferred when both biome and eslint are present — overlapping globs would
 * cause both tools to run on the same files, which is wasteful and noisy.
 */
export function buildCmintrcContent(tools: DetectedTools): string {
	const entries: string[] = []

	const linter = tools.biome || tools.eslint
	if (linter) {
		const cmd = tools.biome
			? "biome check --write --no-errors-on-unmatched --error-on-warnings"
			: "eslint --fix"
		const ext = tools.biome ? "{js,ts,json}" : "{js,ts}"
		entries.push(`${TAB}"*.${ext}": "${cmd}",`)
	}

	const tsChecks: string[] = []
	if (tools.typescript) tsChecks.push("tsc --noEmit")
	if (tools.vitest) tsChecks.push("vitest run --passWithNoTests")
	if (tsChecks.length > 0) {
		const body = tsChecks.map((c) => `"${c}"`).join(", ")
		const fn = tsChecks.length === 1 ? `() => ${body}` : `() => [${body}]`
		entries.push(`${TAB}"*.ts": ${fn},`)
	}

	if (entries.length === 0) {
		return `export default {\n};\n`
	}

	return `export default {\n${entries.join("\n")}\n};\n`
}

/** Choose the file extension based on whether the project uses TypeScript. */
export function pickFileName(tools: DetectedTools): string {
	return tools.typescript ? ".cmintrc.ts" : ".cmintrc"
}

function formatDetection(tools: DetectedTools): string {
	return (Object.entries(tools) as [ToolName, boolean][])
		.map(([tool, found]) => `  ${found ? green("✓") : dim("✗")} ${tool}`)
		.join("\n")
}

/**
 * Interactive setup for `.cmintrc`. Detects biome/eslint/typescript/vitest in
 * the given directory, previews the generated config, and writes the file
 * after confirmation. Refuses to overwrite without explicit consent. Defaults
 * to `process.cwd()` when called from the `cmint config` menu; the preflight
 * caller passes the repo root explicitly.
 */
export async function setupCmintrcCommand(cwd: string = process.cwd()): Promise<void> {
	debug("setupCmintrcCommand: starting in %s", cwd)
	const tools = await detectTools(cwd)

	p.log.info(`Detected tools in ${bold(cwd)}:`)
	p.log.message(formatDetection(tools))

	const foundAny = Object.values(tools).some(Boolean)
	if (!foundAny) {
		p.log.warn("No recognized tools found. Writing an empty config to fill in manually.")
	} else if (tools.biome && tools.eslint) {
		p.log.warn(yellow("Both biome and eslint detected — using biome (remove this line to switch)."))
	}

	const fileName = pickFileName(tools)
	const filePath = join(cwd, fileName)

	if (await exists(filePath)) {
		const overwrite = await p.confirm({
			message: `${fileName} already exists. Overwrite?`,
		})
		if (p.isCancel(overwrite) || !overwrite) {
			p.log.info(dim("Cancelled — existing file left untouched."))
			return
		}
	}

	const content = buildCmintrcContent(tools)
	p.log.info(dim(`\nPreview of ${fileName}:`))
	p.log.message(dim(content))

	const confirm = await p.confirm({
		message: `Write ${fileName}?`,
	})
	if (p.isCancel(confirm) || !confirm) {
		p.log.info(dim("Cancelled."))
		return
	}

	await writeFile(filePath, content, "utf-8")
	debug("setupCmintrcCommand: wrote %s", filePath)
	p.log.success(green(`Wrote ${fileName}`))
}

// ── Preflight prompt ──────────────────────────────────────────────────────

/** Project-local marker file that suppresses the preflight prompt forever. */
export const SKIP_SETUP_MARKER = ".cmint-skip-setup"

/** True if at least one of biome/eslint/typescript/vitest is present. */
export function isAutoConfigurable(tools: DetectedTools): boolean {
	return Object.values(tools).some(Boolean)
}

/** True if the skip-setup marker exists in `cwd`. */
export async function hasSkipSetupMarker(cwd: string): Promise<boolean> {
	return exists(join(cwd, SKIP_SETUP_MARKER))
}

/** Write the skip-setup marker to `cwd`. The file is empty by design. */
export async function writeSkipSetupMarker(cwd: string): Promise<void> {
	const filePath = join(cwd, SKIP_SETUP_MARKER)
	await writeFile(filePath, "", "utf-8")
	debug("preflight: wrote skip-setup marker to %s", filePath)
}

/**
 * One-shot prompt run at the start of `cmint`. Skips silently if the user
 * already has a `.cmintrc` or has previously opted out (`.cmint-skip-setup`).
 * If the project is auto-configurable, asks the user whether to run setup
 * now. Choices: `yes` runs the standard setup flow; `no` proceeds without
 * setup and re-prompts next time; `never` writes a marker to suppress the
 * prompt for this project forever.
 */
export async function runPreflightSetupPrompt(cwd: string): Promise<void> {
	debug("preflight: checking %s", cwd)

	if (await hasSkipSetupMarker(cwd)) {
		debug("preflight: skip-setup marker present, skipping prompt")
		return
	}

	const existingConfig = await detectConfig(cwd)
	if (existingConfig) {
		debug("preflight: .cmintrc present at %s, skipping prompt", existingConfig)
		return
	}

	const tools = await detectTools(cwd)
	if (!isAutoConfigurable(tools)) {
		debug("preflight: project not auto-configurable, skipping prompt")
		return
	}

	const choice = await p.select({
		message: "No .cmintrc found. Run setup to create one from detected tools?",
		options: [
			{ label: "Yes, set up .cmintrc", value: "yes" },
			{ label: "No, skip for now", value: "no" },
			{ label: "No, don't ask again", value: "never" },
		],
	})

	if (p.isCancel(choice)) {
		debug("preflight: user cancelled prompt")
		return
	}

	if (choice === "never") {
		await writeSkipSetupMarker(cwd)
		p.log.info(dim(`Won't ask again. Delete ${SKIP_SETUP_MARKER} to re-enable.`))
		return
	}

	if (choice === "no") {
		p.log.info(dim("Skipping .cmintrc setup."))
		return
	}

	// "yes" — run the standard setup flow (with its own confirmations).
	debug("preflight: user chose yes, running setup")
	await setupCmintrcCommand(cwd)
}
