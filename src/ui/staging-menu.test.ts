import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChangedFile } from "../services/git.js"

vi.mock("./toggle-select.js", () => ({
	selectWithToggles: vi.fn(),
	isToggleSelectCancel: vi.fn((v: unknown) => typeof v === "symbol"),
}))

vi.mock("./file-multiselect.js", () => ({
	fileMultiSelect: vi.fn(),
}))

vi.mock("../services/auto-accept.js", () => ({
	getAutoAccept: vi.fn(),
	setAutoAccept: vi.fn(),
}))

vi.mock("../services/run-checks.js", () => ({
	getRunChecks: vi.fn(),
	setRunChecks: vi.fn(),
}))

vi.mock("@clack/prompts", () => ({
	note: vi.fn(),
	isCancel: vi.fn((v: unknown) => typeof v === "symbol"),
}))

vi.mock("kolorist", () => ({
	bold: (s: string) => s,
	cyan: (s: string) => s,
	dim: (s: string) => s,
	green: (s: string) => s,
	red: (s: string) => s,
	yellow: (s: string) => s,
}))

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}))

import { getAutoAccept, setAutoAccept } from "../services/auto-accept.js"
import { getRunChecks, setRunChecks } from "../services/run-checks.js"
import { fileMultiSelect } from "./file-multiselect.js"
import { showStagingMenu } from "./staging-menu.js"
import { selectWithToggles } from "./toggle-select.js"

const files: ChangedFile[] = [
	{ path: "src/a.ts", status: "M", staged: false },
	{ path: "src/b.ts", status: "M", staged: false },
]

