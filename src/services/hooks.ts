import { debug } from "../utils/debug.js"

export interface HookError {
	tool: string
	message: string
	raw: string
}

/**
 * Parse git hook error output into structured, human-readable errors.
 * Handles output from lint-staged, biome, eslint, tsc, vitest, jest.
 */
export function parseHookErrors(stderr: string): HookError[] {
	if (!stderr) return []

	debug("parseHookErrors: stderr length=%d", stderr.length)
	const errors: HookError[] = []

	// Detect lint-staged task failures
	if (stderr.includes("lint-staged") || stderr.includes("[FAILED]")) {
		errors.push(...parseLintStagedErrors(stderr))
	}

	// Detect biome errors
	if (stderr.includes("biome") || stderr.includes("Biome")) {
		errors.push(...parseBiomeErrors(stderr))
	}

	// Detect TypeScript errors
	if (stderr.includes("error TS") || stderr.includes("tsc")) {
		errors.push(...parseTscErrors(stderr))
	}

	// Detect vitest/jest test failures
	if (
		stderr.includes("vitest") ||
		stderr.includes("jest") ||
		stderr.includes("FAIL") ||
		stderr.includes("test failed")
	) {
		errors.push(...parseTestErrors(stderr))
	}

	// Detect ESLint errors
	if (stderr.includes("eslint") || stderr.includes("ESLint")) {
		errors.push(...parseEslintErrors(stderr))
	}

	// Fallback: if nothing parsed, return the raw output
	if (errors.length === 0) {
		debug("parseHookErrors: no patterns matched, using raw fallback")
		errors.push({
			tool: "git hooks",
			message: stderr.trim(),
			raw: stderr,
		})
	}

	debug("parseHookErrors: found %d errors", errors.length)
	return errors
}

function parseLintStagedErrors(output: string): HookError[] {
	const errors: HookError[] = []
	for (const match of output.matchAll(/\[FAILED\]\s+(.+?)\s+\[FAILED\]/g)) {
		const task = match[1].trim()
		errors.push({
			tool: "lint-staged",
			message: `Task failed: ${task}`,
			raw: match[0],
		})
	}

	return errors
}

function parseBiomeErrors(output: string): HookError[] {
	const errors: HookError[] = []
	for (const match of output.matchAll(/^(.+?):(\d+):(\d+)\s+(.+)$/gm)) {
		errors.push({
			tool: "biome",
			message: `${match[1]}:${match[2]}:${match[3]} — ${match[4]}`,
			raw: match[0],
		})
	}

	if (errors.length === 0 && output.includes("biome")) {
		errors.push({
			tool: "biome",
			message: "Biome check failed. See raw output for details.",
			raw: output,
		})
	}

	return errors
}

function parseTscErrors(output: string): HookError[] {
	const errors: HookError[] = []
	for (const match of output.matchAll(/^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm)) {
		errors.push({
			tool: "tsc",
			message: `${match[1]}:${match[2]}:${match[3]} — ${match[4]}: ${match[5]}`,
			raw: match[0],
		})
	}

	return errors
}

function parseTestErrors(output: string): HookError[] {
	const errors: HookError[] = []
	const failPattern = /FAIL\s+(.+\.(test|spec)\..+)/
	const match = failPattern.exec(output)

	if (match) {
		errors.push({
			tool: output.includes("vitest") ? "vitest" : "jest",
			message: `Test file failed: ${match[1]}`,
			raw: output,
		})
	}

	if (errors.length === 0 && (output.includes("vitest") || output.includes("jest"))) {
		errors.push({
			tool: output.includes("vitest") ? "vitest" : "jest",
			message: "Tests failed. See raw output for details.",
			raw: output,
		})
	}

	return errors
}

function parseEslintErrors(output: string): HookError[] {
	const errors: HookError[] = []
	const lines = output.split("\n")
	let currentFile = ""

	for (const line of lines) {
		// ESLint file path line: not indented, contains a path separator
		if (!/^\s/.test(line) && line.includes("/")) {
			currentFile = line.trim()
			continue
		}

		// ESLint error/warning detail: <line>:<col>  <severity>  <message>  <rule>
		// Message and rule are separated by 2+ spaces
		const match = line.match(/^\s*(\d+):(\d+)\s+(error|warning)\s+(.+)\s{2,}(\S+)\s*$/)
		if (match) {
			const [, lineNum, col, severity, message, rule] = match
			const file = currentFile || "unknown"
			errors.push({
				tool: "eslint",
				message: `${file}:${lineNum}:${col} ${severity}: ${message} (${rule})`,
				raw: line.trim(),
			})
		}
	}

	return errors
}

export function formatErrorReport(errors: HookError[]): string {
	if (errors.length === 0) return ""

	const sections = errors.map((e) => `[${e.tool}]\n${e.message}`)
	return sections.join("\n\n")
}

/**
 * Parse cmint check output into structured errors.
 * Check output uses [tool] prefix format (built by callers in auto-group.ts / staging.ts).
 * This is distinct from parseHookErrors which handles raw git hook stderr.
 */
