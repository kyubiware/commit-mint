import { log, spinner } from "@clack/prompts"
import { green, red } from "kolorist"
import type { CheckObserver, CheckResult } from "../services/checks.js"

/**
 * Creates a live check progress display using `@clack/prompts` primitives.
 *
 * - A single "Running checks…" spinner stays active while checks run.
 * - As each check completes, a `log.info` line is emitted below the spinner.
 *   The spinner's `ansiEscapes.eraseLine` + `cursorTo(0)` rendering only
 *   rewrites its own line, so `log.info` lines accumulate cleanly below
 *   with no cursor-positioning issues from wrapped terminal lines.
 * - When all checks finish, the spinner is stopped with a pass/fail summary.
 *
 * Returns a `CheckObserver` (pass directly to `runAllChecks`) plus a `finish()`
 * method that stops the spinner with the aggregated result.
 */
export function createCheckProgressDisplay(): CheckObserver & {
	finish(ok: boolean): void
} {
	const s = spinner()
	s.start("Running checks…")

	return {
		onStart() {
			// Spinner stays generic — individual check results appear below
		},

		onResult(result: CheckResult) {
			const icon = result.ok ? green("✓") : red("✗")
			log.info(`  ${icon} ${result.tool}`)
		},

		finish(ok: boolean) {
			if (ok) {
				s.stop(green("All checks passed"))
			} else {
				s.stop(red("Some checks failed"))
			}
		},
	}
}
