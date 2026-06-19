import { isCancel, log, outro, spinner } from "@clack/prompts"
import { dim, green, red } from "kolorist"
import { generateCommitMessage } from "../services/ai.js"
import { getAutoAccept } from "../services/auto-accept.js"
import {
	getModelForProvider,
	getProviderApiKey,
	readConfig,
	setConfigValue,
} from "../services/config.js"
import {
	attemptCommit,
	attemptCommitNoVerify,
	type ChangedFile,
	getDefaultExcludes,
	getHead,
	getStagedDiff,
	resetStaging,
	resolveToRepoRoot,
	stageFiles,
} from "../services/git.js"
import { filterExcludedFiles, generateGroups, validateGroups } from "../services/grouping.js"
import { createProgressHandler } from "../services/hook-progress.js"
import { parseHookErrors, parseToolChecks } from "../services/hooks.js"
import {
	formatProviderName,
	isValidProvider,
	PROVIDER_CONFIGS,
	PROVIDER_ENV_KEYS,
	type ProviderName,
} from "../services/provider.js"
import { showGroupedFiles, showGroupingConfirmation, showGroupProgress } from "../ui/grouping.js"
import { type RecoveryResult, showRecoveryMenu } from "../ui/recovery-menu.js"
import { reviewCommitMessage } from "../ui/review-message.js"
import { saveCachedCommit } from "../utils/cache.js"
import { debug } from "../utils/debug.js"
import { runCheckPhaseInteractive } from "./check-phase.js"

