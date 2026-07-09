import { intro, isCancel, log, outro, spinner } from "@clack/prompts"
import { dim, green, red } from "kolorist"
import { getAutoAccept } from "../services/auto-accept.js"
import { getProviderApiKey, readConfig, setConfigValue } from "../services/config.js"
import {
	assertGitRepo,
	getChangedFiles,
	getHead,
	getRepoRoot,
	getStagedDiff,
	getStatusShort,
	stageAll,
} from "../services/git.js"
import {
	formatProviderName,
	isValidProvider,
	PROVIDER_ENV_KEYS,
	type ProviderName,
} from "../services/provider.js"
import { getRunChecks } from "../services/run-checks.js"
import { checkForUpdatesUpfront } from "../services/update-check.js"
import { reviewCommitMessage } from "../ui/review-message.js"
import { saveCachedCommit } from "../utils/cache.js"
import { debug } from "../utils/debug.js"
import {
	buildExcludedFilesMessage,
	type CommitFlags,
	generateMessage,
	runAutoGroupFlow,
} from "./auto-group.js"
import { commitWithRecovery } from "./commit-utils.js"
import { handleRetry } from "./retry.js"
import { runPreflightSetupPrompt } from "./setup.js"
import { handleStaging, runPreCommitChecks } from "./staging.js"

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Sequential CLI lifecycle orchestrator
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Multi-branch state machine (retry/normal, staging, review, recovery)
export async function commitCommand(flags: CommitFlags, version: string) {
	debug("commitCommand called", { flags })
	await assertGitRepo()

	// ── Retry mode ──────────────────────────────────────────────────
	if (flags.retry) {
		return handleRetry()
	}

	// ── Preflight: nudge the user to set up .cmintrc if it's missing ─
	const repoRoot = await getRepoRoot()
	await runPreflightSetupPrompt(repoRoot)

	// ── Normal mode ─────────────────────────────────────────────────
	intro("🌿 commit-mint")

	// ── Update check (after header, silent on cache hit) ────────────
	await checkForUpdatesUpfront(version)

	const status = await getStatusShort()
	debug("Git status:", status || "(empty)")
	if (!status) {
		outro(dim("Nothing to commit."))
		return
	}

	// Stage changes
	let changedFiles = await getChangedFiles()
	debug("Changed files:", changedFiles.length)
	const s = spinner()

	try {
		if (flags.single) {
			debug("Single-commit mode: staging all files")
			await stageAll()
			// Fall through to post-staging (checks → diff → generate → commit)
		} else if (flags.auto !== false) {
			if (flags.message) {
				outro(red("--message flag is not compatible with auto-group mode."))
				return
			}
			const agResult = await runAutoGroupFlow(changedFiles, flags)
			if (agResult !== "committed") {
				process.exit(1)
			}
			return
		} else {
			// Always show the staging menu, even for a single file — this is
			// the only place the auto-accept `a` hotkey toggle is reachable.
			// Skipping it for 1-file cases traps users in auto-accept mode.
			const result = await handleStaging(changedFiles, flags)
			if (!result) return
			changedFiles = result.changedFiles
		}
	} catch (err) {
		s.stop(red("Staging failed."))
		const msg = err instanceof Error ? err.message : String(err)
		debug("Staging error:", msg)
		outro(red(`Failed to stage files: ${msg}`))
		process.exit(1)
	}

	// Refresh file list after staging so staged state is accurate
	changedFiles = await getChangedFiles()

	// Run user-defined pre-commit checks (before AI message generation).
	// Checks run unless the per-invocation `--noCheck` flag is set OR the
	// persisted `run-checks` preference is false (toggled via `c` hotkey in
	// the staging menu).
	const shouldRunChecks = !flags.noCheck && (await getRunChecks())
	if (shouldRunChecks) {
		await runPreCommitChecks(changedFiles, false)
	}

	// Get diff for AI
	const diffResult = await getStagedDiff()
	if (!diffResult) {
		debug("No staged changes found after staging")
		outro(red("No staged changes found."))
		process.exit(1)
	}

	// Handle all-staged-files-are-excluded case with hardcoded message
	if ("excludedFiles" in diffResult) {
		debug("All staged files are excluded:", diffResult.excludedFiles)
		const message = buildExcludedFilesMessage(diffResult.excludedFiles)

		log.info(diffResult.excludedFiles.map((f) => `     ${f}`).join("\n"))

		await saveCachedCommit(repoRoot, message)

		s.start("Running pre-commit hooks...")
		const headBefore = await getHead()
		const result = await commitWithRecovery(message, s, headBefore)
		if (result === "committed") {
			outro(green("Done."))
			return
		}
		if (result === "cancelled") {
			process.exit(1)
		}
		return
	}

	debug("Staged files:", diffResult.files)
	debug("Diff length:", diffResult.diff.length, "chars")

	log.info(diffResult.files.map((f) => `     ${f}`).join("\n"))

	// Generate or use provided message
	let message: string

	if (flags.message) {
		debug("Using provided message:", flags.message)
		message = flags.message
	} else {
		const config = await readConfig()
		const provider: ProviderName = isValidProvider(config.provider ?? "groq")
			? (config.provider as ProviderName)
			: "groq"
		try {
			await getProviderApiKey(provider)
			debug("API key found")
		} catch {
			debug("No API key found, prompting user")
			const { text: promptText } = await import("@clack/prompts")
			const configKey = PROVIDER_ENV_KEYS[provider]
			const key = await promptText({
				message: `Enter your ${formatProviderName(provider)} API key:`,
				placeholder: provider === "groq" ? "gsk_..." : "...",
				validate: (v) => (v?.trim() ? undefined : "API key is required"),
			})
			if (isCancel(key)) {
				outro(dim("Cancelled."))
				return
			}
			await setConfigValue(configKey, String(key).trim())
			debug("API key saved to config")
		}

		s.start("Generating commit message...")
		try {
			const genStart = Date.now()
			message = await generateMessage(diffResult.diff, flags.hint)
			debug("generateMessage took %d ms", Date.now() - genStart)
			debug("Generated message:", message)
		} catch (err) {
			s.stop(red("Failed to generate message."))
			debug("Message generation failed:", err instanceof Error ? err.message : String(err))
			outro(red(err instanceof Error ? err.message : String(err)))
			return
		}
		s.stop("Message generated")
	}

	// Review message (with optional code review) — skipped when auto-accept is ON
	const autoAccept = flags.single || (await getAutoAccept())
	if (autoAccept) {
		debug("Auto-accept ON: skipping review step")
		log.info(message)
	} else {
		const reviewed = await reviewCommitMessage(message, {
			regenerate: async (hint) => {
				const combinedHint = flags.hint ? `${flags.hint}\n${hint}` : hint
				debug("Regenerating with combined hint:", combinedHint)
				s.start("Regenerating commit message...")
				try {
					const newMessage = await generateMessage(diffResult.diff, combinedHint)
					s.stop("Message regenerated")
					return newMessage
				} catch (err) {
					s.stop(red("Regeneration failed"))
					throw err
				}
			},
		})
		if (reviewed === null) {
			outro(dim("Cancelled."))
			return
		}
		message = reviewed
	}

	// Cache message before attempting commit
	await saveCachedCommit(repoRoot, message)
	debug("Message cached for repo:", repoRoot)

	// Attempt commit
	s.start("Running pre-commit hooks...")
	const headBefore = await getHead()
	debug("HEAD before commit:", headBefore)
	const result = await commitWithRecovery(message, s, headBefore)
	debug("Commit result:", result)

	if (result === "committed") {
		outro(green("Done."))
		return
	}
	if (result === "cancelled") {
		process.exit(1)
	}
}
