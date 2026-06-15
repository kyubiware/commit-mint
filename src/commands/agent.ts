import { generateCommitMessage } from "../services/ai.js"
import { detectConfig, runAllChecks } from "../services/checks.js"
import { getModelForProvider, getProviderApiKey, readConfig } from "../services/config.js"
import {
	assertGitRepo,
	attemptCommit,
	getChangedFiles,
	getHead,
	getRepoRoot,
	getStagedDiff,
	getStatusShort,
	resetStaging,
	stageFiles,
} from "../services/git.js"
import {
	type CommitGroup,
	filterExcludedFiles,
	generateGroups,
	validateGroups,
} from "../services/grouping.js"
import { parseCheckErrors, parseHookErrors } from "../services/hooks.js"
import {
	isValidProvider,
	PROVIDER_CONFIGS,
	PROVIDER_ENV_KEYS,
	type ProviderName,
} from "../services/provider.js"
import { type AgentCommit, EXIT_CODES, writeAgentResult } from "../utils/agent.js"
import { saveCachedCommit } from "../utils/cache.js"
import { debug } from "../utils/debug.js"
import { buildExcludedFilesMessage, type CommitFlags } from "./auto-group.js"

/**
 * Headless agent command — orchestrates the entire commit flow without any TUI
 * interaction. Emits structured JSON results to stdout, one per line. Returns
 * control to the caller with `process.exitCode` set to one of the 7 documented
 * exit codes (0=success, 1=generic, 2=no_changes, 3=git, 4=ai, 5=check, 6=hook).
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Multi-phase state machine (validate→stage→diff→exclude→message→check→group→commit)
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Sequential orchestration with no helper extraction (per task spec)
export async function agentCommand(flags: CommitFlags): Promise<void> {
	debug("agentCommand called", { flags })

	// 1. Validate flags
	if (flags.retry) {
		process.exitCode = EXIT_CODES.GENERIC
		writeAgentResult({
			status: "failure",
			commits: [],
			errors: ["--agent is not compatible with --retry"],
		})
		return
	}

	// 2. Assert git repo
	try {
		await assertGitRepo()
	} catch (err) {
		process.exitCode = EXIT_CODES.GIT
		writeAgentResult({
			status: "failure",
			commits: [],
			errors: [err instanceof Error ? err.message : String(err)],
		})
		return
	}

	// 3. Check status
	const status = await getStatusShort()
	debug("Git status:", status || "(empty)")
	if (!status) {
		process.exitCode = EXIT_CODES.NO_CHANGES
		writeAgentResult({ status: "no_changes", commits: [] })
		return
	}

	// 4. Auto-stage all changed files
	const changedFiles = await getChangedFiles()
	debug("Changed files:", changedFiles.length)
	await stageFiles(changedFiles.map((f) => f.path))

	// 5. Get diff (3-way union: StagedDiffResult | ExcludedFilesResult | null)
	const diffResult = await getStagedDiff()
	if (!diffResult) {
		process.exitCode = EXIT_CODES.NO_CHANGES
		writeAgentResult({ status: "no_changes", commits: [] })
		return
	}

	// Handle ExcludedFilesResult (all staged files are excluded) — hardcoded message
	if ("excludedFiles" in diffResult) {
		debug("All staged files are excluded:", diffResult.excludedFiles)
		const message = buildExcludedFilesMessage(diffResult.excludedFiles)

		const headBefore = await getHead()
		const result = await attemptCommit(message)
		const headAfter = await getHead()

		if (result.ok || headBefore !== headAfter) {
			process.exitCode = EXIT_CODES.SUCCESS
			writeAgentResult({
				status: "success",
				commits: [{ message, hash: headAfter ?? "", files: diffResult.excludedFiles }],
			})
		} else {
			process.exitCode = EXIT_CODES.HOOK
			const errors = parseHookErrors(result.stderr ?? "")
			writeAgentResult({
				status: "failure",
				commits: [],
				errors: errors.map((e) => `[${e.tool}] ${e.message}`),
			})
		}
		return
	}

	// 6. Handle --message (single-commit mode: skip AI + auto-group)
	if (flags.message) {
		debug("Using provided message:", flags.message)
		const headBefore = await getHead()
		const result = await attemptCommit(flags.message)
		const headAfter = await getHead()

		if (result.ok || headBefore !== headAfter) {
			process.exitCode = EXIT_CODES.SUCCESS
			writeAgentResult({
				status: "success",
				commits: [{ message: flags.message, hash: headAfter ?? "", files: diffResult.files }],
			})
		} else {
			process.exitCode = EXIT_CODES.HOOK
			const errors = parseHookErrors(result.stderr ?? "")
			writeAgentResult({
				status: "failure",
				commits: [],
				errors: errors.map((e) => `[${e.tool}] ${e.message}`),
			})
		}
		return
	}

	// 7. Run user-defined pre-commit checks (unless --noCheck)
	if (!flags.noCheck) {
		const repoRoot = await getRepoRoot()
		const configPath = await detectConfig(repoRoot)
		if (configPath) {
			debug("Running user checks on changed files...")
			const allFiles = changedFiles.filter((f) => f.status !== "D").map((f) => f.path)
			const checkResults = await runAllChecks(repoRoot, allFiles, 60000)
			if (!checkResults.ok) {
				const failed = checkResults.results.filter((r) => !r.ok)
				const errorMessages = failed
					.map((r) => `[${r.tool}]\n${r.stdout}\n${r.stderr}`.trim())
					.filter(Boolean)
				const parsed = parseCheckErrors(errorMessages.join("\n\n"))
				const errors =
					parsed.length > 0 ? parsed.map((e) => `[${e.tool}] ${e.message}`) : errorMessages
				process.exitCode = EXIT_CODES.CHECK
				writeAgentResult({ status: "failure", commits: [], errors })
				return
			}
		}
	}

	// 8. Auto-group flow
	// Step 8a: Filter and commit excluded files
	const { included, excluded } = filterExcludedFiles(changedFiles)
	debug("Auto-group: %d included, %d excluded", included.length, excluded.length)

	if (excluded.length > 0) {
		const message = buildExcludedFilesMessage(excluded)
		debug("Committing %d excluded files:", excluded.length, excluded)
		await resetStaging()
		await stageFiles(excluded)

		const headBefore = await getHead()
		const result = await attemptCommit(message)
		const headAfter = await getHead()
		if (!result.ok && headBefore === headAfter) {
			debug("Excluded files commit failed, continuing without them")
		}
	}

	// If only excluded files existed, we're done
	if (included.length === 0) {
		process.exitCode = EXIT_CODES.SUCCESS
		writeAgentResult({ status: "success", commits: [] })
		return
	}

	// Step 8b: Read config and resolve provider
	const config = await readConfig()
	const provider: ProviderName = isValidProvider(config.provider ?? "groq")
		? (config.provider as ProviderName)
		: "groq"

	// Step 8c: Get API key (fail with AI exit code if missing)
	let apiKey: string
	try {
		apiKey = await getProviderApiKey(provider)
	} catch {
		process.exitCode = EXIT_CODES.AI
		writeAgentResult({
			status: "failure",
			commits: [],
			errors: [
				`No API key found for ${provider}. Set ${PROVIDER_ENV_KEYS[provider]} env var or run 'cmint config'`,
			],
		})
		return
	}

	const model = getModelForProvider(config, provider, PROVIDER_CONFIGS[provider].defaultModel)
	const timeout = config.timeout ? parseInt(config.timeout, 10) : undefined

	// Step 8d: Generate groups via AI
	let groups: CommitGroup[]
	try {
		const result = await generateGroups(included, apiKey, model, timeout, provider, config.proxy)
		groups = validateGroups(result.groups, included)
	} catch (err) {
		process.exitCode = EXIT_CODES.AI
		writeAgentResult({
			status: "failure",
			commits: [],
			errors: [err instanceof Error ? err.message : String(err)],
		})
		return
	}

	// Step 8e: Sequential per-group commits
	const commits: AgentCommit[] = []
	for (const group of groups) {
		debug("Processing group %d/%d: %s", commits.length + 1, groups.length, group.name)

		// Unstage everything first, then stage only this group's files
		await resetStaging()
		await stageFiles(group.files)

		// Get diff for this group
		const groupDiff = await getStagedDiff()
		if (!groupDiff || "excludedFiles" in groupDiff) {
			debug(`Skipping group "${group.name}" — no diff`)
			continue
		}

		// Generate message (auto-accept — no review step in agent mode)
		let message: string
		try {
			message = await generateCommitMessage(groupDiff.diff, {
				apiKey,
				model,
				type: config.type,
				timeout,
				hint: flags.hint,
				provider,
				proxy: config.proxy,
			})
		} catch (err) {
			process.exitCode = EXIT_CODES.AI
			writeAgentResult({
				status: "failure",
				commits,
				errors: [err instanceof Error ? err.message : String(err)],
			})
			return
		}

		// Cache message
		const repoRoot = await getRepoRoot()
		await saveCachedCommit(repoRoot, message)

		// Attempt commit (no recovery menu in agent mode)
		const headBefore = await getHead()
		const result = await attemptCommit(message)
		const headAfter = await getHead()

		if (result.ok || headBefore !== headAfter) {
			commits.push({ message, hash: headAfter ?? "", files: group.files, groupName: group.name })
			continue
		}

		// Hook failure — cancel sequence (no skip, no recovery)
		process.exitCode = EXIT_CODES.HOOK
		const errors = parseHookErrors(result.stderr ?? "")
		writeAgentResult({
			status: "failure",
			commits,
			errors: errors.map((e) => `[${e.tool}] ${e.message}`),
		})
		return
	}

	// 9. Success
	process.exitCode = EXIT_CODES.SUCCESS
	writeAgentResult({ status: "success", commits })
}