export interface CommitFlags {
	retry: boolean
	auto: boolean
	agent: boolean
	message?: string
	hint?: string
	noCheck?: boolean
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Multi-step auto-group flow with sequential commits, review, and recovery
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Sequential multi-commit loop with review, cache, and recovery
export async function runAutoGroupFlow(
	changedFiles: ChangedFile[],
	flags: CommitFlags,
): Promise<RecoveryResult> {
	// Step 1: Filter excluded files
	const { included, excluded } = filterExcludedFiles(changedFiles)

	// Step 1b: Commit excluded files with hardcoded message before grouping
	if (excluded.length > 0) {
		debug("Committing %d excluded files upfront:", excluded.length, excluded)
		const message = buildExcludedFilesMessage(excluded)

		log.info(excluded.map((f) => `     ${f}`).join("\n"))

		await resetStaging()
		await stageFiles(excluded)

		const headBefore = await getHead()
		const commitResult = await attemptCommit(message)
		const headAfter = await getHead()

		if (commitResult.ok || headBefore !== headAfter) {
			debug("Excluded files committed:", message)
			log.success(dim(message))
		} else {
			debug("Excluded files commit failed, continuing without them")
			log.warn(red("Failed to commit excluded files."))
		}
	}

	// If only excluded files existed, we're done
	if (included.length === 0) {
		debug("No included files to group, done")
		if (excluded.length > 0) {
			outro(green("Committed excluded files. No other changes to group."))
		} else {
			outro(dim("Nothing to commit."))
		}
		return "committed"
	}

	// Run user-defined pre-commit checks upfront on all files (before AI grouping)
	if (!flags.noCheck) {
		const { getRepoRoot } = await import("../services/git.js")
		const repoRoot = await getRepoRoot()
		// Convert cwd-relative paths from `filterExcludedFiles` to repo-root-relative
		// so they line up with .cmintrc globs (which are written from the repo root,
		// matching lint-staged conventions). Checks run BEFORE per-group staging,
		// so we can't use `getStagedFiles()` here — the index doesn't yet contain
		// these files.
		const cwdRelativeIncluded = included.filter((f) => f.status !== "D").map((f) => f.path)
		const allFiles = await resolveToRepoRoot(cwdRelativeIncluded)
		// No onRetry callback: files aren't staged yet, so `stageAll()` would be
		// inappropriate here. The check commands read from the working tree, so
		// external fixes are picked up directly on the next `runAllChecks` call.
		const outcome = await runCheckPhaseInteractive(repoRoot, allFiles, 60000)
		if (outcome === "cancelled") {
			return "cancelled"
		}
	}

	// Step 2: Read config and determine provider
	const config = await readConfig()
	const resolvedProvider = config.provider ?? "groq"
	const provider: ProviderName = isValidProvider(resolvedProvider) ? resolvedProvider : "groq"

	// Step 3: Ensure API key
	try {
		await getProviderApiKey(provider)
		debug("API key found")
	} catch {
		debug("No API key found, prompting user")
		const { text: promptText } = await import("@clack/prompts")
		const key = await promptText({
			message: `Enter your ${formatProviderName(provider)} API key:`,
			placeholder: provider === "groq" ? "gsk_..." : "...",
			validate: (v) => (v?.trim() ? undefined : "API key is required"),
		})
		if (isCancel(key)) {
			outro(dim("Cancelled."))
			return "cancelled"
		}
		const configKey = PROVIDER_ENV_KEYS[provider]
		await setConfigValue(configKey, String(key).trim())
		debug("API key saved to config")
	}

	// Step 4: Call grouping service
	const s = spinner()
	s.start("Analyzing files...")
	const apiKey = await getProviderApiKey(provider)
	const result = await generateGroups(
		included,
		apiKey,
		getModelForProvider(config, provider, PROVIDER_CONFIGS[provider].defaultModel),
		config.timeout ? parseInt(config.timeout, 10) : undefined,
		provider,
		config.proxy,
	)
	const validatedGroups = validateGroups(result.groups, included)
	s.stop("Files analyzed")

	showGroupedFiles(validatedGroups, included)

	// Auto-accept mode: skip both grouping confirmation and per-group review.
	// Read once here so a single toggle in the staging menu is honored for the
	// entire flow. `flags.auto` already skips both; auto-accept extends that
	// to interactive (non-`--auto`) runs.
	const autoAccept = await getAutoAccept()
	const skipPrompts = flags.auto || autoAccept

	// Step 5: Show grouping confirmation (skip in auto mode or auto-accept)
	if (skipPrompts) {
		debug("Skipping grouping confirmation (auto=%s autoAccept=%s)", flags.auto, autoAccept)
	} else {
		const confirmed = await showGroupingConfirmation(validatedGroups, excluded)
		if (!confirmed) {
			outro(dim("Cancelled."))
			return "cancelled"
		}
	}

	// Step 6: Sequential multi-commit loop
	for (let i = 0; i < validatedGroups.length; i++) {
		const group = validatedGroups[i]
		showGroupProgress(i + 1, validatedGroups.length, group.name)

		// Unstage everything first, then stage only this group's files
		await resetStaging()
		await stageFiles(group.files)

		// Get diff for this group
		const diffResult = await getStagedDiff()
		if (!diffResult || "excludedFiles" in diffResult) {
			log.warn(red(`No changes found for group "${group.name}" — skipping.`))
			continue
		}

		// Generate message
		s.start("Generating commit message...")
		let message: string
		try {
			message = await generateMessage(diffResult.diff, flags.hint)
		} catch (err) {
			s.stop(red("Failed to generate message."))
			outro(red(err instanceof Error ? err.message : String(err)))
			return "cancelled"
		}
		s.stop("Message generated")
		log.info(dim(message))

		// Review message (skip in auto mode or auto-accept)
		if (skipPrompts) {
			debug("Accepting generated message (auto=%s autoAccept=%s)", flags.auto, autoAccept)
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
				return "cancelled"
			}
			message = reviewed
		}

		// Cache message
		const { getRepoRoot } = await import("../services/git.js")
		const repoRoot = await getRepoRoot()
		await saveCachedCommit(repoRoot, message)

		// Attempt commit
		s.start("Running pre-commit hooks...")
		const headBefore = await getHead()
		const commitResult = await attemptCommit(message, [], createProgressHandler(s))
		const headAfter = await getHead()

		if (commitResult.ok || headBefore !== headAfter) {
			s.stop("Committed successfully.")
			const checks = parseToolChecks(commitResult.stderr ?? "")
			if (checks.length > 0) {
				const lines = checks.map((c) => `  ${c.ok ? green("✓") : red("✗")} ${c.tool}`)
				log.info(lines.join("\n"))
			}
			continue
		}

		// Hook failure — stop sequence, show recovery menu
		s.stop("Commit failed.")
		const errors = parseHookErrors(commitResult.stderr ?? "")
		const recoveryResult = await showRecoveryMenu(
			errors,
			async () => (await attemptCommit(message)).ok,
			async (msg) => (await attemptCommitNoVerify(msg)).ok,
			async () => {
				await stageFiles(group.files)
				return (await attemptCommit(message)).ok
			},
			message,
			commitResult.stderr ?? "",
		)
		if (recoveryResult === "committed") {
			if (i < validatedGroups.length - 1) {
				continue
			}
			return "committed"
		}
		return recoveryResult
	}

	outro(green("All groups committed."))
	return "committed"
}

export async function generateMessage(diff: string, hint?: string): Promise<string> {
	const config = await readConfig()
	const resolvedProvider = config.provider ?? "groq"
	const provider: ProviderName = isValidProvider(resolvedProvider) ? resolvedProvider : "groq"
	const apiKey = await getProviderApiKey(provider)
	const model = getModelForProvider(config, provider, PROVIDER_CONFIGS[provider].defaultModel)
	debug("Generating message with provider:", provider, "model:", model, "type:", config.type)

	return generateCommitMessage(diff, {
		apiKey,
		model,
		type: config.type,
		timeout: config.timeout ? parseInt(config.timeout, 10) : undefined,
		hint,
		provider,
		proxy: config.proxy,
	})
}

export function buildExcludedFilesMessage(files: string[]): string {
	const excludes = getDefaultExcludes()
	const isLockfile = (f: string) =>
		excludes.some((pattern) => {
			if (pattern.endsWith(".lock") || pattern.endsWith(".json")) {
				return f === pattern || f.endsWith(pattern.replace("*.", "."))
			}
			return false
		})

	if (files.every(isLockfile)) {
		return "chore: update lockfile"
	}

	return "chore: update generated files"
}