describe("showStagingMenu toggle integration", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(getAutoAccept).mockResolvedValue(false)
		vi.mocked(getRunChecks).mockResolvedValue(true)
	})

	it("reads the initial auto-accept and run-checks state from config before showing the menu", async () => {
		vi.mocked(selectWithToggles).mockResolvedValue({
			value: "cancel",
			toggles: { autoAccept: false, runChecks: true },
		})

		await showStagingMenu(files, true)

		expect(getAutoAccept).toHaveBeenCalledOnce()
		expect(getRunChecks).toHaveBeenCalledOnce()
	})

	it("passes the initial states to selectWithToggles as toggle definitions", async () => {
		vi.mocked(getAutoAccept).mockResolvedValue(true)
		vi.mocked(getRunChecks).mockResolvedValue(false)
		vi.mocked(selectWithToggles).mockResolvedValue({
			value: "cancel",
			toggles: { autoAccept: true, runChecks: false },
		})

		await showStagingMenu(files, true)

		expect(selectWithToggles).toHaveBeenCalledOnce()
		const callOpts = vi.mocked(selectWithToggles).mock.calls[0]?.[0]
		const autoAcceptToggle = callOpts?.toggles.find((t) => t.key === "autoAccept")
		const runChecksToggle = callOpts?.toggles.find((t) => t.key === "runChecks")
		expect(autoAcceptToggle?.initial).toBe(true)
		expect(runChecksToggle?.initial).toBe(false)
	})

	it("registers both toggles with the correct hotkeys", async () => {
		vi.mocked(selectWithToggles).mockResolvedValue({
			value: "cancel",
			toggles: { autoAccept: false, runChecks: true },
		})

		await showStagingMenu(files, true)

		const callOpts = vi.mocked(selectWithToggles).mock.calls[0]?.[0]
		const hotkeys = callOpts?.toggles.map((t) => t.hotkey)
		expect(hotkeys).toContain("a")
		expect(hotkeys).toContain("c")
	})

	it("wires autoAccept onToggle to setAutoAccept", async () => {
		vi.mocked(selectWithToggles).mockResolvedValue({
			value: "cancel",
			toggles: { autoAccept: false, runChecks: true },
		})

		await showStagingMenu(files, true)

		const callOpts = vi.mocked(selectWithToggles).mock.calls[0]?.[0]
		const autoAcceptToggle = callOpts?.toggles.find((t) => t.key === "autoAccept")
		await autoAcceptToggle?.onToggle?.(true)
		expect(setAutoAccept).toHaveBeenCalledWith(true)
		await autoAcceptToggle?.onToggle?.(false)
		expect(setAutoAccept).toHaveBeenCalledWith(false)
	})

	it("wires runChecks onToggle to setRunChecks", async () => {
		vi.mocked(selectWithToggles).mockResolvedValue({
			value: "cancel",
			toggles: { autoAccept: false, runChecks: true },
		})

		await showStagingMenu(files, true)

		const callOpts = vi.mocked(selectWithToggles).mock.calls[0]?.[0]
		const runChecksToggle = callOpts?.toggles.find((t) => t.key === "runChecks")
		await runChecksToggle?.onToggle?.(true)
		expect(setRunChecks).toHaveBeenCalledWith(true)
		await runChecksToggle?.onToggle?.(false)
		expect(setRunChecks).toHaveBeenCalledWith(false)
	})

	it("omits the runChecks toggle when hasChecks is false", async () => {
		vi.mocked(selectWithToggles).mockResolvedValue({
			value: "cancel",
			toggles: { autoAccept: false },
		})

		await showStagingMenu(files, false)

		const callOpts = vi.mocked(selectWithToggles).mock.calls[0]?.[0]
		const keys = callOpts?.toggles.map((t) => t.key)
		expect(keys).toContain("autoAccept")
		expect(keys).not.toContain("runChecks")
		// Without .cmintrc, getRunChecks should not even be consulted.
		expect(getRunChecks).not.toHaveBeenCalled()
	})

	it("returns 'autogroup' when user selects auto-group", async () => {
		vi.mocked(selectWithToggles).mockResolvedValue({
			value: "autogroup",
			toggles: { autoAccept: false, runChecks: true },
		})

		const result = await showStagingMenu(files, true)

		expect(result).toBe("autogroup")
	})

	it("returns 'checks' when user selects checks", async () => {
		vi.mocked(selectWithToggles).mockResolvedValue({
			value: "checks",
			toggles: { autoAccept: false, runChecks: true },
		})

		const result = await showStagingMenu(files, true)

		expect(result).toBe("checks")
	})

	it("returns null when user cancels", async () => {
		vi.mocked(selectWithToggles).mockResolvedValue({
			value: "cancel",
			toggles: { autoAccept: false, runChecks: true },
		})

		const result = await showStagingMenu(files, true)

		expect(result).toBeNull()
	})

	it("opens fileMultiSelect when user picks 'Select files...' and returns the selection", async () => {
		vi.mocked(selectWithToggles).mockResolvedValue({
			value: "select",
			toggles: { autoAccept: false, runChecks: true },
		})
		vi.mocked(fileMultiSelect).mockResolvedValue(["src/a.ts", "src/b.ts"])

		const result = await showStagingMenu(files, true)

		expect(result).toEqual({ files: ["src/a.ts", "src/b.ts"], all: false })
	})

	it("returns null when user cancels fileMultiSelect", async () => {
		vi.mocked(selectWithToggles).mockResolvedValue({
			value: "select",
			toggles: { autoAccept: false, runChecks: true },
		})
		vi.mocked(fileMultiSelect).mockResolvedValue(Symbol.for("clack:cancel"))

		const result = await showStagingMenu(files, true)

		expect(result).toBeNull()
	})

	describe("Select files initial values", () => {
		beforeEach(() => {
			vi.clearAllMocks()
			vi.mocked(getAutoAccept).mockResolvedValue(false)
			vi.mocked(getRunChecks).mockResolvedValue(true)
		})

		it("passes staged file paths as initialValues when some files are staged", async () => {
			const mixedFiles: ChangedFile[] = [
				{ path: "src/staged.ts", status: "M", staged: true },
				{ path: "src/unstaged.ts", status: "M", staged: false },
			]
			vi.mocked(selectWithToggles).mockResolvedValue({
				value: "select",
				toggles: { autoAccept: false, runChecks: true },
			})
			vi.mocked(fileMultiSelect).mockResolvedValue(["src/staged.ts", "src/unstaged.ts"])

			await showStagingMenu(mixedFiles, true)

			expect(vi.mocked(fileMultiSelect)).toHaveBeenCalledWith(
				"Select files to stage:",
				expect.any(Array),
				expect.objectContaining({ initialValues: ["src/staged.ts"] }),
			)
		})

		it("passes empty initialValues when no files are staged", async () => {
			const unstagedFiles: ChangedFile[] = [
				{ path: "src/a.ts", status: "M", staged: false },
				{ path: "src/b.ts", status: "M", staged: false },
			]
			vi.mocked(selectWithToggles).mockResolvedValue({
				value: "select",
				toggles: { autoAccept: false, runChecks: true },
			})
			vi.mocked(fileMultiSelect).mockResolvedValue(["src/a.ts", "src/b.ts"])

			await showStagingMenu(unstagedFiles, true)

			expect(vi.mocked(fileMultiSelect)).toHaveBeenCalledWith(
				"Select files to stage:",
				expect.any(Array),
				expect.objectContaining({ initialValues: [] }),
			)
		})

		it("passes all file paths as initialValues when all files are staged", async () => {
			const allStaged: ChangedFile[] = [
				{ path: "src/a.ts", status: "M", staged: true },
				{ path: "src/b.ts", status: "M", staged: true },
			]
			vi.mocked(selectWithToggles).mockResolvedValue({
				value: "select",
				toggles: { autoAccept: false, runChecks: true },
			})
			vi.mocked(fileMultiSelect).mockResolvedValue(["src/a.ts", "src/b.ts"])

			await showStagingMenu(allStaged, true)

			expect(vi.mocked(fileMultiSelect)).toHaveBeenCalledWith(
				"Select files to stage:",
				expect.any(Array),
				expect.objectContaining({ initialValues: ["src/a.ts", "src/b.ts"] }),
			)
		})
	})
})
