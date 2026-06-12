import { intro, isCancel, log, outro, spinner } from "@clack/prompts";
import { dim, green, red } from "kolorist";
import { getProviderApiKey, readConfig, setConfigValue } from "../services/config.js";
import {
	assertGitRepo,
	getChangedFiles,
	getHead,
	getRepoRoot,
	getStagedDiff,
	getStatusShort,
	stageFiles,
} from "../services/git.js";
import {
	formatProviderName,
	isValidProvider,
	PROVIDER_ENV_KEYS,
	type ProviderName,
} from "../services/provider.js";
import { reviewCommitMessage } from "../ui/review-message.js";
import { saveCachedCommit } from "../utils/cache.js";
import { debug } from "../utils/debug.js";
import {
	buildExcludedFilesMessage,
	type CommitFlags,
	generateMessage,
	runAutoGroupFlow,
} from "./auto-group.js";
import { commitWithRecovery } from "./commit-utils.js";
import { handleRetry } from "./retry.js";
import { runPreflightSetupPrompt } from "./setup.js";
import { handleStaging, runPreCommitChecks } from "./staging.js";

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Sequential CLI lifecycle orchestrator
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Multi-branch state machine (retry/normal, staging, review, recovery)
export async function commitCommand(flags: CommitFlags) {
	debug("commitCommand called", { flags });
	await assertGitRepo();

	// ── Retry mode ──────────────────────────────────────────────────
	if (flags.retry) {
		return handleRetry();
	}

	// ── Preflight: nudge the user to set up .cmintrc if it's missing ─
	const repoRoot = await getRepoRoot();
	await runPreflightSetupPrompt(repoRoot);

	// ── Normal mode ─────────────────────────────────────────────────
	intro("🌿 commit-mint");

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
			s.start(`Staging ${changedFiles[0].path}...`);
			await stageFiles([changedFiles[0].path]);
			s.stop("File staged");
		} else {
			const result = await handleStaging(changedFiles, flags);
			if (!result) return;
			changedFiles = result.changedFiles;
		}
	} catch (err) {
		s.stop(red("Staging failed."));
		const msg = err instanceof Error ? err.message : String(err);
		debug("Staging error:", msg);
		outro(red(`Failed to stage files: ${msg}`));
		process.exit(1);
	}

	// Refresh file list after staging so staged state is accurate
	changedFiles = await getChangedFiles();

	// Run user-defined pre-commit checks (before AI message generation)
	await runPreCommitChecks(changedFiles, flags.noCheck);

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

		await saveCachedCommit(repoRoot, message);

		s.start("Running pre-commit hooks...");
		const headBefore = await getHead();
		const result = await commitWithRecovery(message, s, headBefore);
		if (result === "committed") {
			outro(green("Done."));
			return;
		}
		if (result === "cancelled") {
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
	await saveCachedCommit(repoRoot, message);
	debug("Message cached for repo:", repoRoot);

	// Attempt commit
	s.start("Running pre-commit hooks...");
	const headBefore = await getHead();
	debug("HEAD before commit:", headBefore);
	const result = await commitWithRecovery(message, s, headBefore);
	debug("Commit result:", result);

	if (result === "committed") {
		outro(green("Done."));
		return;
	}
	if (result === "cancelled") {
		process.exit(1);
	}
}
