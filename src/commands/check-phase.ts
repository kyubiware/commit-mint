import { spinner } from "@clack/prompts"
import { detectConfig, runAllChecks } from "../services/checks.js"
import { parseCheckErrors } from "../services/hooks.js"
import { showCheckFailureMenu } from "../ui/check-failure-menu.js"
import { stopCheckSpinner } from "../ui/check-summary.js"
import { debug } from "../utils/debug.js"

/**
 * Outcome of an interactive check phase.
 *
 * - `"passed"` — checks ran and passed (or no `.cmintrc` exists, which is treated as a pass)
 * - `"skipped"` — checks failed but the user chose to skip and proceed anyway
 * - `"cancelled"` — the user chose cancel from the failure menu (caller should abort)
 */
export type CheckPhaseOutcome = "passed" | "skipped" | "cancelled"

/**
 * Optional callback invoked before each retry after the user picks "Retry checks"
 * from the failure menu. Use this to refresh staged state (e.g. `stageAll()` to
 * pick up fixes made in another terminal between the original run and the retry).
 *
 * Not invoked on the initial check run — only on retries triggered by the menu.
 */
export type CheckRetryCallback = () => Promise<void>

/**
 * Run user-defined pre-commit checks with an interactive failure menu.
 *
 * Single entry point for the check-execution pipeline shared by `runPreCommitChecks`
 * (post-staging, normal commit flow) and `runAutoGroupFlow` (pre-staging, auto-group
 * flow). Encapsulates: detectConfig guard → spinner → runAllChecks → retry loop with
 * `showCheckFailureMenu`.
 *
 * Caller responsibilities:
 * - Skip when `noCheck` is set (caller's policy).
 * - Skip when there are no files to check (caller has the file list context).
 * - Derive `files` in **repo-root-relative** form so they match `.cmintrc` globs.
 *   Post-staging callers should use `getStagedFiles()`; pre-staging callers should
 *   use `resolveToRepoRoot()` since the index doesn't yet contain those paths.
 *
 * Returns the outcome so the caller can decide how to handle cancellation
 * (`process.exit(1)` in the commit flow, `return "cancelled"` in auto-group).
 */
export async function runCheckPhaseInteractive(
	repoRoot: string,
	files: string[],
	timeout: number,
	onRetry?: CheckRetryCallback,
): Promise<CheckPhaseOutcome> {
	// No-op when no `.cmintrc` config exists. Checking here (rather than relying
	// on runAllChecks's internal no-op) lets us skip the spinner entirely, which
	// is the reason auto-group had its own `detectConfig` guard before extraction.
	const configPath = await detectConfig(repoRoot)
	if (!configPath) return "passed"

	debug("Running user checks on %d files...", files.length)
	const ck = spinner()
	ck.start("Running checks...")
	let checkResults = await runAllChecks(repoRoot, files, timeout)
	stopCheckSpinner(ck, checkResults)
	debug("Check results: ok=%s, count=%d", checkResults.ok, checkResults.results.length)

	while (!checkResults.ok) {
		const failed = checkResults.results.filter((r) => !r.ok)
		const rawOutput = failed.map((r) => `[${r.tool}]\n${r.stdout}\n${r.stderr}`.trim()).join("\n\n")
		const checkErrors = parseCheckErrors(rawOutput)
		const menuResult = await showCheckFailureMenu(checkErrors, rawOutput, async () => {
			const retryResult = await runAllChecks(repoRoot, files, timeout)
			return retryResult.ok
		})
		if (menuResult === "cancelled") {
			return "cancelled"
		}
		if (menuResult === "retried") {
			debug("Re-running checks after retry...")
			if (onRetry) await onRetry()
			ck.start("Running checks...")
			checkResults = await runAllChecks(repoRoot, files, timeout)
			stopCheckSpinner(ck, checkResults)
			debug("Retry check results: ok=%s, count=%d", checkResults.ok, checkResults.results.length)
			continue
		}
		// "skipped" — break out of the loop; caller proceeds despite the failure
		break
	}

	return checkResults.ok ? "passed" : "skipped"
}
