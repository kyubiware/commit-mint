import { log, spinner } from "@clack/prompts"
import { green, red } from "kolorist"
import type { CheckObserver, CheckResult } from "../services/checks.js"

/**
 * Creates a live check progress display.
 *
 * - Each check gets its own line. While a check runs, a spinner animates
 *   in the status position. When it completes, the spinner becomes a ✓ or ✗.
 * - There is no separate "Running checks…" header — the spinner IS the
 *   check line.
 * - When all checks finish, a `log.info` summary line is emitted.
 *
 * Returns a `CheckObserver` (pass directly to `runAllChecks`) plus a `finish()`
 * method that prints the final summary.
 */
export function createCheckProgressDisplay(): CheckObserver & {
	finish(ok: boolean): void
} {
	const s = spinner()
	const toolResults: { tool: string; ok: boolean }[] = []
	let started = false

	return {
		onStart(_tool: string, _command: string, _matchedFiles: string[]) {
			if (!started) {
				s.start(_tool)
				started = true
			} else {
				s.message(_tool)
			}
		},

		onResult(result: CheckResult) {
			toolResults.push({ tool: result.tool, ok: result.ok })
			s.message(`${result.ok ? "✓" : "✗"} ${result.tool}`)
		},

		finish(ok: boolean) {
			s.stop(ok ? green("All checks passed") : red("Some checks failed"))
			if (toolResults.length > 0) {
				log.info(toolResults.map((r) => `  ${r.ok ? green("✓") : red("✗")} ${r.tool}`).join("\n"))
			}
		},
	}
}
