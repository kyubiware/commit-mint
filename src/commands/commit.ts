import { intro, isCancel, log, outro, spinner } from "@clack/prompts";
import { dim, green, red } from "kolorist";
import { getProviderApiKey, readConfig, setConfigValue } from "../services/config.js";
import {
	assertGitRepo,
	attemptCommit,
	attemptCommitNoVerify,
	getChangedFiles,
	getHead,
	getStagedDiff,
	getStatusShort,
	stageAll,
	stageFiles,
} from "../services/git.js";
import { createProgressHandler } from "../services/hook-progress.js";
import { parseHookErrors, parseToolChecks } from "../services/hooks.js";
import { hasLintStagedConfig, runLintStaged } from "../services/lint-staged.js";
import {
	formatProviderName,
	isValidProvider,
	PROVIDER_ENV_KEYS,
	type ProviderName,
} from "../services/provider.js";
import { showRecoveryMenu, showStagingMenu } from "../ui/menu.js";
import { reviewCommitMessage } from "../ui/review-message.js";
import { loadCachedCommit, saveCachedCommit } from "../utils/cache.js";
import { debug } from "../utils/debug.js";
import {
	buildExcludedFilesMessage,
	type CommitFlags,
	generateMessage,
	runAutoGroupFlow,
} from "./auto-group.js";

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Sequential CLI lifecycle orchestrator
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Multi-branch state machine (retry/normal, staging, review, recovery)
export async function commitCommand(flags: CommitFlags) {
	debug("commitCommand called", { flags });
	await assertGitRepo();

	// ── Retry mode ──────────────────────────────────────────────────
	if (flags.retry) {
		debug("Entering retry mode");
		const { getRepoRoot } = await import("../services/git.js");
		const repoRoot = await getRepoRoot();
		debug("Repo root:", repoRoot);
		const cached = await loadCachedCommit(repoRoot);
		if (!cached) {
			debug("No cached commit found");
			outro(red("No cached commit message found. Run cmint without --retry first."));
			process.exit(1);
		}
		debug("Loaded cached message:", cached.message);
		intro("commit-mint — retry");
		const s = spinner();
		s.start("Running pre-commit hooks...");
		const result = await attemptCommit(cached.message, [], createProgressHandler(s));
		s.stop("Attempted commit");
		debug("Retry commit result:", result);
		if (result.ok) {
			// Show clean tool check summary
			const checks = parseToolChecks(result.stderr ?? "");
			if (checks.length > 0) {
				const lines = checks.map((c) => `  ${c.ok ? green("✓") : red("✗")} ${c.tool}`);
				log.info(lines.join("\n"));
			}
			outro(green("Committed successfully."));
		} else {
			const errors = parseHookErrors(result.stderr ?? "");
			debug("Hook errors on retry:", errors.length);
			const recoveryResult = await showRecoveryMenu(
				errors,
				async () => (await attemptCommit(cached.message)).ok,
				async (msg) => (await attemptCommitNoVerify(msg)).ok,
				async () => {
					await stageAll();
					return (await attemptCommit(cached.message)).ok;
				},
				cached.message,
				result.stderr ?? "",
			);
			if (recoveryResult === "cancelled") {
				process.exit(1);
			}
			return;
		}
	}

	// ── Normal mode ─────────────────────────────────────────────────
	intro("commit-mint");

	const status = await getStatusShort();
	debug("Git status:", status || "(empty)");
	if (!status) {
		outro(dim("Nothing to commit."));
		return;
	}

	// Stage changes
	let changedFiles = await getChangedFiles();
	debug("Changed files:", changedFiles.length);
	const s = spinner();

	try {
		if (flags.auto) {
			// --auto flag: auto-group with auto-accept, skip all menus
			if (flags.message) {
				outro(red("--message flag is not compatible with auto-group mode."));
				return;
			}
			const agResult = await runAutoGroupFlow(changedFiles, flags);
			if (agResult !== "committed") {
				process.exit(1);
			}
			return;
		} else if (changedFiles.length === 1) {
			// Single file: auto-stage it
			s.start(`Staging ${changedFiles[0].path}...`);
			await stageFiles([changedFiles[0].path]);
			s.stop("File staged");
		} else {
			// Multiple files: show interactive staging menu (loops for lint-staged)
			const { getRepoRoot } = await import("../services/git.js");
			const repoRoot = await getRepoRoot();
			const lintStagedAvailable = await hasLintStagedConfig(repoRoot);
			debug("lint-staged available:", lintStagedAvailable);

			let stagingResult: Awaited<ReturnType<typeof showStagingMenu>> = null;
			let filesToStage: string[] = [];
			let stageAllFlag = false;
			let skipStaging = false;

			while (true) {
				stagingResult = await showStagingMenu(changedFiles, lintStagedAvailable);

				if (stagingResult === "autogroup") {
					if (flags.message) {
						outro(red("--message flag is not compatible with auto-group mode."));
						return;
					}
					const agResult = await runAutoGroupFlow(changedFiles, flags);
					if (agResult !== "committed") {
						process.exit(1);
					}
					return;
				}

				if (stagingResult === "lint-staged") {
					await stageAll();
					const lsSpinner = spinner();
					lsSpinner.start("Running lint-staged checks...");
					const lsResult = await runLintStaged();
					if (lsResult.ok) {
						lsSpinner.stop("All lint-staged checks passed");
						if (lsResult.stdout.trim()) {
							log.info(dim(lsResult.stdout.trim()));
						}
					} else {
						lsSpinner.stop("Lint-staged checks failed");
						log.info(lsResult.stderr?.trim() || lsResult.stdout?.trim() || "Unknown error");
					}
					// Refresh changed files list after lint-staged may have modified files
					changedFiles = await getChangedFiles();
					continue;
				}

				if (stagingResult === "staged") {
					// Files already staged — skip staging step
					skipStaging = true;
					break;
				}

				if (!stagingResult) {
					outro(dim("Cancelled."));
					return;
				}

				filesToStage = stagingResult.files;
				stageAllFlag = stagingResult.all;
				break;
			}

			if (!skipStaging) {
				s.start(`Staging ${filesToStage.length} file${filesToStage.length !== 1 ? "s" : ""}...`);
				if (stageAllFlag) {
					await stageAll();
				} else {
					await stageFiles(filesToStage);
				}
				s.stop("Files staged");
			}
		}
	} catch (err) {
		s.stop(red("Staging failed."));
		const msg = err instanceof Error ? err.message : String(err);
		debug("Staging error:", msg);
		outro(red(`Failed to stage files: ${msg}`));
		process.exit(1);
	}

	// Get diff for AI
	const diffResult = await getStagedDiff();
	if (!diffResult) {
		debug("No staged changes found after staging");
		outro(red("No staged changes found."));
		process.exit(1);
	}

	// Handle all-staged-files-are-excluded case with hardcoded message
	if ("excludedFiles" in diffResult) {
		debug("All staged files are excluded:", diffResult.excludedFiles);
		const message = buildExcludedFilesMessage(diffResult.excludedFiles);

		log.info(diffResult.excludedFiles.map((f) => `     ${f}`).join("\n"));

		// Cache and commit with hardcoded message
		const { getRepoRoot } = await import("../services/git.js");
		const repoRoot = await getRepoRoot();
		await saveCachedCommit(repoRoot, message);

		s.start("Running pre-commit hooks...");
		const headBefore = await getHead();
		const result = await attemptCommit(message, [], createProgressHandler(s));
		const headAfter = await getHead();

		if (result.ok || headBefore !== headAfter) {
			s.stop("Committed successfully.");
			outro(green("Done."));
			return;
		}

		s.stop("Commit failed.");
		const errors = parseHookErrors(result.stderr ?? "");
		const recoveryResult = await showRecoveryMenu(
			errors,
			async () => (await attemptCommit(message)).ok,
			async (msg) => (await attemptCommitNoVerify(msg)).ok,
			async () => {
				await stageAll();
				return (await attemptCommit(message)).ok;
			},
			message,
			result.stderr ?? "",
		);
		if (recoveryResult === "cancelled") {
			process.exit(1);
		}
		return;
	}

	debug("Staged files:", diffResult.files);
	debug("Diff length:", diffResult.diff.length, "chars");

	log.info(diffResult.files.map((f) => `     ${f}`).join("\n"));

	// Generate or use provided message
	let message: string;

	if (flags.message) {
		debug("Using provided message:", flags.message);
		message = flags.message;
	} else {
		// Ensure API key is available before generating
		const config = await readConfig();
		const provider: ProviderName = isValidProvider(config.provider ?? "groq")
			? (config.provider as ProviderName)
			: "groq";
		try {
			await getProviderApiKey(provider);
			debug("API key found");
		} catch {
			debug("No API key found, prompting user");
			const { text: promptText } = await import("@clack/prompts");
			const configKey = PROVIDER_ENV_KEYS[provider];
			const key = await promptText({
				message: `Enter your ${formatProviderName(provider)} API key:`,
				placeholder: provider === "groq" ? "gsk_..." : "...",
				validate: (v) => (v?.trim() ? undefined : "API key is required"),
			});
			if (isCancel(key)) {
				outro(dim("Cancelled."));
				return;
			}
			await setConfigValue(configKey, String(key).trim());
			debug("API key saved to config");
		}

		s.start("Generating commit message...");
		try {
			const genStart = Date.now();
			message = await generateMessage(diffResult.diff, flags.hint);
			debug("generateMessage took %d ms", Date.now() - genStart);
			debug("Generated message:", message);
		} catch (err) {
			s.stop(red("Failed to generate message."));
			debug("Message generation failed:", err instanceof Error ? err.message : String(err));
			outro(red(err instanceof Error ? err.message : String(err)));
			return;
		}
		s.stop("Message generated");
	}

	// Review message (with optional code review)
	const reviewed = await reviewCommitMessage(message);
	if (reviewed === null) {
		outro(dim("Cancelled."));
		return;
	}
	message = reviewed;

	// Cache message before attempting commit
	const { getRepoRoot } = await import("../services/git.js");
	const repoRoot = await getRepoRoot();
	await saveCachedCommit(repoRoot, message);
	debug("Message cached for repo:", repoRoot);

	// Attempt commit
	s.start("Running pre-commit hooks...");
	const headBefore = await getHead();
	debug("HEAD before commit:", headBefore);
	const result = await attemptCommit(message, [], createProgressHandler(s));
	const headAfter = await getHead();
	debug("HEAD after commit:", headAfter);
	debug("Commit result:", result);

	if (result.ok || headBefore !== headAfter) {
		s.stop("Committed successfully.");

		// Show clean tool check summary
		const checks = parseToolChecks(result.stderr ?? "");
		if (checks.length > 0) {
			const lines = checks.map((c) => `  ${c.ok ? green("✓") : red("✗")} ${c.tool}`);
			log.info(lines.join("\n"));
		}

		outro(green("Done."));
		return;
	}

	s.stop("Commit failed.");
	debug("Commit failed, showing recovery menu");

	// Hook failure — show recovery menu
	const errors = parseHookErrors(result.stderr ?? "");
	debug("Parsed hook errors:", errors.length, "errors");
	const recoveryResult = await showRecoveryMenu(
		errors,
		async () => {
			const r = await attemptCommit(message);
			return r.ok;
		},
		async (msg) => {
			const r = await attemptCommitNoVerify(msg);
			return r.ok;
		},
		async () => {
			await stageAll();
			const r = await attemptCommit(message);
			return r.ok;
		},
		message,
		result.stderr ?? "",
	);
	if (recoveryResult === "cancelled") {
		process.exit(1);
	}
}
