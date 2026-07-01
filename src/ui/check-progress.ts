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

	return {
		onStart(_tool: string, _command: string, _matchedFiles: string[]) {
			s.start(_tool)
		},

		onResult(result: CheckResult) {
			s.stop(result.ok ? `✓ ${result.tool}` : `✗ ${result.tool}`)
		},

		finish(ok: boolean) {
			log.info(ok ? green("All checks passed") : red("Some checks failed"))
		},
	}
}
