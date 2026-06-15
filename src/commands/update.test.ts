import { beforeEach, describe, expect, it, vi } from "vitest"
import { updateCommand } from "./update.js"

// --- Mock @clack/prompts ---
const { mockIntro, mockOutro, mockLog, mockConfirm, mockIsCancel } = vi.hoisted(() => ({
	mockIntro: vi.fn(),
	mockOutro: vi.fn(),
	mockLog: {
		info: vi.fn(),
		message: vi.fn(),
		step: vi.fn(),
		warn: vi.fn(),
		success: vi.fn(),
		error: vi.fn(),
	},
	mockConfirm: vi.fn(),
	mockIsCancel: vi.fn(() => false),
}))

vi.mock("@clack/prompts", () => ({
	intro: mockIntro,
	outro: mockOutro,
	log: mockLog,
	confirm: mockConfirm,
	isCancel: mockIsCancel,
}))

// --- Mock ../services/updater.js ---
const {
	mockDetectPackageManager,
	mockFetchLatestVersion,
	mockIsUpdateAvailable,
	mockBuildUpdateCommand,
	mockRunUpdate,
} = vi.hoisted(() => ({
	mockDetectPackageManager: vi.fn(() => "npm"),
	mockFetchLatestVersion: vi.fn(),
	mockIsUpdateAvailable: vi.fn(),
	mockBuildUpdateCommand: vi.fn((_pm: string) => `npm install -g @kyubiware/commit-mint@latest`),
	mockRunUpdate: vi.fn(),
}))

vi.mock("../services/updater.js", () => ({
	detectPackageManager: mockDetectPackageManager,
	fetchLatestVersion: mockFetchLatestVersion,
	isUpdateAvailable: mockIsUpdateAvailable,
	buildUpdateCommand: mockBuildUpdateCommand,
	runUpdate: mockRunUpdate,
}))

function spyOnProcessExit() {
	return vi.spyOn(process, "exit").mockImplementation(((code: number) => {
		throw new Error(`exit:${code}`)
	}) as never)
}

