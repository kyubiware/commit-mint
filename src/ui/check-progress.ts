import { dim, green, red } from "kolorist"
import type { CheckObserver, CheckResult } from "../services/checks.js"

interface ProgressItem {
	tool: string
	description: string
	status: "running" | "passed" | "failed"
}

function iconFor(status: ProgressItem["status"]): string {
	return status === "passed" ? green("✓") : status === "failed" ? red("✗") : dim("◌")
}

/** Print the live progress lines and move cursor back for next update. */
function render(items: ProgressItem[], rendered: boolean, isTTY: boolean): boolean {
	if (rendered && isTTY) {
		process.stdout.write(`\x1B[${items.length + 1}A\x1B[J`)
	} else if (rendered) {
		return true // non-TTY: skip in-place update
	}
	process.stdout.write(`◇ Running checks…\n`)
	for (const item of items) {
		process.stdout.write(`  ${iconFor(item.status)} ${item.description}\n`)
	}
	return true
}

/** Print the final summary after all checks complete. */
function renderSummary(items: ProgressItem[]): { passed: number; failed: number } {
	const passed = items.filter((i) => i.status === "passed").length
	const failed = items.filter((i) => i.status === "failed").length
	const total = items.length
	if (failed === 0) {
		process.stdout.write(`Checks: ${green(`all ${total} passed`)}\n`)
	} else {
		process.stdout.write(`Checks: ${green(`${passed} passed`)}, ${red(`${failed} failed`)}\n`)
	}
	for (const item of items) {
		process.stdout.write(`  ${iconFor(item.status)} ${item.description}\n`)
	}
	return { passed, failed }
}

/**
 * Creates a live-updating check progress display that shows each check
 * with a status indicator (◌ running → ✓ passed / ✗ failed).
 *
 * Returns a `CheckObserver` (pass directly to `runAllChecks`) plus a
 * `finish()` method that replaces the live display with a static summary.
 */
export function createCheckProgressDisplay(): CheckObserver & {
	finish(): { passed: number; failed: number }
} {
	const items: ProgressItem[] = []
	let rendered = false
	const isTTY = process.stdout.isTTY

	return {
		onStart(_tool: string, command: string, matchedFiles: string[]) {
			const filePart =
				matchedFiles.length > 0
					? ` → ${matchedFiles.length} file${matchedFiles.length !== 1 ? "s" : ""}`
					: ""
			items.push({ tool: _tool, description: `${command}${filePart}`, status: "running" })
			rendered = render(items, rendered, isTTY)
		},

		onResult(result: CheckResult) {
			const last = items[items.length - 1]
			if (last) last.status = result.ok ? "passed" : "failed"
			rendered = render(items, rendered, isTTY)
		},

		finish() {
			if (rendered && isTTY) {
				process.stdout.write(`\x1B[${items.length + 1}A\x1B[J`)
			}
			return renderSummary(items)
		},
	}
}
