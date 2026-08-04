import { beforeEach, describe, expect, it, vi } from "vitest"
import { commitCommand } from "./commit.js"

// Staging-loop tests for commitCommand: after a successful subset commit
// ("Select files...", "Commit staged files only"), the CLI must re-check for
// uncommitted files and loop back to the staging menu instead of exiting.
// Kept in a separate file because commit.test.ts is at the 800-line test cap.

// Mock all external dependencies
vi.mock("@clack/prompts", () => ({
	intro: vi.fn(),
	outro: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn() },
	spinner: vi.fn(() => ({
		start: vi.fn(),
		stop: vi.fn(),
	})),
	isCancel: vi.fn(() => false),
	select: vi.fn(() => "use"),
	multiselect: vi.fn(),
	note: vi.fn(),
	text: vi.fn(),
}))

vi.mock("../services/git.js", () => ({
	assertGitRepo: vi.fn(),
	getChangedFiles: vi.fn(),
	getStagedDiff: vi.fn(),
	getStagedFiles: vi.fn(),
	stageAll: vi.fn(),
	stageFiles: vi.fn(),
	getHead: vi.fn(),
	attemptCommit: vi.fn(),
	attemptCommitNoVerify: vi.fn(),
	getStatusShort: vi.fn(),
	getRepoRoot: vi.fn(),
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
}))

vi.mock("../services/hooks.js", () => ({
	parseHookErrors: vi.fn(() => []),
	parseCheckErrors: vi.fn(() => []),
	parseToolChecks: vi.fn(() => []),
}))

vi.mock("../services/checks.js", () => ({
	runAllChecks: vi.fn(),
	detectConfig: vi.fn(() => Promise.resolve(null)),
}))

vi.mock("../ui/check-failure-menu.js", () => ({
	showCheckFailureMenu: vi.fn(),
}))

vi.mock("../ui/staging-menu.js", () => ({
	showStagingMenu: vi.fn(),
}))

vi.mock("../ui/review-message.js", () => ({
	reviewCommitMessage: vi.fn(),
}))

vi.mock("../services/auto-accept.js", () => ({
	getAutoAccept: vi.fn().mockResolvedValue(false),
}))

vi.mock("../utils/cache.js", () => ({
	saveCachedCommit: vi.fn(),
	loadCachedCommit: vi.fn(),
}))

vi.mock("../services/update-check.js", () => ({
	checkForUpdatesUpfront: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../services/ai.js", () => ({
	generateCommitMessage: vi.fn(),
}))

vi.mock("../services/hook-progress.js", () => ({
	createProgressHandler: vi.fn(() => vi.fn()),
}))

vi.mock("../services/clipboard.js", () => ({
	copyToClipboard: vi.fn(),
}))

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
	setDebug: vi.fn(),
	isDebug: vi.fn(() => false),
}))

import { generateCommitMessage } from "../services/ai.js"
import { getAutoAccept } from "../services/auto-accept.js"
import { runAllChecks } from "../services/checks.js"
import { getProviderApiKey, readConfig } from "../services/config.js"
import {
	attemptCommit,
	getChangedFiles,
	getHead,
	getRepoRoot,
	getStagedDiff,
	getStagedFiles,
	getStatusShort,
	stageAll,
	stageFiles,
} from "../services/git.js"
import { reviewCommitMessage } from "../ui/review-message.js"
import { showStagingMenu } from "../ui/staging-menu.js"

