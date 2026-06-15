import * as p from "@clack/prompts"
import { dim, green, red } from "kolorist"
import { copyToClipboard } from "../services/clipboard.js"
import type { HookError } from "../services/hooks.js"
import { debug } from "../utils/debug.js"

const MAX_TSC_DIAGNOSTICS = 3
const MAX_ESLINT_DIAGNOSTICS = 3
const MAX_SUMMARY_LINE_LENGTH = 120
const TSC_DIAGNOSTIC =
	/^(.+?\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/
// ESLint stylish format: <whitespace><line>:<col>  <severity>  <message>  <rule>
const ESLINT_ERROR_LINE = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+)\s{2,}(\S+)\s*$/

interface TscDiagnostic {
	file: string
	line: string
	column: string
	code: string
	message: string
}

interface EslintDiagnostic {
	file: string
	line: string
	column: string
	severity: string
	message: string
	rule: string
}

function formatCheckFailureSummary(errors: HookError[]): string {
	if (errors.length === 0) {
		return "No check error details were parsed. View full output for details."
	}

	return errors.map((error) => formatCheckErrorSummary(error)).join("\n")
}

function formatCheckErrorSummary(error: HookError): string {
	if (error.tool === "tsc") {
		const diagnostics = extractTscDiagnostics(error.raw || error.message)
		if (diagnostics.length > 0) {
			return formatTscSummary(diagnostics)
		}
	}

	if (error.tool === "eslint") {
		const diagnostics = extractEslintDiagnostics(error.raw || error.message)
		if (diagnostics.length > 0) {
			return formatEslintSummary(diagnostics)
		}
	}

	const message = firstMeaningfulLine(error.message || error.raw)
	return `  ${red("•")} [${error.tool}] ${truncate(message, MAX_SUMMARY_LINE_LENGTH)}`
}

function extractTscDiagnostics(raw: string): TscDiagnostic[] {
	return raw
		.split("\n")
		.map((line) => line.trim())
		.map((line) => {
			const match = TSC_DIAGNOSTIC.exec(line)
			if (!match) return null
			return {
				file: match[1] ?? "",
				line: match[2] ?? "",
				column: match[3] ?? "",
				code: match[4] ?? "",
				message: match[5] ?? "",
			}
		})
		.filter((diagnostic): diagnostic is TscDiagnostic => diagnostic !== null)
}

function formatTscSummary(diagnostics: TscDiagnostic[]): string {
	const visible = diagnostics.slice(0, MAX_TSC_DIAGNOSTICS)
	const hidden = diagnostics.length - visible.length
	const lines = [
		`  ${red("•")} [tsc] ${diagnostics.length} TypeScript error${diagnostics.length !== 1 ? "s" : ""}`,
		...visible.map(
			(diagnostic) =>
				`${diagnostic.file}:${diagnostic.line}:${diagnostic.column} — error ${diagnostic.code}: ${truncate(diagnostic.message, MAX_SUMMARY_LINE_LENGTH)}`,
		),
	]

	if (hidden > 0) {
		lines.push(
			dim(
				`    +${hidden} more TypeScript error${hidden !== 1 ? "s" : ""}. View full output for details.`,
			),
		)
	}

	return lines.join("\n")
}

function extractEslintDiagnostics(raw: string): EslintDiagnostic[] {
	const diagnostics: EslintDiagnostic[] = []
	const lines = raw.split("\n")
	let currentFile = ""

	for (const line of lines) {
		// File path line: not indented, contains a path separator, not an error detail line
		if (!/^\s/.test(line) && line.includes("/") && !ESLINT_ERROR_LINE.test(line)) {
			currentFile = line.trim()
			continue
		}

		const match = ESLINT_ERROR_LINE.exec(line)
		if (match) {
			diagnostics.push({
				file: currentFile || "unknown",
				line: match[1] ?? "",
				column: match[2] ?? "",
				severity: match[3] ?? "",
				message: (match[4] ?? "").trim(),
				rule: match[5] ?? "",
			})
		}
	}

	return diagnostics
}

function formatEslintSummary(diagnostics: EslintDiagnostic[]): string {
	const visible = diagnostics.slice(0, MAX_ESLINT_DIAGNOSTICS)
	const hidden = diagnostics.length - visible.length
	const count = diagnostics.length
	const noun = count === 1 ? "problem" : "problems"
	const lines = [
		`  ${red("•")} [eslint] ${count} ESLint ${noun}`,
		...visible.map(
			(diagnostic) =>
				`${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity} ${diagnostic.rule} — ${truncate(diagnostic.message, MAX_SUMMARY_LINE_LENGTH)}`,
		),
	]

	if (hidden > 0) {
		lines.push(
			dim(
				`    +${hidden} more ESLint ${hidden === 1 ? "problem" : "problems"}. View full output for details.`,
			),
		)
	}

	return lines.join("\n")
}

function firstMeaningfulLine(message: string): string {
	const line = message
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0 && !l.startsWith(">") && !l.startsWith("ELIFECYCLE"))
	return line ?? message
}

function truncate(message: string, maxLength: number): string {
	const collapsed = message.replace(/\s+/g, " ").trim()
	if (collapsed.length <= maxLength) return collapsed
	return `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Check failure menu with retry option
export async function showCheckFailureMenu(
	errors: HookError[],
	rawStderr: string,
	onRetry?: () => Promise<boolean>,
): Promise<"skipped" | "cancelled" | "retried"> {
	debug("showCheckFailureMenu: %d errors", errors.length)

	let clipboardCopied = false

	p.note(formatCheckFailureSummary(errors), red("Pre-commit check failed"))

	while (true) {
		const choice = await p.select({
			message: "What do you want to do?",
			options: [
				{
					label: clipboardCopied
						? `${green("✓")} Copy error report to clipboard`
						: "Copy error report to clipboard",
					value: "copy",
				},
				{
					label: "View full error output",
					value: "view",
					hint: "Show the raw stderr from checks",
				},
				{
					label: "Retry checks",
					value: "retry",
					hint: "Re-run checks after fixing errors",
				},
				{
					label: "Skip checks and commit",
					value: "skip",
				},
				{
					label: "Cancel",
					value: "cancel",
				},
			],
		})

		if (p.isCancel(choice)) {
			debug("showCheckFailureMenu: user cancelled")
			return "cancelled"
		}

		debug("showCheckFailureMenu: user chose %s", choice)

		switch (choice) {
			case "copy": {
				const ok = await copyToClipboard(rawStderr)
				if (ok) {
					clipboardCopied = true
					p.log.step(green("Copied to clipboard."))
				} else {
					p.log.warn(red("No clipboard tool found. Install xclip, wl-copy, or xsel."))
				}
				continue
			}
			case "view": {
				p.note(rawStderr.trim() || "(no raw output)", "Full error output")
				continue
			}
			case "retry": {
				if (onRetry) {
					return "retried"
				}
				// No retry callback — return retried so caller can handle the loop
				return "retried"
			}
			case "skip": {
				p.log.info("Skipping checks and proceeding with commit...")
				return "skipped"
			}
			case "cancel": {
				p.outro(dim("Cancelled."))
				return "cancelled"
			}
		}
	}
}