export function parseCheckErrors(output: string): HookError[] {
	if (!output.trim()) return []

	const errors: HookError[] = []
	const lines = output.split("\n")

	let currentTool = ""
	let currentLines: string[] = []

	const flush = () => {
		if (currentTool && currentLines.length > 0) {
			const message = currentLines.join("\n").trim()
			if (message) {
				errors.push({ tool: currentTool, message, raw: currentLines.join("\n") })
			}
		}
		currentTool = ""
		currentLines = []
	}

	for (const line of lines) {
		const match = line.match(/^\[(\S+)\]\s*(.*)/)
		if (match) {
			// New [tool] block — flush previous
			flush()
			currentTool = match[1]
			const rest = match[2].trim()
			if (rest) {
				currentLines.push(rest)
			}
		} else if (currentTool) {
			// Continuation line for current [tool] block
			currentLines.push(line)
		} else {
			// No [tool] prefix — accumulate as raw
			currentLines.push(line)
		}
	}

	flush()

	// If no [tool] prefixed blocks found, fall back to single raw error
	if (errors.length === 0) {
		const trimmed = output.trim()
		if (trimmed) {
			errors.push({ tool: "checks", message: trimmed, raw: output })
		}
	}

	return errors
}

// ── Tool check parsing (success case) ──────────────────────────────

export interface ToolCheck {
	tool: string
	ok: boolean
}

/**
 * Parse lint-staged/hook stderr output to discover which tools ran
 * and whether they succeeded. Used for clean post-commit summary.
 */
export function parseToolChecks(stderr: string): ToolCheck[] {
	if (!stderr) return []

	const checks: ToolCheck[] = []
	// Match [COMPLETED] and [FAILED] status lines from lint-staged
	for (const match of stderr.matchAll(/\[(COMPLETED|FAILED)\]\s+(.+)/g)) {
		const status = match[1]
		const command = match[2].trim()

		if (isLintStagedMeta(command)) continue

		const tool = extractToolName(command)
		if (!tool) continue

		checks.push({ tool, ok: status === "COMPLETED" })
	}

	// Deduplicate by tool name (keep last occurrence — final status)
	const seen = new Map<string, ToolCheck>()
	for (const c of checks) {
		seen.set(c.tool, c)
	}

	return [...seen.values()]
}

/** Heuristic: skip lint-staged internal metadata lines */
export function isLintStagedMeta(command: string): boolean {
	// Glob patterns in task labels
	if (/[*{}[\]]/.test(command)) return true
	// Task count labels: "src/ — 3 files", "src/ — no files"
	// The dash can be em-dash (—), en-dash (–), or plain hyphen (-)
	if (/\s[-–—]\s(\d+\s)?files?$/.test(command)) return true
	if (/\s[-–—]\sno\s files$/.test(command)) return true
	// Internal lint-staged lifecycle messages
	if (
		/^(Running tasks|Applying modifications|Cleaning up|Backing up|Backed up|Updating Git)/.test(
			command,
		)
	)
		return true
	// Ends with ellipsis (e.g. "Backing up original state...")
	if (/\.{3}$/.test(command)) return true
	return false
}

/** Extract a display-friendly tool name from a lint-staged command */
export function extractToolName(command: string): string | null {
	// Step 1: Unwrap sh -c '...' wrapper
	const unwrapped = unwrapShC(command)
	if (unwrapped !== null) command = unwrapped

	// Step 2: Find the meaningful command in a && chain (skip cd segments)
	command = findMeaningfulCommand(command)

	return parseToolFromTokens(command.split(/\s+/))
}

/** Map common script names to their underlying tool */
const SCRIPT_MAP: Record<string, string> = {
	typecheck: "tsc",
	lint: "eslint",
	format: "prettier",
}

/** Package managers that use [run|exec] <script|tool> pattern */
const PKG_MANAGERS = ["npm", "yarn", "pnpm", "bun"]

/** Parse tool name from a tokenized command */
function parseToolFromTokens(tokens: string[]): string | null {
	const first = tokens[0]

	// Safety: don't return the shell itself as a tool name
	if (first === "sh" || first === "bash" || first === "zsh") return null

	// npm/yarn/pnpm/bun [run|exec] <script/tool>
	if (PKG_MANAGERS.includes(first)) {
		return parsePackageManagerTool(tokens)
	}

	// npx <tool>
	if (first === "npx") return tokens[1] ?? null

	// uv run <tool> / uv tool run <tool>
	if (first === "uv") return parseUvTool(tokens)

	// Direct tool invocation (biome, eslint, tsc, vitest, jest, prettier)
	return first
}

/** Extract tool name from npm/yarn/pnpm/bun commands */
function parsePackageManagerTool(tokens: string[]): string | null {
	const sub = tokens[1]
	// pnpm exec <tool>
	if (sub === "exec") return tokens[2] ?? null
	// npm/yarn/pnpm [run] <script>
	const scriptIdx = sub === "run" ? 2 : 1
	const script = tokens[scriptIdx]
	if (!script) return null
	return SCRIPT_MAP[script] ?? script
}

/** Extract tool name from uv commands */
function parseUvTool(tokens: string[]): string | null {
	if (tokens[1] === "run") return tokens[2] ?? null
	if (tokens[1] === "tool" && tokens[2] === "run") return tokens[3] ?? null
	return null
}

/** Unwrap sh -c 'command' or sh -c "command" wrappers */
function unwrapShC(command: string): string | null {
	// sh/bash -c 'body' or sh/bash -c "body"
	const quoted = command.match(/^(?:sh|bash|zsh)\s+-c\s+(['"])([\s\S]*)\1$/)
	if (quoted) return quoted[2]
	// sh/bash -c body (no quotes, single word — rare)
	const bare = command.match(/^(?:sh|bash|zsh)\s+-c\s+(\S+)$/)
	if (bare) return bare[1]
	return null
}

/** Find the meaningful command in a && chain, skipping cd segments */
function findMeaningfulCommand(command: string): string {
	const segments = command
		.split(/\s*&&\s*/)
		.map((s) => s.trim())
		.filter(Boolean)
	for (const seg of segments) {
		if (/^cd\s/.test(seg)) continue
		return seg
	}
	return segments[segments.length - 1] || command
}