describe("commitCommand staging loop", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Preflight in commitCommand calls getRepoRoot — set a sensible default
		vi.mocked(getRepoRoot).mockResolvedValue("/tmp/test-repo")
		vi.mocked(runAllChecks).mockResolvedValue({ ok: true, results: [] })
		vi.mocked(getStagedFiles).mockResolvedValue(["src/foo.ts"])
		vi.mocked(getAutoAccept).mockResolvedValue(false)
		vi.mocked(showStagingMenu).mockResolvedValue({
			files: ["src/foo.ts"],
			all: true,
		})
	})

	it("loops back to the staging menu after committing a selection while files remain", async () => {
		// User selects only foo.ts first, commits, then is re-shown the staging
		// menu for the remaining bar.ts and commits it too. `noCheck` keeps the
		// getChangedFiles call sequence deterministic (no re-stage pass).
		vi.mocked(getStatusShort).mockResolvedValue("M  src/foo.ts\nM  src/bar.ts")
		vi.mocked(getChangedFiles)
			// call 1 — initial scan
			.mockResolvedValueOnce([
				{ status: "M", path: "src/foo.ts", staged: false },
				{ status: "M", path: "src/bar.ts", staged: false },
			])
			// call 2 — loop refresh after staging foo.ts
			.mockResolvedValueOnce([
				{ status: "M", path: "src/foo.ts", staged: true },
				{ status: "M", path: "src/bar.ts", staged: false },
			])
			// call 3 — remaining after commit 1
			.mockResolvedValueOnce([{ status: "M", path: "src/bar.ts", staged: false }])
			// call 4 — loop refresh after staging bar.ts
			.mockResolvedValueOnce([{ status: "M", path: "src/bar.ts", staged: true }])
			// call 5 — remaining after commit 2: nothing left
			.mockResolvedValue([])
		vi.mocked(showStagingMenu)
			.mockResolvedValueOnce({ files: ["src/foo.ts"], all: false })
			.mockResolvedValueOnce({ files: ["src/bar.ts"], all: false })
		vi.mocked(stageFiles).mockResolvedValue(undefined)
		vi.mocked(getStagedDiff).mockResolvedValue({
			files: ["src/foo.ts"],
			diff: "some diff",
		})
		vi.mocked(getProviderApiKey).mockResolvedValue("gsk_test_key")
		vi.mocked(readConfig).mockResolvedValue({
			model: "openai/gpt-oss-20b",
			locale: "en",
		})
		vi.mocked(generateCommitMessage).mockResolvedValue("feat: test commit")
		vi.mocked(reviewCommitMessage).mockResolvedValue("feat: test commit")
		vi.mocked(attemptCommit).mockResolvedValue({ ok: true })
		vi.mocked(getHead).mockResolvedValue("abc123")

		await commitCommand({ retry: false, auto: false, agent: false, noCheck: true }, "0.0.0-test")

		// Staging menu shown twice: initial selection + loop-back for the rest
		expect(showStagingMenu).toHaveBeenCalledTimes(2)
		expect(showStagingMenu).toHaveBeenNthCalledWith(
			1,
			[
				{ status: "M", path: "src/foo.ts", staged: false },
				{ status: "M", path: "src/bar.ts", staged: false },
			],
			false,
		)
		expect(showStagingMenu).toHaveBeenNthCalledWith(
			2,
			[{ status: "M", path: "src/bar.ts", staged: false }],
			false,
		)
		// Each selection is staged and committed individually
		expect(stageFiles).toHaveBeenNthCalledWith(1, ["src/foo.ts"])
		expect(stageFiles).toHaveBeenNthCalledWith(2, ["src/bar.ts"])
		expect(attemptCommit).toHaveBeenCalledTimes(2)
		// Second commit had nothing left — exited with Done
		const { outro } = await import("@clack/prompts")
		expect(vi.mocked(outro)).toHaveBeenCalledWith(expect.stringContaining("Done."))
	})

	it("loops back after committing excluded files from a selection", async () => {
		// User selects only package-lock.json (an excluded file) → hardcoded
		// "chore: update lockfile" commit → menu re-shown → stage all → commit.
		vi.mocked(getStatusShort).mockResolvedValue("M  package-lock.json\nM  src/foo.ts")
		vi.mocked(getChangedFiles)
			.mockResolvedValueOnce([
				{ status: "M", path: "package-lock.json", staged: false },
				{ status: "M", path: "src/foo.ts", staged: false },
			])
			.mockResolvedValueOnce([
				{ status: "M", path: "package-lock.json", staged: true },
				{ status: "M", path: "src/foo.ts", staged: false },
			])
			.mockResolvedValueOnce([{ status: "M", path: "src/foo.ts", staged: false }])
			.mockResolvedValueOnce([{ status: "M", path: "src/foo.ts", staged: true }])
			.mockResolvedValue([])
		vi.mocked(showStagingMenu)
			.mockResolvedValueOnce({ files: ["package-lock.json"], all: false })
			.mockResolvedValueOnce({ files: ["src/foo.ts"], all: true })
		vi.mocked(stageFiles).mockResolvedValue(undefined)
		vi.mocked(stageAll).mockResolvedValue(undefined)
		vi.mocked(getStagedDiff)
			.mockResolvedValueOnce({ excludedFiles: ["package-lock.json"] })
			.mockResolvedValue({ files: ["src/foo.ts"], diff: "some diff" })
		vi.mocked(getProviderApiKey).mockResolvedValue("gsk_test_key")
		vi.mocked(readConfig).mockResolvedValue({
			model: "openai/gpt-oss-20b",
			locale: "en",
		})
		vi.mocked(generateCommitMessage).mockResolvedValue("feat: test commit")
		vi.mocked(reviewCommitMessage).mockResolvedValue("feat: test commit")
		vi.mocked(attemptCommit).mockResolvedValue({ ok: true })
		vi.mocked(getHead).mockResolvedValue("abc123")

		await commitCommand({ retry: false, auto: false, agent: false, noCheck: true }, "0.0.0-test")

		// Excluded commit used the hardcoded message, then the remaining file
		// got an AI-generated message in the second cycle
		expect(attemptCommit).toHaveBeenNthCalledWith(
			1,
			"chore: update lockfile",
			[],
			expect.any(Function),
		)
		expect(attemptCommit).toHaveBeenNthCalledWith(2, "feat: test commit", [], expect.any(Function))
		expect(showStagingMenu).toHaveBeenCalledTimes(2)
		// No AI generation for the excluded-only commit
		expect(generateCommitMessage).toHaveBeenCalledTimes(1)
		const { outro } = await import("@clack/prompts")
		expect(vi.mocked(outro)).toHaveBeenCalledWith(expect.stringContaining("Done."))
	})

	it("exits cleanly when the user cancels from the loop-back staging menu", async () => {
		vi.mocked(getStatusShort).mockResolvedValue("M  src/foo.ts\nM  src/bar.ts")
		vi.mocked(getChangedFiles)
			.mockResolvedValueOnce([
				{ status: "M", path: "src/foo.ts", staged: false },
				{ status: "M", path: "src/bar.ts", staged: false },
			])
			.mockResolvedValueOnce([
				{ status: "M", path: "src/foo.ts", staged: true },
				{ status: "M", path: "src/bar.ts", staged: false },
			])
			.mockResolvedValueOnce([{ status: "M", path: "src/bar.ts", staged: false }])
		vi.mocked(showStagingMenu)
			.mockResolvedValueOnce({ files: ["src/foo.ts"], all: false })
			.mockResolvedValueOnce(null)
		vi.mocked(stageFiles).mockResolvedValue(undefined)
		vi.mocked(getStagedDiff).mockResolvedValue({
			files: ["src/foo.ts"],
			diff: "some diff",
		})
		vi.mocked(getProviderApiKey).mockResolvedValue("gsk_test_key")
		vi.mocked(readConfig).mockResolvedValue({
			model: "openai/gpt-oss-20b",
			locale: "en",
		})
		vi.mocked(generateCommitMessage).mockResolvedValue("feat: test commit")
		vi.mocked(reviewCommitMessage).mockResolvedValue("feat: test commit")
		vi.mocked(attemptCommit).mockResolvedValue({ ok: true })
		vi.mocked(getHead).mockResolvedValue("abc123")

		await commitCommand({ retry: false, auto: false, agent: false, noCheck: true }, "0.0.0-test")

		// One commit, then cancel from the re-shown menu — no "Done." outro
		expect(attemptCommit).toHaveBeenCalledTimes(1)
		expect(showStagingMenu).toHaveBeenCalledTimes(2)
		const { outro } = await import("@clack/prompts")
		expect(vi.mocked(outro)).toHaveBeenCalledWith(expect.stringContaining("Cancelled."))
		expect(vi.mocked(outro)).not.toHaveBeenCalledWith(expect.stringContaining("Done."))
	})
})