describe("updateCommand", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Restore default `isCancel` behavior (clearAllMocks preserves implementations,
		// but be explicit in case a previous test mutated it).
		mockIsCancel.mockImplementation(() => false)
		mockDetectPackageManager.mockImplementation(() => "npm")
		mockBuildUpdateCommand.mockImplementation(
			(_pm: string) => `npm install -g @kyubiware/commit-mint@latest`,
		)
	})

	it("reports 'Already up-to-date' and exits cleanly when current is the latest", async () => {
		mockFetchLatestVersion.mockResolvedValueOnce("1.2.3")
		mockIsUpdateAvailable.mockReturnValueOnce(false)
		const exitSpy = spyOnProcessExit()

		await updateCommand("1.2.3")

		expect(mockIntro).toHaveBeenCalledWith("cmint update")
		expect(mockFetchLatestVersion).toHaveBeenCalled()
		expect(mockIsUpdateAvailable).toHaveBeenCalledWith("1.2.3", "1.2.3")
		expect(mockRunUpdate).not.toHaveBeenCalled()
		expect(mockConfirm).not.toHaveBeenCalled()
		expect(exitSpy).not.toHaveBeenCalled()
		expect(mockOutro).toHaveBeenCalledTimes(1)
		const outroArg = mockOutro.mock.calls[0]?.[0] as string
		expect(outroArg).toContain("Already up-to-date")
		expect(outroArg).toContain("1.2.3")
	})

	it("exits with code 1 when the registry is unreachable", async () => {
		mockFetchLatestVersion.mockResolvedValueOnce(null)
		const exitSpy = spyOnProcessExit()

		await expect(updateCommand("1.0.0")).rejects.toThrow("exit:1")

		expect(mockOutro).toHaveBeenCalledTimes(1)
		const outroArg = mockOutro.mock.calls[0]?.[0] as string
		expect(outroArg.toLowerCase()).toContain("registry")
		expect(exitSpy).toHaveBeenCalledWith(1)
		expect(mockIsUpdateAvailable).not.toHaveBeenCalled()
		expect(mockRunUpdate).not.toHaveBeenCalled()
	})

	it("runs the update when the user confirms and reports success", async () => {
		mockFetchLatestVersion.mockResolvedValueOnce("2.0.0")
		mockIsUpdateAvailable.mockReturnValueOnce(true)
		mockConfirm.mockResolvedValueOnce(true)
		mockIsCancel.mockReturnValueOnce(false)
		mockRunUpdate.mockResolvedValueOnce(true)
		const exitSpy = spyOnProcessExit()

		await updateCommand("1.0.0")

		expect(mockBuildUpdateCommand).toHaveBeenCalledWith("npm")
		expect(mockConfirm).toHaveBeenCalledTimes(1)
		expect(mockRunUpdate).toHaveBeenCalledWith("npm")
		expect(mockOutro).toHaveBeenCalledTimes(1)
		const outroArg = mockOutro.mock.calls[0]?.[0] as string
		expect(outroArg).toContain("Updated to v2.0.0")
		expect(exitSpy).not.toHaveBeenCalled()
	})

	it("cancels without running the update when the user answers 'no'", async () => {
		mockFetchLatestVersion.mockResolvedValueOnce("2.0.0")
		mockIsUpdateAvailable.mockReturnValueOnce(true)
		mockConfirm.mockResolvedValueOnce(false)
		mockIsCancel.mockReturnValueOnce(false)
		const exitSpy = spyOnProcessExit()

		await updateCommand("1.0.0")

		expect(mockRunUpdate).not.toHaveBeenCalled()
		expect(mockOutro).toHaveBeenCalledTimes(1)
		const outroArg = mockOutro.mock.calls[0]?.[0] as string
		expect(outroArg).toBe("Update cancelled.")
		expect(exitSpy).not.toHaveBeenCalled()
	})

	it("cancels without running the update when the user hits ESC (isCancel)", async () => {
		mockFetchLatestVersion.mockResolvedValueOnce("2.0.0")
		mockIsUpdateAvailable.mockReturnValueOnce(true)
		const cancelSymbol = Symbol("cancel")
		mockConfirm.mockResolvedValueOnce(cancelSymbol)
		mockIsCancel.mockImplementation(((value: unknown) => value === cancelSymbol) as never)
		const exitSpy = spyOnProcessExit()

		await updateCommand("1.0.0")

		expect(mockRunUpdate).not.toHaveBeenCalled()
		expect(mockOutro).toHaveBeenCalledTimes(1)
		const outroArg = mockOutro.mock.calls[0]?.[0] as string
		expect(outroArg).toBe("Update cancelled.")
		expect(exitSpy).not.toHaveBeenCalled()
	})

	it("skips the confirmation prompt and runs the update when --yes is passed", async () => {
		mockFetchLatestVersion.mockResolvedValueOnce("2.0.0")
		mockIsUpdateAvailable.mockReturnValueOnce(true)
		mockRunUpdate.mockResolvedValueOnce(true)
		const exitSpy = spyOnProcessExit()

		await updateCommand("1.0.0", { yes: true })

		expect(mockConfirm).not.toHaveBeenCalled()
		expect(mockRunUpdate).toHaveBeenCalledWith("npm")
		expect(mockOutro).toHaveBeenCalledTimes(1)
		const outroArg = mockOutro.mock.calls[0]?.[0] as string
		expect(outroArg).toContain("Updated to v2.0.0")
		expect(exitSpy).not.toHaveBeenCalled()
	})

	it("exits with code 1 when the install command fails", async () => {
		mockFetchLatestVersion.mockResolvedValueOnce("2.0.0")
		mockIsUpdateAvailable.mockReturnValueOnce(true)
		mockConfirm.mockResolvedValueOnce(true)
		mockIsCancel.mockReturnValueOnce(false)
		mockRunUpdate.mockResolvedValueOnce(false)
		const exitSpy = spyOnProcessExit()

		await expect(updateCommand("1.0.0")).rejects.toThrow("exit:1")

		expect(mockRunUpdate).toHaveBeenCalledWith("npm")
		expect(mockOutro).toHaveBeenCalledTimes(1)
		const outroArg = mockOutro.mock.calls[0]?.[0] as string
		expect(outroArg).toContain("Update failed")
		expect(exitSpy).toHaveBeenCalledWith(1)
	})
})
