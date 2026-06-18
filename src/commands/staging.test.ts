import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChangedFile } from "../services/git.js"

// Hoisted mock fns so we can wire default behavior + per-test overrides
const {
	mockGetChangedFiles,
	mockGetStagedFiles,
	mockGetRepoRoot,
	mockDetectConfig,
	mockRunAllChecks,
	mockStopCheckSpinner,
	mockStageFiles,
} = vi.hoisted(() => ({
	mockGetChangedFiles: vi.fn(),
	mockGetStagedFiles: vi.fn(),
	mockGetRepoRoot: vi.fn(),
	mockDetectConfig: vi.fn(),
	mockRunAllChecks: vi.fn(),
	mockStopCheckSpinner: vi.fn(),
	mockStageFiles: vi.fn(),
}))

vi.mock("../services/git.js", () => ({
	getChangedFiles: mockGetChangedFiles,
	getStagedFiles: mockGetStagedFiles,
	getRepoRoot: mockGetRepoRoot,
	stageAll: vi.fn(),
	stageFiles: mockStageFiles,
}))

vi.mock("../services/checks.js", () => ({
	detectConfig: mockDetectConfig,
	runAllChecks: mockRunAllChecks,
}))

vi.mock("../ui/check-summary.js", () => ({
	stopCheckSpinner: mockStopCheckSpinner,
}))

vi.mock("../ui/check-failure-menu.js", () => ({
	showCheckFailureMenu: vi.fn(),
}))

vi.mock("../ui/staging-menu.js", () => ({
	showStagingMenu: vi.fn(),
}))

vi.mock("../services/hooks.js", () => ({
	parseCheckErrors: vi.fn(),
}))

vi.mock("@clack/prompts", () => ({
	spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
	log: { info: vi.fn() },
	outro: vi.fn(),
}))

vi.mock("kolorist", () => ({
	dim: (s: string) => s,
	red: (s: string) => s,
}))

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}))

vi.mock("./auto-group.js", () => ({
	runAutoGroupFlow: vi.fn(),
}))

beforeEach(() => {
	vi.clearAllMocks()
	mockGetRepoRoot.mockResolvedValue("/fake/repo")
	mockDetectConfig.mockResolvedValue("/fake/repo/.cmintrc.ts")
	mockGetStagedFiles.mockResolvedValue([])
	mockRunAllChecks.mockResolvedValue({ ok: true, results: [] })
	mockStopCheckSpinner.mockReturnValue(undefined)
	mockStageFiles.mockResolvedValue(undefined)
	mockGetChangedFiles.mockResolvedValue([])
})
describe("runPreCommitChecks", () => {
	it("passes repo-root-relative staged paths to runAllChecks (not cwd-relative)", async () => {
		const { runPreCommitChecks } = await import("./staging.js")

		// Simulate running `cmint` from a subdirectory:
		//   - getChangedFiles returns paths relative to cwd (background/index.ts)
		//   - .cmintrc globs are written from repo root (extension/**)
		//   - getStagedFiles returns repo-root-relative paths
		const cwdRelative: ChangedFile[] = [
			{ path: "background/index.ts", status: "M", staged: true },
			{ path: "popup/Popup.tsx", status: "M", staged: true },
		]
		const repoRootRelative = ["extension/background/index.ts", "extension/popup/Popup.tsx"]
		mockGetStagedFiles.mockResolvedValue(repoRootRelative)

		await runPreCommitChecks(cwdRelative, /* noCheck */ undefined)

		expect(mockRunAllChecks).toHaveBeenCalledTimes(1)
		const [, stagedPaths] = mockRunAllChecks.mock.calls[0]
		expect(stagedPaths).toEqual(repoRootRelative)
		expect(stagedPaths).not.toEqual(["background/index.ts", "popup/Popup.tsx"])
	})

	it("skips entirely when no staged files exist", async () => {
		const { runPreCommitChecks } = await import("./staging.js")
		mockGetStagedFiles.mockResolvedValue([])

		await runPreCommitChecks([], undefined)

		expect(mockRunAllChecks).not.toHaveBeenCalled()
	})

	it("skips entirely when --noCheck is set", async () => {
		const { runPreCommitChecks } = await import("./staging.js")
		mockGetStagedFiles.mockResolvedValue(["extension/foo.ts"])

		await runPreCommitChecks([{ path: "foo.ts", status: "M", staged: true }], /* noCheck */ true)

		expect(mockRunAllChecks).not.toHaveBeenCalled()
	})
})

describe("handleStaging", () => {
	it("'checks' branch passes repo-root-relative paths to runAllChecks", async () => {
		const { handleStaging } = await import("./staging.js")
		const { showStagingMenu } = await import("../ui/staging-menu.js")

		// User picks "checks" once, then "cancel" (null) on the next loop iteration
		vi.mocked(showStagingMenu).mockResolvedValueOnce("checks").mockResolvedValueOnce(null)

		// cwd-relative (user ran cmint from a subdirectory)
		const cwdRelative: ChangedFile[] = [{ path: "background/index.ts", status: "M", staged: false }]
		// repo-root-relative (what getStagedFiles returns after stageAll)
		const repoRootRelative = ["extension/background/index.ts"]
		mockGetStagedFiles.mockResolvedValue(repoRootRelative)
		mockGetChangedFiles.mockResolvedValue(cwdRelative)

		await handleStaging(cwdRelative, {
			auto: false,
			agent: false,
			retry: false,
			message: undefined,
			hint: undefined,
			noCheck: false,
		})

		expect(mockRunAllChecks).toHaveBeenCalledTimes(1)
		const [, stagedPaths] = mockRunAllChecks.mock.calls[0]
		expect(stagedPaths).toEqual(repoRootRelative)
		expect(stagedPaths).not.toEqual(["background/index.ts"])
	})
})
