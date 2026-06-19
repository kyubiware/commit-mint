import { beforeEach, describe, expect, it, vi } from "vitest"
import { type CommitFlags, runAutoGroupFlow } from "./auto-group.js"

// Mock all external dependencies
vi.mock("@clack/prompts", () => ({
	intro: vi.fn(),
	outro: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn(), success: vi.fn() },
	spinner: vi.fn(() => ({
		start: vi.fn(),
		stop: vi.fn(),
	})),
	isCancel: vi.fn(() => false),
	select: vi.fn(),
	multiselect: vi.fn(),
	note: vi.fn(),
	text: vi.fn(),
}))

vi.mock("../services/ai.js", () => ({
	generateCommitMessage: vi.fn(),
}))

vi.mock("../services/config.js", () => ({
	getApiKey: vi.fn(),
	readConfig: vi.fn(),
	setConfigValue: vi.fn(),
	getProviderApiKey: vi.fn(),
	getModelForProvider: vi.fn().mockReturnValue("openai/gpt-oss-20b"),
}))

vi.mock("../services/provider.js", () => ({
	isValidProvider: vi.fn(
		(name: string) => name === "groq" || name === "cerebras" || name === "mistral",
	),
	PROVIDER_CONFIGS: {
		groq: { baseURL: "https://api.groq.com/openai/v1/", defaultModel: "openai/gpt-oss-20b" },
		cerebras: { baseURL: "https://api.cerebras.ai/v1/", defaultModel: "gpt-oss-120b" },
		mistral: { baseURL: "https://api.mistral.ai/v1/", defaultModel: "mistral-small" },
	},
	PROVIDER_ENV_KEYS: {
		groq: "GROQ_API_KEY",
		cerebras: "CEREBRAS_API_KEY",
		mistral: "MISTRAL_API_KEY",
	},
	formatProviderName: vi.fn((name: string) => name.charAt(0).toUpperCase() + name.slice(1)),
}))

vi.mock("../services/git.js", () => ({
	attemptCommit: vi.fn(),
	attemptCommitNoVerify: vi.fn(),
	getDefaultExcludes: vi.fn(() => [
		"package-lock.json",
		"node_modules/**",
		"dist/**",
		"build/**",
		".next/**",
		"coverage/**",
		"*.log",
		"*.min.js",
		"*.min.css",
		"*.lock",
		".DS_Store",
	]),
	getHead: vi.fn(),
	getStagedDiff: vi.fn(),
	getStagedFiles: vi.fn(),
	resolveToRepoRoot: vi.fn((paths: string[]) => paths),
	resetStaging: vi.fn(),
	stageFiles: vi.fn(),
	getRepoRoot: vi.fn(),
}))

vi.mock("../services/hooks.js", () => ({
	parseHookErrors: vi.fn(() => []),
	parseCheckErrors: vi.fn(() => []),
	parseToolChecks: vi.fn(() => []),
}))

vi.mock("../services/grouping.js", () => ({
	filterExcludedFiles: vi.fn(),
	generateGroups: vi.fn(),
	validateGroups: vi.fn((groups) => groups),
}))

vi.mock("../ui/grouping.js", () => ({
	showGroupedFiles: vi.fn(),
	showGroupingConfirmation: vi.fn(),
	showGroupProgress: vi.fn(),
}))

vi.mock("../ui/check-failure-menu.js", () => ({
	showCheckFailureMenu: vi.fn(),
}))

vi.mock("../ui/recovery-menu.js", () => ({
	showRecoveryMenu: vi.fn(),
}))

vi.mock("../services/checks.js", () => ({
	detectConfig: vi.fn(),
	runAllChecks: vi.fn(),
}))

vi.mock("../ui/review-message.js", () => ({
	reviewCommitMessage: vi.fn(),
}))

vi.mock("../services/auto-accept.js", () => ({
	getAutoAccept: vi.fn().mockResolvedValue(false),
}))

vi.mock("../utils/cache.js", () => ({
	saveCachedCommit: vi.fn(),
}))

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}))

