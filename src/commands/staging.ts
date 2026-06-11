import { log, outro, spinner } from "@clack/prompts";
import { dim, red } from "kolorist";
import { detectConfig, runAllChecks } from "../services/checks.js";
import { getChangedFiles, getRepoRoot, stageAll, stageFiles } from "../services/git.js";
import { parseCheckErrors } from "../services/hooks.js";
import { showCheckFailureMenu } from "../ui/check-failure-menu.js";
import { showStagingMenu } from "../ui/staging-menu.js";
import { debug } from "../utils/debug.js";
import { type CommitFlags, runAutoGroupFlow } from "./auto-group.js";

/** Interactive staging loop for multiple changed files */
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Interactive staging loop with conditional branches
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Multi-branch TUI with autogroup, checks, staging options
export async function handleStaging(
	changedFiles: Awaited<ReturnType<typeof getChangedFiles>>,
	flags: CommitFlags,
): Promise<{
	changedFiles: Awaited<ReturnType<typeof getChangedFiles>>;
	skipStaging: boolean;
} | null> {
	const repoRoot = await getRepoRoot();
	const checksAvailable = (await detectConfig(repoRoot)) !== null;
	debug("checks available:", checksAvailable);

	let stagingResult: Awaited<ReturnType<typeof showStagingMenu>> = null;
	let filesToStage: string[] = [];
	let stageAllFlag = false;
	let skipStaging = false;
	let currentFiles = changedFiles;

	while (true) {
		stagingResult = await showStagingMenu(currentFiles, checksAvailable);

		if (stagingResult === "autogroup") {
			if (flags.message) {
				outro(red("--message flag is not compatible with auto-group mode."));
				return null;
			}
			const agResult = await runAutoGroupFlow(currentFiles, flags);
			if (agResult !== "committed") {
				process.exit(1);
			}
			return null;
		}

		if (stagingResult === "checks") {
			await stageAll();
			const allFiles = currentFiles.filter((f) => f.status !== "D").map((f) => f.path);
			const configPath = await detectConfig(repoRoot);
			if (configPath) {
				const ckSpinner = spinner();
				ckSpinner.start("Running checks...");
				const ckResult = await runAllChecks(repoRoot, allFiles, 60000);
				if (ckResult.ok) {
					ckSpinner.stop("All checks passed");
					for (const r of ckResult.results) if (r.stdout.trim()) log.info(dim(r.stdout.trim()));
				} else {
					const failed = ckResult.results.filter((r) => !r.ok);
					ckSpinner.stop(`${failed.length} check${failed.length !== 1 ? "s" : ""} failed`);
					for (const r of failed)
						log.info(r.stderr?.trim() || r.stdout?.trim() || `Check failed: ${r.command}`);
				}
			}
			currentFiles = await getChangedFiles();
			continue;
		}

		if (stagingResult === "staged") {
			skipStaging = true;
			break;
		}

		if (!stagingResult) {
			outro(dim("Cancelled."));
			return null;
		}

		filesToStage = stagingResult.files;
		stageAllFlag = stagingResult.all;
		break;
	}

	if (!skipStaging) {
		const s = spinner();
		s.start(`Staging ${filesToStage.length} file${filesToStage.length !== 1 ? "s" : ""}...`);
		if (stageAllFlag) {
			await stageAll();
		} else {
			await stageFiles(filesToStage);
		}
		s.stop("Files staged");
	}

	return { changedFiles: currentFiles, skipStaging };
}

/** Run user-defined pre-commit checks from cmint config */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Check failure loop with retry support
export async function runPreCommitChecks(
	changedFiles: Awaited<ReturnType<typeof getChangedFiles>>,
	noCheck?: boolean,
): Promise<void> {
	if (noCheck) return;
	const checkRoot = await getRepoRoot();
	const stagedFileList = changedFiles
		.filter((f) => f.staged && f.status !== "D")
		.map((f) => f.path);
	if (stagedFileList.length === 0) return;

	debug("Running user checks on %d staged files...", stagedFileList.length);
	let checkResults = await runAllChecks(checkRoot, stagedFileList, 60000);
	debug("Check results: ok=%s, count=%d", checkResults.ok, checkResults.results.length);

	while (!checkResults.ok) {
		const failed = checkResults.results.filter((r) => !r.ok);
		const rawOutput = failed
			.map((r) => `[${r.tool}]\n${r.stdout}\n${r.stderr}`.trim())
			.join("\n\n");
		const checkErrors = parseCheckErrors(rawOutput);
		const menuResult = await showCheckFailureMenu(checkErrors, rawOutput, async () => {
			const retryResult = await runAllChecks(checkRoot, stagedFileList, 60000);
			return retryResult.ok;
		});
		if (menuResult === "cancelled") {
			process.exit(1);
		}
		if (menuResult === "retried") {
			debug("Re-running checks after retry...");
			const ckSpinner = spinner();
			ckSpinner.start("Running checks...");
			checkResults = await runAllChecks(checkRoot, stagedFileList, 60000);
			debug("Retry check results: ok=%s, count=%d", checkResults.ok, checkResults.results.length);
			if (checkResults.ok) {
				ckSpinner.stop("All checks passed");
				for (const r of checkResults.results) if (r.stdout.trim()) log.info(dim(r.stdout.trim()));
			} else {
				const retryFailed = checkResults.results.filter((r) => !r.ok);
				ckSpinner.stop(`${retryFailed.length} check${retryFailed.length !== 1 ? "s" : ""} failed`);
			}
			continue;
		}
		// "skipped" — break out of loop
		break;
	}
}
