import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChangedFile } from "../services/git.js"

vi.mock("./auto-accept-select.js", () => ({
	selectWithAutoAccept: vi.fn(),
	isAutoAcceptCancel: vi.fn((v: unknown) => typeof v === "symbol"),
}))

vi.mock("../services/auto-accept.js", () => ({
	getAutoAccept: vi.fn(),
	setAutoAccept: vi.fn(),
}))

vi.mock("@clack/prompts", () => ({
	note: vi.fn(),
	multiselect: vi.fn(),
	isCancel: vi.fn(() => false),
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
import { selectWithAutoAccept } from "./auto-accept-select.js"
import { showStagingMenu } from "./staging-menu.js"

const files: ChangedFile[] = [
	{ path: "src/a.ts", status: "M", staged: false },
	{ path: "src/b.ts", status: "M", staged: false },
]

describe("showStagingMenu auto-accept integration", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(getAutoAccept).mockResolvedValue(false)
	})

	it("reads the initial auto-accept state from config before showing the menu", async () => {
		vi.mocked(selectWithAutoAccept).mockResolvedValue({ value: "cancel", autoAccept: false })

		await showStagingMenu(files, false)

		expect(getAutoAccept).toHaveBeenCalledOnce()
	})

	it("passes the initial state to selectWithAutoAccept", async () => {
		vi.mocked(getAutoAccept).mockResolvedValue(true)
		vi.mocked(selectWithAutoAccept).mockResolvedValue({ value: "cancel", autoAccept: true })

		await showStagingMenu(files, false)

		expect(selectWithAutoAccept).toHaveBeenCalledOnce()
		const callOpts = vi.mocked(selectWithAutoAccept).mock.calls[0]?.[0]
		expect(callOpts?.initialAutoAccept).toBe(true)
	})

	it("wires onToggle to persist the new state via setAutoAccept", async () => {
		vi.mocked(selectWithAutoAccept).mockResolvedValue({ value: "cancel", autoAccept: false })

		await showStagingMenu(files, false)

		const callOpts = vi.mocked(selectWithAutoAccept).mock.calls[0]?.[0]
		await callOpts?.onToggle?.(true)
		expect(setAutoAccept).toHaveBeenCalledWith(true)

		await callOpts?.onToggle?.(false)
		expect(setAutoAccept).toHaveBeenCalledWith(false)
	})

	it("returns 'autogroup' when user selects auto-group", async () => {
		vi.mocked(selectWithAutoAccept).mockResolvedValue({ value: "autogroup", autoAccept: false })

		const result = await showStagingMenu(files, false)

		expect(result).toBe("autogroup")
	})

	it("returns 'checks' when user selects checks", async () => {
		vi.mocked(selectWithAutoAccept).mockResolvedValue({ value: "checks", autoAccept: false })

		const result = await showStagingMenu(files, true)

		expect(result).toBe("checks")
	})

	it("returns null when user cancels", async () => {
		vi.mocked(selectWithAutoAccept).mockResolvedValue({ value: "cancel", autoAccept: false })

		const result = await showStagingMenu(files, false)

		expect(result).toBeNull()
	})
})
