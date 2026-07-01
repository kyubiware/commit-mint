import { beforeEach, describe, expect, it, vi } from "vitest"
import { showCheckFailureMenu } from "./check-failure-menu.js"

// Mock all external dependencies
vi.mock("@clack/prompts", () => ({
	note: vi.fn(),
	select: vi.fn(),
	outro: vi.fn(),
	log: { info: vi.fn(), step: vi.fn(), warn: vi.fn() },
	isCancel: vi.fn(() => false),
	text: vi.fn(),
}))

vi.mock("../services/clipboard.js", () => ({
	copyToClipboard: vi.fn(),
}))

vi.mock("../services/hooks.js", () => ({}))

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}))

import { isCancel, note, select } from "@clack/prompts"
import { dim, red } from "kolorist"
import { copyToClipboard } from "../services/clipboard.js"

const mockErrors = [
	{
		tool: "biome",
		message: "src/foo.ts:1:1 — unused variable",
		raw: "src/foo.ts:1:1 — unused variable",
	},
]

const mockRawStderr = "raw stderr output from hooks"

describe("showCheckFailureMenu", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(isCancel).mockReturnValue(false)
	})

	it("summarizes single tsc error without '+more' suffix", async () => {
		const raw = "src/app.ts(5,10): error TS2304: Cannot find name 'foo'."
		const errors = [{ tool: "tsc", message: raw, raw }]
		vi.mocked(select).mockResolvedValueOnce("retry")

		await showCheckFailureMenu(errors, raw, async () => true)

		const summary = vi.mocked(note).mock.calls[0]?.[0] as string
		expect(summary).toContain("[tsc] 1 TypeScript error")
		expect(summary).toContain("src/app.ts:5:10 — error TS2304:")
		expect(summary).not.toContain("+")
		expect(summary).not.toContain("more TypeScript")
	})

	it("summarizes non-tsc errors with truncated message", async () => {
		const longMessage = "a".repeat(200)
		const errors = [{ tool: "biome", message: longMessage, raw: longMessage }]
		vi.mocked(select).mockResolvedValueOnce("retry")

		await showCheckFailureMenu(errors, longMessage, async () => true)

		const summary = vi.mocked(note).mock.calls[0]?.[0] as string
		expect(summary).toContain("[biome]")
		expect(summary).toContain("a".repeat(119))
		expect(summary).toContain("…")
	})

	it("summarizes single eslint stylish-format error with rule and message", async () => {
		const raw = [
			"/path/to/TextStudyWordRow.tsx",
			"  278:1  warning  File has too many lines (281). Maximum allowed is 277  max-lines",
			"",
			"✖ 1 problem (0 errors, 1 warning)",
			"",
			"ESLint found too many warnings (maximum: 0).",
		].join("\n")
		const errors = [{ tool: "eslint", message: raw, raw }]
		vi.mocked(select).mockResolvedValueOnce("retry")

		await showCheckFailureMenu(errors, raw, async () => true)

		const summary = vi.mocked(note).mock.calls[0]?.[0] as string
		expect(summary).toContain("[eslint] 1 ESLint problem")
		expect(summary).toContain(
			"/path/to/TextStudyWordRow.tsx:278:1 warning max-lines — File has too many lines (281). Maximum allowed is 277",
		)
		expect(summary).not.toContain("✖ 1 problem")
		expect(summary).not.toContain("ESLint found too many warnings")
	})

	it("summarizes multiple eslint errors with count and '+N more' suffix", async () => {
		const raw = [
			"/path/to/file1.tsx",
			"  10:1  error  Missing semicolon  semi",
			"  20:5  warning  Unused variable 'foo'  no-unused-vars",
			"",
			"/path/to/file2.tsx",
			"  5:1  error  Unexpected console statement  no-console",
			"  15:1  warning  File has too many lines  max-lines",
			"  25:1  error  Missing return type  @typescript-eslint/explicit-function-return-type",
			"",
			"✖ 5 problems (3 errors, 2 warnings)",
		].join("\n")
		const errors = [{ tool: "eslint", message: raw, raw }]
		vi.mocked(select).mockResolvedValueOnce("retry")

		await showCheckFailureMenu(errors, raw, async () => true)

		const summary = vi.mocked(note).mock.calls[0]?.[0] as string
		expect(summary).toContain("[eslint] 5 ESLint problems")
		expect(summary).toContain("/path/to/file1.tsx:10:1 error semi — Missing semicolon")
		expect(summary).toContain(
			"/path/to/file1.tsx:20:5 warning no-unused-vars — Unused variable 'foo'",
		)
		expect(summary).toContain(
			"/path/to/file2.tsx:5:1 error no-console — Unexpected console statement",
		)
		expect(summary).toContain("+2 more ESLint problems. View full output for details.")
		expect(summary).not.toContain("✖ 5 problems")
	})

	it("falls back to default formatting for eslint output that does not match the stylish format", async () => {
		const raw = "Some unstructured eslint error message"
		const errors = [{ tool: "eslint", message: raw, raw }]
		vi.mocked(select).mockResolvedValueOnce("retry")

		await showCheckFailureMenu(errors, raw, async () => true)

		const summary = vi.mocked(note).mock.calls[0]?.[0] as string
		expect(summary).toContain("[eslint] Some unstructured eslint error message")
		expect(summary).not.toContain("ESLint")
	})

	it("summarizes a single vitest failure with file + test name and no '+more' suffix", async () => {
		const raw = [
			" RUN  v3.2.4 /repo",
			"",
			" ❯ sample.test.ts (2 tests | 1 failed) 5ms",
			"   × describe > fails  5ms",
			"     → expected 1 to be 2",
			"",
			"⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯",
			"",
			" FAIL  sample.test.ts > describe > fails",
			"AssertionError: expected 1 to be 2",
			"",
			" Test Files  1 failed (1)",
			"      Tests  1 failed (2)",
		].join("\n")
		const errors = [{ tool: "vitest", message: raw, raw }]
		vi.mocked(select).mockResolvedValueOnce("retry")

		await showCheckFailureMenu(errors, raw, async () => true)

		const summary = vi.mocked(note).mock.calls[0]?.[0] as string
		expect(summary).toContain("[vitest] 1 failed test in 1 file")
		expect(summary).toContain("sample.test.ts")
		expect(summary).toContain(`${red("×")} describe > fails`)
		expect(summary).toContain(`${dim("→")} AssertionError: expected 1 to be 2`)
		expect(summary).not.toContain("+")
		expect(summary).not.toContain("more failed")
	})

	it("summarizes multiple vitest failures grouped by file with '+N more' suffix", async () => {
		const raw = [
			"⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯",
			"",
			" FAIL  a.test.ts > describe > first",
			"AssertionError: boom one",
			"",
			" FAIL  a.test.ts > describe > second",
			"AssertionError: boom two",
			"",
			" FAIL  b.test.ts > other > third",
			"Error: boom three",
			"",
			" FAIL  b.test.ts > other > fourth",
			"Error: boom four",
			"",
			" FAIL  b.test.ts > other > fifth",
			"Error: boom five",
			"",
		].join("\n")
		const errors = [{ tool: "vitest", message: raw, raw }]
		vi.mocked(select).mockResolvedValueOnce("retry")

		await showCheckFailureMenu(errors, raw, async () => true)

		const summary = vi.mocked(note).mock.calls[0]?.[0] as string
		expect(summary).toContain("[vitest] 5 failed tests in 2 files")
		// First 3 visible (grouped under their files)
		expect(summary).toContain("a.test.ts")
		expect(summary).toContain(`${red("×")} describe > first`)
		expect(summary).toContain(`${dim("→")} AssertionError: boom one`)
		expect(summary).toContain(`${red("×")} describe > second`)
		expect(summary).toContain(`${dim("→")} AssertionError: boom two`)
		expect(summary).toContain("b.test.ts")
		expect(summary).toContain(`${red("×")} other > third`)
		expect(summary).toContain(`${dim("→")} Error: boom three`)
		// Hidden tests
		expect(summary).toContain("+2 more failed tests. View full output for details.")
		// Hidden test names not shown
		expect(summary).not.toContain("fourth")
		expect(summary).not.toContain("fifth")
	})

	it("falls back to default formatting when vitest output has no FAIL > test name lines", async () => {
		const raw = "Some unstructured vitest output without a Failed Tests block"
		const errors = [{ tool: "vitest", message: raw, raw }]
		vi.mocked(select).mockResolvedValueOnce("retry")

		await showCheckFailureMenu(errors, raw, async () => true)

		const summary = vi.mocked(note).mock.calls[0]?.[0] as string
		expect(summary).toContain("[vitest] Some unstructured vitest output")
		expect(summary).not.toContain("failed tests in")
	})

	it("handles empty errors array gracefully", async () => {
		vi.mocked(select).mockResolvedValueOnce("retry")

		await showCheckFailureMenu([], "some output", async () => true)

		const summary = vi.mocked(note).mock.calls[0]?.[0] as string
		expect(summary).toContain("No check error details")
	})

	it("should return 'retried' when retry is selected", async () => {
		vi.mocked(select).mockResolvedValueOnce("retry")

		const result = await showCheckFailureMenu(mockErrors, mockRawStderr, async () => true)

		expect(result).toBe("retried")
	})

	it("should return 'retried' even without onRetry callback", async () => {
		vi.mocked(select).mockResolvedValueOnce("retry")

		const result = await showCheckFailureMenu(mockErrors, mockRawStderr)

		expect(result).toBe("retried")
	})

	it("should loop back to menu after copy then retry", async () => {
		vi.mocked(copyToClipboard).mockResolvedValue(true)
		vi.mocked(select).mockResolvedValueOnce("copy").mockResolvedValueOnce("retry")

		const result = await showCheckFailureMenu(mockErrors, mockRawStderr, async () => true)

		expect(copyToClipboard).toHaveBeenCalledWith(mockRawStderr)
		expect(select).toHaveBeenCalledTimes(2)
		expect(result).toBe("retried")
	})

	it("should loop back to menu after view then retry", async () => {
		vi.mocked(select).mockResolvedValueOnce("view").mockResolvedValueOnce("retry")

		const result = await showCheckFailureMenu(mockErrors, mockRawStderr, async () => true)

		expect(select).toHaveBeenCalledTimes(2)
		expect(result).toBe("retried")
	})

	it("should return 'skipped' when skip is selected", async () => {
		vi.mocked(select).mockResolvedValueOnce("skip")

		const result = await showCheckFailureMenu(mockErrors, mockRawStderr)

		expect(result).toBe("skipped")
	})

	it("should return 'cancelled' when cancel is selected", async () => {
		vi.mocked(select).mockResolvedValueOnce("cancel")

		const result = await showCheckFailureMenu(mockErrors, mockRawStderr)

		expect(result).toBe("cancelled")
	})

	it("should return 'cancelled' on isCancel", async () => {
		vi.mocked(isCancel).mockReturnValue(true)
		vi.mocked(select).mockResolvedValue("cancel")

		const result = await showCheckFailureMenu(mockErrors, mockRawStderr)

		expect(result).toBe("cancelled")
	})
})
