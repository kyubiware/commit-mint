import { beforeEach, describe, expect, it, vi } from "vitest"

// Hoisted mock fns
const { mockDetectConfig, mockRunAllChecks, mockShowCheckFailureMenu, mockParseCheckErrors } =
	vi.hoisted(() => ({
		mockDetectConfig: vi.fn(),
		mockRunAllChecks: vi.fn(),
		mockShowCheckFailureMenu: vi.fn(),
		mockParseCheckErrors: vi.fn(),
	}))

vi.mock("../services/checks.js", () => ({
	detectConfig: mockDetectConfig,
	runAllChecks: mockRunAllChecks,
}))

vi.mock("../services/hooks.js", () => ({
	parseCheckErrors: mockParseCheckErrors,
}))

vi.mock("../ui/check-failure-menu.js", () => ({
	showCheckFailureMenu: mockShowCheckFailureMenu,
}))

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}))

beforeEach(() => {
	vi.resetAllMocks()
	mockDetectConfig.mockResolvedValue("/fake/repo/.cmintrc")
	mockRunAllChecks.mockResolvedValue({ ok: true, results: [] })
	mockParseCheckErrors.mockReturnValue([])
})

describe("runCheckPhaseInteractive", () => {
	it("returns 'passed' when checks run and pass", async () => {
		const { runCheckPhaseInteractive } = await import("./check-phase.js")
		mockRunAllChecks.mockResolvedValue({ ok: true, results: [] })

		const outcome = await runCheckPhaseInteractive("/fake/repo", ["src/a.ts"], 60000)

		expect(outcome).toBe("passed")
		expect(mockRunAllChecks).toHaveBeenCalledTimes(1)
		expect(mockRunAllChecks).toHaveBeenCalledWith(
			"/fake/repo",
			["src/a.ts"],
			60000,
			expect.any(Object),
		)
	})

	it("returns 'passed' without running checks when no .cmintrc exists", async () => {
		const { runCheckPhaseInteractive } = await import("./check-phase.js")
		mockDetectConfig.mockResolvedValue(null)

		const outcome = await runCheckPhaseInteractive("/fake/repo", ["src/a.ts"], 60000)

		expect(outcome).toBe("passed")
		expect(mockRunAllChecks).not.toHaveBeenCalled()
	})

	it("returns 'skipped' when checks fail and user picks skip", async () => {
		const { runCheckPhaseInteractive } = await import("./check-phase.js")
		mockRunAllChecks.mockResolvedValue({
			ok: false,
			results: [
				{ ok: false, tool: "biome", command: "biome check", stdout: "", stderr: "err", files: [] },
			],
		})
		mockShowCheckFailureMenu.mockResolvedValue("skipped")

		const outcome = await runCheckPhaseInteractive("/fake/repo", ["src/a.ts"], 60000)

		expect(outcome).toBe("skipped")
		expect(mockShowCheckFailureMenu).toHaveBeenCalledTimes(1)
		expect(mockParseCheckErrors).toHaveBeenCalledTimes(1)
	})

	it("returns 'cancelled' when checks fail and user picks cancel", async () => {
		const { runCheckPhaseInteractive } = await import("./check-phase.js")
		mockRunAllChecks.mockResolvedValue({
			ok: false,
			results: [
				{ ok: false, tool: "biome", command: "biome check", stdout: "", stderr: "err", files: [] },
			],
		})
		mockShowCheckFailureMenu.mockResolvedValue("cancelled")

		const outcome = await runCheckPhaseInteractive("/fake/repo", ["src/a.ts"], 60000)

		expect(outcome).toBe("cancelled")
	})

	it("re-runs checks after user picks retry, then returns 'passed' when retry succeeds", async () => {
		const { runCheckPhaseInteractive } = await import("./check-phase.js")
		mockRunAllChecks
			.mockResolvedValueOnce({
				ok: false,
				results: [
					{
						ok: false,
						tool: "biome",
						command: "biome check",
						stdout: "",
						stderr: "err",
						files: [],
					},
				],
			})
			// After "retried", the loop body re-runs checks (showCheckFailureMenu
			// mock doesn't invoke the retry callback — only the loop body re-run counts)
			.mockResolvedValueOnce({ ok: true, results: [] })
		mockShowCheckFailureMenu.mockResolvedValue("retried")

		const outcome = await runCheckPhaseInteractive("/fake/repo", ["src/a.ts"], 60000)

		expect(outcome).toBe("passed")
		expect(mockShowCheckFailureMenu).toHaveBeenCalledTimes(1)
		expect(mockRunAllChecks).toHaveBeenCalledTimes(2)
	})

	it("invokes onRetry callback before re-running checks on retry", async () => {
		const { runCheckPhaseInteractive } = await import("./check-phase.js")
		const onRetry = vi.fn().mockResolvedValue(undefined)
		mockRunAllChecks
			.mockResolvedValueOnce({
				ok: false,
				results: [
					{
						ok: false,
						tool: "biome",
						command: "biome check",
						stdout: "",
						stderr: "err",
						files: [],
					},
				],
			})
			.mockResolvedValueOnce({ ok: true, results: [] })
			.mockResolvedValueOnce({ ok: true, results: [] })
		mockShowCheckFailureMenu.mockResolvedValue("retried")

		await runCheckPhaseInteractive("/fake/repo", ["src/a.ts"], 60000, onRetry)

		expect(onRetry).toHaveBeenCalledTimes(1)
		// onRetry fires AFTER showCheckFailureMenu returns "retried"
		// and BEFORE the second runAllChecks call from the loop body
		expect(mockShowCheckFailureMenu).toHaveBeenCalledBefore(onRetry)
	})

	it("does NOT invoke onRetry on the initial check run", async () => {
		const { runCheckPhaseInteractive } = await import("./check-phase.js")
		const onRetry = vi.fn().mockResolvedValue(undefined)
		mockRunAllChecks.mockResolvedValue({ ok: true, results: [] })

		await runCheckPhaseInteractive("/fake/repo", ["src/a.ts"], 60000, onRetry)

		expect(onRetry).not.toHaveBeenCalled()
	})

	it("passes rawOutput built from failed results to parseCheckErrors and showCheckFailureMenu", async () => {
		const { runCheckPhaseInteractive } = await import("./check-phase.js")
		const failedResult = {
			ok: false,
			tool: "biome",
			command: "biome check src/a.ts",
			stdout: "stdout-content",
			stderr: "stderr-content",
			files: ["src/a.ts"],
		}
		mockRunAllChecks.mockResolvedValue({ ok: false, results: [failedResult] })
		mockShowCheckFailureMenu.mockResolvedValue("skipped")

		await runCheckPhaseInteractive("/fake/repo", ["src/a.ts"], 60000)

		// rawOutput format: `[tool]\nstdout\nstderr` trimmed, joined with blank line
		const expectedRaw = "[biome]\nstdout-content\nstderr-content"
		expect(mockParseCheckErrors).toHaveBeenCalledWith(expectedRaw)
		expect(mockShowCheckFailureMenu).toHaveBeenCalledWith(
			expect.any(Array),
			expectedRaw,
			expect.any(Function),
		)
	})
})