import { outro, spinner } from "@clack/prompts"
import { generateCommitMessage } from "../services/ai.js"
import { getAutoAccept } from "../services/auto-accept.js"
import { detectConfig, runAllChecks } from "../services/checks.js"
import { getProviderApiKey, readConfig } from "../services/config.js"
import type { ChangedFile } from "../services/git.js"
import {
	attemptCommit,
	getHead,
	getRepoRoot,
	getStagedDiff,
	resetStaging,
	resolveToRepoRoot,
	stageFiles,
} from "../services/git.js"
import { filterExcludedFiles, generateGroups } from "../services/grouping.js"
import { parseCheckErrors, parseHookErrors, parseToolChecks } from "../services/hooks.js"
import { showCheckFailureMenu } from "../ui/check-failure-menu.js"
import { showGroupingConfirmation } from "../ui/grouping.js"
import { showRecoveryMenu } from "../ui/recovery-menu.js"
import { reviewCommitMessage } from "../ui/review-message.js"

describe("runAutoGroupFlow loop control", () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	const changedFiles: ChangedFile[] = [
		{ status: "M", path: "src/a.ts", staged: true },
		{ status: "M", path: "src/b.ts", staged: true },
	]

	const flags: CommitFlags = { retry: false, auto: false, agent: false }

	const twoGroups = [
		{ name: "Group 1", description: "desc", files: ["src/a.ts"] },
		{ name: "Group 2", description: "desc", files: ["src/b.ts"] },
	]

	const oneGroup = [{ name: "Group 1", description: "desc", files: ["src/a.ts"] }]

	function setupCommonMocks(groups = twoGroups) {
		vi.mocked(filterExcludedFiles).mockReturnValue({
			included: changedFiles,
			excluded: [],
		})
		vi.mocked(generateGroups).mockResolvedValue({
			groups: groups as { name: string; description: string; files: string[] }[],
			excluded: [],
		})
		vi.mocked(showGroupingConfirmation).mockResolvedValue(true)
		vi.mocked(getProviderApiKey).mockResolvedValue("gsk_test_key")
		vi.mocked(readConfig).mockResolvedValue({
			model: "openai/gpt-oss-20b",
			locale: "en",
		})
		vi.mocked(generateCommitMessage).mockResolvedValue("feat: test message")
		vi.mocked(getStagedDiff).mockResolvedValue({ files: ["src/a.ts"], diff: "diff" })
		vi.mocked(getHead).mockResolvedValue("abc123")
		vi.mocked(getRepoRoot).mockResolvedValue("/tmp/test-repo")
		vi.mocked(reviewCommitMessage).mockImplementation(async (msg) => msg)
		vi.mocked(parseHookErrors).mockReturnValue([{ tool: "biome", message: "error", raw: "raw" }])
		vi.mocked(parseCheckErrors).mockReturnValue([{ tool: "biome", message: "error", raw: "raw" }])
		vi.mocked(parseToolChecks).mockReturnValue([])
		// Default: cmintrc config exists, checks pass (no-op) so existing tests proceed to grouping
		vi.mocked(detectConfig).mockResolvedValue("/tmp/test-repo/.cmintrc")
		vi.mocked(runAllChecks).mockResolvedValue({ ok: true, results: [] })
	}

	it("recovery success → continues to next group", async () => {
		setupCommonMocks()
		vi.mocked(attemptCommit)
			.mockResolvedValueOnce({ ok: false })
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValueOnce({ ok: true })

		vi.mocked(showRecoveryMenu).mockImplementation(async (_errors, onRetry) => {
			await onRetry()
			return "committed"
		})

		await runAutoGroupFlow(changedFiles, flags)

		expect(stageFiles).toHaveBeenCalledWith(["src/a.ts"])
		expect(stageFiles).toHaveBeenCalledWith(["src/b.ts"])
		expect(attemptCommit).toHaveBeenCalledTimes(3)
	})

	it("recovery failure → stops loop", async () => {
		setupCommonMocks()
		vi.mocked(attemptCommit).mockResolvedValueOnce({ ok: false })
		vi.mocked(showRecoveryMenu).mockResolvedValue("failed")

		await runAutoGroupFlow(changedFiles, flags)

		expect(attemptCommit).toHaveBeenCalledTimes(1)
		expect(stageFiles).toHaveBeenCalledTimes(1)
	})

	it("recovery cancelled → stops loop", async () => {
		setupCommonMocks()
		vi.mocked(attemptCommit).mockResolvedValueOnce({ ok: false })
		vi.mocked(showRecoveryMenu).mockResolvedValue("cancelled")

		await runAutoGroupFlow(changedFiles, flags)

		expect(attemptCommit).toHaveBeenCalledTimes(1)
		expect(stageFiles).toHaveBeenCalledTimes(1)
		expect(outro).not.toHaveBeenCalledWith(expect.stringContaining("All groups committed."))
	})

	it("last group recovery success → loop ends naturally", async () => {
		setupCommonMocks(oneGroup)
		vi.mocked(attemptCommit).mockResolvedValueOnce({ ok: false })
		vi.mocked(showRecoveryMenu).mockResolvedValue("committed")

		await runAutoGroupFlow([{ status: "M", path: "src/a.ts", staged: true }], flags)

		expect(attemptCommit).toHaveBeenCalledTimes(1)
		expect(outro).not.toHaveBeenCalledWith(expect.stringContaining("All groups committed."))
	})
})

