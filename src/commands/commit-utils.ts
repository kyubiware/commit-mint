import { log, type spinner } from "@clack/prompts"
import { green, red } from "kolorist"
import { attemptCommit, attemptCommitNoVerify, getHead, stageAll } from "../services/git.js"
import { createProgressHandler } from "../services/hook-progress.js"
import { parseHookErrors, parseToolChecks } from "../services/hooks.js"
import { showRecoveryMenu } from "../ui/recovery-menu.js"

/** Shared recovery menu factory — avoids repeating the same callback set */
export function makeRecoveryCallbacks(message: string) {
	return {
		retry: async () => (await attemptCommit(message)).ok,
		skipHooks: async (msg: string) => (await attemptCommitNoVerify(msg)).ok,
		restage: async () => {
			await stageAll()
			return (await attemptCommit(message)).ok
		},
		message,
	}
}

/**
 * Attempt commit with automatic recovery flow.
 * Handles the attempt → HEAD check → success (tool checks display)
 * / failure (recovery menu) pattern.
 * Caller is responsible for starting the spinner and showing the final outro.
 */
export async function commitWithRecovery(
	message: string,
	s: ReturnType<typeof spinner>,
	headBefore: string | null,
): Promise<"committed" | "cancelled"> {
	const result = await attemptCommit(message, [], createProgressHandler(s))
	const headAfter = await getHead()

	if (result.ok || headBefore !== headAfter) {
		s.stop("Committed successfully.")

		const checks = parseToolChecks(result.stderr ?? "")
		if (checks.length > 0) {
			const lines = checks.map((c) => `  ${c.ok ? green("✓") : red("✗")} ${c.tool}`)
			log.info(lines.join("\n"))
		}

		return "committed"
	}

	s.stop("Commit failed.")
	const errors = parseHookErrors(result.stderr ?? "")
	const cb = makeRecoveryCallbacks(message)
	const recoveryResult = await showRecoveryMenu(
		errors,
		cb.retry,
		cb.skipHooks,
		cb.restage,
		cb.message,
		result.stderr ?? "",
	)

	if (recoveryResult === "cancelled") {
		return "cancelled"
	}

	return "committed"
}
