import { log, outro, spinner } from "@clack/prompts"
import { dim, red } from "kolorist"
import { detectConfig, runAllChecks } from "../services/checks.js"
import { getChangedFiles, getRepoRoot, stageAll, stageFiles } from "../services/git.js"
import { parseCheckErrors } from "../services/hooks.js"
import { showCheckFailureMenu } from "../ui/check-failure-menu.js"
import { stopCheckSpinner } from "../ui/check-summary.js"
import { showStagingMenu } from "../ui/staging-menu.js"
import { debug } from "../utils/debug.js"
import { type CommitFlags, runAutoGroupFlow } from "./auto-group.js"

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
			const allFiles = currentFiles.filter((f) => f.status !== "D").map((f) => f.path)
			const configPath = await detectConfig(repoRoot)
			if (configPath) {
				const ckSpinner = spinner()
				ckSpinner.start("Running checks...")
				const ckResult = await runAllChecks(repoRoot, allFiles, 60000)
				stopCheckSpinner(ckSpinner, ckResult)
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
	const stagedFileList = changedFiles.filter((f) => f.staged && f.status !== "D").map((f) => f.path)
	if (stagedFileList.length === 0) return

	debug("Running user checks on %d staged files...", stagedFileList.length)
	const ckSpinner = spinner()
	ckSpinner.start("Running checks...")
	let checkResults = await runAllChecks(checkRoot, stagedFileList, 60000)
	stopCheckSpinner(ckSpinner, checkResults)
	debug("Check results: ok=%s, count=%d", checkResults.ok, checkResults.results.length)

	while (!checkResults.ok) {
		const failed = checkResults.results.filter((r) => !r.ok)
		const rawOutput = failed.map((r) => `[${r.tool}]\n${r.stdout}\n${r.stderr}`.trim()).join("\n\n")
		const checkErrors = parseCheckErrors(rawOutput)
		const menuResult = await showCheckFailureMenu(checkErrors, rawOutput, async () => {
			const retryResult = await runAllChecks(checkRoot, stagedFileList, 60000)
			return retryResult.ok
		})
		if (menuResult === "cancelled") {
			process.exit(1)
		}
		if (menuResult === "retried") {
			debug("Re-staging files and re-running checks after retry...")
			await stageAll()
			const ckSpinner = spinner()
			ckSpinner.start("Running checks...")
			checkResults = await runAllChecks(checkRoot, stagedFileList, 60000)
			debug("Retry check results: ok=%s, count=%d", checkResults.ok, checkResults.results.length)
			stopCheckSpinner(ckSpinner, checkResults)
			continue
		}
		// "skipped" — break out of loop
		break
	}

	// Formatters (prettier --write, eslint --fix, etc.) modify files on disk during checks.
	// Re-stage those modifications so getStagedDiff() captures the formatted content —
	// otherwise the commit lands with pre-format content and the changes dangle in the WT.
	await restageFormatterModifications(stagedFileList)
}

/**
 * Re-stage staged files whose working-tree content diverged from the index after checks ran.
 * Signal: a file with both index and working-tree modifications has git status "MM".
 */
async function restageFormatterModifications(stagedFileList: string[]): Promise<void> {
	const checkedSet = new Set(stagedFileList)
	const postCheckFiles = await getChangedFiles()
	const modifiedByChecks = postCheckFiles
		.filter((f) => checkedSet.has(f.path) && f.staged && f.status === "MM")
		.map((f) => f.path)
	if (modifiedByChecks.length === 0) return
	debug("Re-staging %d file(s) modified by checks", modifiedByChecks.length)
	await stageFiles(modifiedByChecks)
	log.info(
		`Re-staged ${modifiedByChecks.length} file${modifiedByChecks.length !== 1 ? "s" : ""} modified by checks`,
	)
}