describe("runAutoGroupFlow check integration", () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	const changedFiles: ChangedFile[] = [
		{ status: "M", path: "src/a.ts", staged: true },
		{ status: "M", path: "src/b.ts", staged: true },
	]

	const flags: CommitFlags = { retry: false, auto: false, agent: false }

	const twoGroups = [
		{ name: "Group 1", description: "desc", files: ["src/a.ts"] },
		{ name: "Group 2", description: "desc", files: ["src/b.ts"] },
	]

	function setupCheckMocks() {
		vi.mocked(filterExcludedFiles).mockReturnValue({
			included: changedFiles,
			excluded: [],
		})
		vi.mocked(generateGroups).mockResolvedValue({
			groups: twoGroups as { name: string; description: string; files: string[] }[],
			excluded: [],
		})
		vi.mocked(showGroupingConfirmation).mockResolvedValue(true)
		vi.mocked(getProviderApiKey).mockResolvedValue("gsk_test_key")
		vi.mocked(readConfig).mockResolvedValue({
			model: "openai/gpt-oss-20b",
			locale: "en",
		})
		vi.mocked(generateCommitMessage).mockResolvedValue("feat: test message")
		vi.mocked(getStagedDiff).mockResolvedValue({ files: ["src/a.ts"], diff: "diff" })
		vi.mocked(getHead).mockResolvedValue("abc123")
		vi.mocked(getRepoRoot).mockResolvedValue("/tmp/test-repo")
		// Default: resolveToRepoRoot returns the same paths (test runs at repo root
		// in practice, so cwd-relative == repo-root-relative). Tests that exercise
		// the subdirectory bug override this mock per-case.
		vi.mocked(resolveToRepoRoot).mockImplementation(async (paths: string[]) => paths)
		vi.mocked(reviewCommitMessage).mockImplementation(async (msg) => msg)
		vi.mocked(parseHookErrors).mockReturnValue([{ tool: "biome", message: "error", raw: "raw" }])
		vi.mocked(parseCheckErrors).mockReturnValue([{ tool: "biome", message: "error", raw: "raw" }])
		vi.mocked(parseToolChecks).mockReturnValue([])
		vi.mocked(detectConfig).mockResolvedValue("/tmp/test-repo/.cmintrc")
		vi.mocked(attemptCommit).mockResolvedValue({ ok: true })
	}

	it("checks run once upfront with all files, not per-group", async () => {
		setupCheckMocks()
		vi.mocked(runAllChecks).mockResolvedValue({ ok: true, results: [] })

		const result = await runAutoGroupFlow(changedFiles, flags)

		// Check phase ran exactly once with all included file paths
		expect(runAllChecks).toHaveBeenCalledTimes(1)
		expect(runAllChecks).toHaveBeenCalledWith("/tmp/test-repo", ["src/a.ts", "src/b.ts"], 60000)
		// Recovery menu for checks was NOT shown (checks passed)
		expect(showCheckFailureMenu).not.toHaveBeenCalled()
		// Both groups committed normally
		expect(attemptCommit).toHaveBeenCalledTimes(2)
		expect(result).toBe("committed")
	})

	it("passes repo-root-relative paths to runAllChecks even when changedFiles are cwd-relative", async () => {
		// Auto-group runs checks BEFORE per-group staging, so the index doesn't
		// yet contain the included files. resolveToRepoRoot converts the
		// cwd-relative paths from filterExcludedFiles into repo-root-relative
		// paths that line up with .cmintrc globs (lint-staged convention).
		const cwdRelative: ChangedFile[] = [
			{ status: "M", path: "background/index.ts", staged: true },
			{ status: "M", path: "popup/Popup.tsx", staged: true },
		]
		const repoRootRelative = ["extension/background/index.ts", "extension/popup/Popup.tsx"]
		vi.mocked(filterExcludedFiles).mockReturnValue({ included: cwdRelative, excluded: [] })
		// Simulate resolveToRepoRoot prepending the "extension/" cwd prefix
		vi.mocked(resolveToRepoRoot).mockResolvedValue(repoRootRelative)
		vi.mocked(generateGroups).mockResolvedValue({
			groups: [
				{ name: "G1", description: "d", files: ["extension/background/index.ts"] },
				{ name: "G2", description: "d", files: ["extension/popup/Popup.tsx"] },
			],
			excluded: [],
		})
		vi.mocked(showGroupingConfirmation).mockResolvedValue(true)
		vi.mocked(getProviderApiKey).mockResolvedValue("gsk_test_key")
		vi.mocked(readConfig).mockResolvedValue({ model: "m", locale: "en" })
		vi.mocked(generateCommitMessage).mockResolvedValue("feat: test")
		vi.mocked(getStagedDiff).mockResolvedValue({ files: repoRootRelative, diff: "diff" })
		vi.mocked(getHead).mockResolvedValue("abc123")
		vi.mocked(getRepoRoot).mockResolvedValue("/tmp/test-repo")
		vi.mocked(reviewCommitMessage).mockImplementation(async (msg) => msg)
		vi.mocked(parseHookErrors).mockReturnValue([])
		vi.mocked(parseCheckErrors).mockReturnValue([])
		vi.mocked(parseToolChecks).mockReturnValue([])
		vi.mocked(detectConfig).mockResolvedValue("/tmp/test-repo/.cmintrc")
		vi.mocked(attemptCommit).mockResolvedValue({ ok: true })
		vi.mocked(runAllChecks).mockResolvedValue({ ok: true, results: [] })

		await runAutoGroupFlow(cwdRelative, flags)

		expect(resolveToRepoRoot).toHaveBeenCalledWith(["background/index.ts", "popup/Popup.tsx"])
		expect(runAllChecks).toHaveBeenCalledTimes(1)
		const [, stagedPaths] = vi.mocked(runAllChecks).mock.calls[0]
		expect(stagedPaths).toEqual(repoRootRelative)
		expect(stagedPaths).not.toEqual(["background/index.ts", "popup/Popup.tsx"])
	})

	it("skips the check spinner entirely when no cmintrc config exists (no empty list item)", async () => {
		setupCheckMocks()
		// No cmintrc config file
		vi.mocked(detectConfig).mockResolvedValue(null)

		const result = await runAutoGroupFlow(changedFiles, flags)

		// The checks block was skipped entirely — no "Running checks..." spinner was created
		expect(runAllChecks).not.toHaveBeenCalled()
		// The first spinner in the flow should be "Analyzing files...", not "Running checks..."
		const spinnerCalls = vi.mocked(spinner).mock.results
		if (spinnerCalls.length > 0) {
			expect(spinnerCalls[0]?.value?.start).not.toHaveBeenCalledWith("Running checks...")
		}
		// Flow still completes normally
		expect(attemptCommit).toHaveBeenCalledTimes(2)
		expect(result).toBe("committed")
	})

	it("checks fail → parses stderr into concise summaries → recovery menu → user cancels → no groups committed", async () => {
		setupCheckMocks()
		const biomeStderr =
			"src/a.ts:1:1 lint/nursery/noExcessiveLinesPerFile\n\n  ! This file has too many lines."
		vi.mocked(runAllChecks).mockResolvedValue({
			ok: false,
			results: [
				{
					ok: false,
					tool: "biome",
					command: "biome check src/a.ts",
					stdout: "",
					stderr: biomeStderr,
					files: ["src/a.ts", "src/b.ts"],
				},
			],
		})
		// parseCheckErrors returns concise 1-liners, NOT raw multi-line stderr
		const parsedErrors = [
			{
				tool: "biome",
				message: "src/a.ts:1:1 — lint/nursery/noExcessiveLinesPerFile",
				raw: biomeStderr,
			},
		]
		vi.mocked(parseCheckErrors).mockReturnValue(parsedErrors)
		vi.mocked(showCheckFailureMenu).mockResolvedValue("cancelled")

		const result = await runAutoGroupFlow(changedFiles, flags)

		// parseCheckErrors was called with the combined output
		expect(parseCheckErrors).toHaveBeenCalledWith(expect.stringContaining("[biome]"))
		// Recovery menu was shown with PARSED errors (concise 1-liners), not raw stderr
		expect(showCheckFailureMenu).toHaveBeenCalledWith(
			parsedErrors,
			expect.stringContaining("[biome]"),
			expect.any(Function),
		)
		// Flow stopped before any commit
		expect(result).toBe("cancelled")
		expect(attemptCommit).not.toHaveBeenCalled()
		expect(stageFiles).not.toHaveBeenCalled()
	})
})

