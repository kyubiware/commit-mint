import { log, outro, spinner } from "@clack/prompts"
import { dim, red } from "kolorist"
import { detectConfig, runAllChecks } from "../services/checks.js"
import {
	getChangedFiles,
	getRepoRoot,
	getStagedFiles,
	stageAll,
	stageFiles,
} from "../services/git.js"
import { createCheckProgressDisplay } from "../ui/check-progress.js"
import { showStagingMenu } from "../ui/staging-menu.js"
import { debug } from "../utils/debug.js"
import { type CommitFlags, runAutoGroupFlow } from "./auto-group.js"
import { runCheckPhaseInteractive } from "./check-phase.js"

/** Interactive staging loop for multiple changed files */
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Interactive staging loop with conditional branches
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Multi-branch TUI with autogroup, checks, staging options
export async function handleStaging(
	changedFiles: Awaited<ReturnType<typeof getChangedFiles>>,
	flags: CommitFlags,
): Promise<{
	changedFiles: Awaited<ReturnType<typeof getChangedFiles>>
	skipStaging: boolean
} | null> {
	const repoRoot = await getRepoRoot()
	const checksAvailable = (await detectConfig(repoRoot)) !== null
	debug("checks available:", checksAvailable)

	let stagingResult: Awaited<ReturnType<typeof showStagingMenu>> = null
	let filesToStage: string[] = []
	let stageAllFlag = false
	let skipStaging = false
	let currentFiles = changedFiles

	while (true) {
		stagingResult = await showStagingMenu(currentFiles, checksAvailable)

		if (stagingResult === "autogroup") {
			if (flags.message) {
				outro(red("--message flag is not compatible with auto-group mode."))
				return null
			}
			const agResult = await runAutoGroupFlow(currentFiles, flags)
			if (agResult !== "committed") {
				process.exit(1)
			}
			return null
		}

		if (stagingResult === "checks") {
			await stageAll()
			// Repo-root-relative paths line up with .cmintrc globs (lint-staged convention).
			const allFiles = await getStagedFiles()
			const configPath = await detectConfig(repoRoot)
			if (configPath) {
				const display = createCheckProgressDisplay()
				const ckResult = await runAllChecks(repoRoot, allFiles, 60000, display)
				display.finish(ckResult.ok)
				if (!ckResult.ok) {
					for (const r of ckResult.results.filter((r) => !r.ok))
						log.info(r.stderr?.trim() || r.stdout?.trim() || `Check failed: ${r.command}`)
				}
			}
			currentFiles = await getChangedFiles()
			continue
		}

		if (stagingResult === "staged") {
			skipStaging = true
			break
		}

		if (!stagingResult) {
			outro(dim("Cancelled."))
			return null
		}

		filesToStage = stagingResult.files
		stageAllFlag = stagingResult.all
		break
	}

	if (!skipStaging) {
		const s = spinner()
		s.start(`Staging ${filesToStage.length} file${filesToStage.length !== 1 ? "s" : ""}...`)
		if (stageAllFlag) {
			await stageAll()
		} else {
			await stageFiles(filesToStage)
		}
		s.stop("Files staged")
	}

	return { changedFiles: currentFiles, skipStaging }
}

/** Run user-defined pre-commit checks from cmint config */
export async function runPreCommitChecks(
	changedFiles: Awaited<ReturnType<typeof getChangedFiles>>,
	noCheck?: boolean,
): Promise<void> {
	if (noCheck) return
	const checkRoot = await getRepoRoot()
	// Repo-root-relative paths line up with .cmintrc globs (which are written
	// from the repo root, matching lint-staged conventions). `getChangedFiles()`
	// returns cwd-relative paths, which silently fail to match globs when cmint
	// is run from a subdirectory.
	const stagedFileList = await getStagedFiles()
	if (stagedFileList.length === 0) return

	// Delegate the check pipeline (detectConfig → progress display → runAllChecks →
	// retry loop with failure menu) to the shared check-phase module. On retry,
	// re-stage files so fixes made in another terminal between the original run
	// and the retry land in the index before checks re-run.
	const outcome = await runCheckPhaseInteractive(checkRoot, stagedFileList, 60000, async () => {
		debug("Re-staging files before retry...")
		await stageAll()
	})
	if (outcome === "cancelled") {
		process.exit(1)
	}

	// Formatters (prettier --write, eslint --fix, etc.) modify files on disk during checks.
	// Re-stage those modifications so getStagedDiff() captures the formatted content —
	// otherwise the commit lands with pre-format content and the changes dangle in the WT.
	// Use cwd-relative paths here: restageFormatterModifications compares against
	// getChangedFiles() (also cwd-relative) and writes via stageFiles() (git add from cwd).
	const cwdRelativeStaged = changedFiles
		.filter((f) => f.staged && f.status !== "D")
		.map((f) => f.path)
	await restageFormatterModifications(cwdRelativeStaged)
}

/**
 * Re-stage staged files whose working-tree content diverged from the index after checks ran.
 * Signals (git status --short, 2-char XY code):
 *   "MM" — tracked file staged-modified, then reformatted on disk
 *   "AM" — newly-added file staged, then reformatted on disk
 */
async function restageFormatterModifications(stagedFileList: string[]): Promise<void> {
	const checkedSet = new Set(stagedFileList)
	const postCheckFiles = await getChangedFiles()
	const modifiedByChecks = postCheckFiles
		.filter((f) => checkedSet.has(f.path) && f.staged && (f.status === "MM" || f.status === "AM"))
		.map((f) => f.path)
	if (modifiedByChecks.length === 0) return
	debug("Re-staging %d file(s) modified by checks", modifiedByChecks.length)
	await stageFiles(modifiedByChecks)
	log.info(
		`Re-staged ${modifiedByChecks.length} file${modifiedByChecks.length !== 1 ? "s" : ""} modified by checks`,
	)
}