describe("runAutoGroupFlow excluded files handling", () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	const flags: CommitFlags = { retry: false, auto: true, agent: false }

	function setupExcludedOnlyMocks() {
		// Only excluded files (e.g. bun.lock with no package.json change)
		vi.mocked(filterExcludedFiles).mockReturnValue({
			included: [],
			excluded: ["bun.lock"],
		})
		vi.mocked(readConfig).mockResolvedValue({
			model: "openai/gpt-oss-20b",
			locale: "en",
		})
		vi.mocked(getProviderApiKey).mockResolvedValue("gsk_test_key")
		vi.mocked(getRepoRoot).mockResolvedValue("/tmp/test-repo")
		vi.mocked(getHead).mockResolvedValue("abc123")
		vi.mocked(attemptCommit).mockResolvedValue({ ok: true })
		vi.mocked(parseToolChecks).mockReturnValue([])
		vi.mocked(detectConfig).mockResolvedValue("/tmp/test-repo/.cmintrc")
		vi.mocked(runAllChecks).mockResolvedValue({ ok: true, results: [] })
	}

	it("commits excluded-only files with hardcoded message instead of silently dropping them", async () => {
		setupExcludedOnlyMocks()

		const result = await runAutoGroupFlow([{ status: "M", path: "bun.lock", staged: true }], flags)

		// Should have staged the excluded file and committed it
		expect(resetStaging).toHaveBeenCalled()
		expect(stageFiles).toHaveBeenCalledWith(["bun.lock"])
		expect(attemptCommit).toHaveBeenCalledWith("chore: update lockfile")
		expect(result).toBe("committed")
	})

	it("commits excluded files first, then groups included files", async () => {
		const mixedFiles: ChangedFile[] = [
			{ status: "M", path: "bun.lock", staged: true },
			{ status: "M", path: "src/a.ts", staged: true },
		]

		vi.mocked(filterExcludedFiles).mockReturnValue({
			included: [{ status: "M", path: "src/a.ts", staged: true }],
			excluded: ["bun.lock"],
		})
		vi.mocked(readConfig).mockResolvedValue({
			model: "openai/gpt-oss-20b",
			locale: "en",
		})
		vi.mocked(getProviderApiKey).mockResolvedValue("gsk_test_key")
		vi.mocked(getRepoRoot).mockResolvedValue("/tmp/test-repo")
		vi.mocked(getHead).mockResolvedValue("abc123")
		vi.mocked(generateGroups).mockResolvedValue({
			groups: [{ name: "Group 1", description: "desc", files: ["src/a.ts"] }],
			excluded: [],
		})
		vi.mocked(generateCommitMessage).mockResolvedValue("feat: test message")
		vi.mocked(getStagedDiff).mockResolvedValue({ files: ["src/a.ts"], diff: "diff" })
		vi.mocked(attemptCommit).mockResolvedValue({ ok: true })
		vi.mocked(parseToolChecks).mockReturnValue([])
		vi.mocked(runAllChecks).mockResolvedValue({ ok: true, results: [] })

		await runAutoGroupFlow(mixedFiles, flags)

		// First commit: excluded files with hardcoded message
		expect(attemptCommit).toHaveBeenCalledWith("chore: update lockfile")
		// Second commit: included files via group loop (with progress handler)
		expect(attemptCommit).toHaveBeenCalledTimes(2)
		expect(generateCommitMessage).toHaveBeenCalled()
		expect(attemptCommit).toHaveBeenCalledTimes(2)
	})

	it("uses 'chore: update generated files' for non-lockfile excluded files", async () => {
		vi.mocked(filterExcludedFiles).mockReturnValue({
			included: [],
			excluded: ["dist/bundle.js"],
		})
		vi.mocked(readConfig).mockResolvedValue({
			model: "openai/gpt-oss-20b",
			locale: "en",
		})
		vi.mocked(getProviderApiKey).mockResolvedValue("gsk_test_key")
		vi.mocked(getRepoRoot).mockResolvedValue("/tmp/test-repo")
		vi.mocked(getHead).mockResolvedValue("abc123")
		vi.mocked(attemptCommit).mockResolvedValue({ ok: true })
		vi.mocked(parseToolChecks).mockReturnValue([])
		vi.mocked(runAllChecks).mockResolvedValue({ ok: true, results: [] })

		await runAutoGroupFlow([{ status: "M", path: "dist/bundle.js", staged: true }], flags)

		expect(attemptCommit).toHaveBeenCalledWith("chore: update generated files")
	})
})

describe("runAutoGroupFlow auto-accept integration", () => {
	beforeEach(() => {
		vi.resetAllMocks()
	})

	const changedFiles: ChangedFile[] = [
		{ status: "M", path: "src/a.ts", staged: true },
		{ status: "M", path: "src/b.ts", staged: true },
	]

	// Non-auto flags: user picked "Auto-group into commits" from staging menu
	const flags: CommitFlags = { retry: false, auto: false, agent: false }

	const twoGroups = [
		{ name: "Group 1", description: "desc", files: ["src/a.ts"] },
		{ name: "Group 2", description: "desc", files: ["src/b.ts"] },
	]

	function setupAutoAcceptMocks() {
		vi.mocked(filterExcludedFiles).mockReturnValue({ included: changedFiles, excluded: [] })
		vi.mocked(generateGroups).mockResolvedValue({
			groups: twoGroups as { name: string; description: string; files: string[] }[],
			excluded: [],
		})
		vi.mocked(getProviderApiKey).mockResolvedValue("gsk_test_key")
		vi.mocked(readConfig).mockResolvedValue({ model: "openai/gpt-oss-20b", locale: "en" })
		vi.mocked(generateCommitMessage).mockResolvedValue("feat: test message")
		vi.mocked(getStagedDiff).mockResolvedValue({ files: ["src/a.ts"], diff: "diff" })
		vi.mocked(getHead).mockResolvedValue("abc123")
		vi.mocked(getRepoRoot).mockResolvedValue("/tmp/test-repo")
		vi.mocked(resolveToRepoRoot).mockImplementation(async (paths: string[]) => paths)
		vi.mocked(parseHookErrors).mockReturnValue([])
		vi.mocked(parseCheckErrors).mockReturnValue([])
		vi.mocked(parseToolChecks).mockReturnValue([])
		vi.mocked(detectConfig).mockResolvedValue(null)
		vi.mocked(attemptCommit).mockResolvedValue({ ok: true })
		// Default: auto-accept OFF (preserves existing behavior)
		vi.mocked(getAutoAccept).mockResolvedValue(false)
	}

	it("skips showGroupingConfirmation when auto-accept is ON (non-auto mode)", async () => {
		setupAutoAcceptMocks()
		vi.mocked(getAutoAccept).mockResolvedValue(true)

		await runAutoGroupFlow(changedFiles, flags)

		expect(showGroupingConfirmation).not.toHaveBeenCalled()
		// Both groups still committed
		expect(attemptCommit).toHaveBeenCalledTimes(2)
	})

	it("calls showGroupingConfirmation when auto-accept is OFF (non-auto mode)", async () => {
		setupAutoAcceptMocks()
		vi.mocked(getAutoAccept).mockResolvedValue(false)
		vi.mocked(showGroupingConfirmation).mockResolvedValue(true)

		await runAutoGroupFlow(changedFiles, flags)

		expect(showGroupingConfirmation).toHaveBeenCalledOnce()
	})

	it("skips reviewCommitMessage per-group when auto-accept is ON", async () => {
		setupAutoAcceptMocks()
		vi.mocked(getAutoAccept).mockResolvedValue(true)

		await runAutoGroupFlow(changedFiles, flags)

		expect(reviewCommitMessage).not.toHaveBeenCalled()
		// Both groups committed with the generated message
		expect(attemptCommit).toHaveBeenCalledWith("feat: test message", [], expect.any(Function))
	})

	it("calls reviewCommitMessage per-group when auto-accept is OFF", async () => {
		setupAutoAcceptMocks()
		vi.mocked(getAutoAccept).mockResolvedValue(false)
		vi.mocked(showGroupingConfirmation).mockResolvedValue(true)
		vi.mocked(reviewCommitMessage).mockImplementation(async (msg) => msg)

		await runAutoGroupFlow(changedFiles, flags)

		// Two groups → review called twice
		expect(reviewCommitMessage).toHaveBeenCalledTimes(2)
	})

	it("--auto flag still skips both regardless of auto-accept setting", async () => {
		setupAutoAcceptMocks()
		// Even if auto-accept is somehow OFF, --auto should skip both
		vi.mocked(getAutoAccept).mockResolvedValue(false)

		await runAutoGroupFlow(changedFiles, { ...flags, auto: true })

		expect(showGroupingConfirmation).not.toHaveBeenCalled()
		expect(reviewCommitMessage).not.toHaveBeenCalled()
	})
})
