import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./commands/commit.js", () => ({
	commitCommand: vi.fn(),
}))

vi.mock("./utils/debug.js", () => ({
	setDebug: vi.fn(),
	writeSessionHeader: vi.fn(),
}))

import { handleAutoSubcommand } from "./cli.js"
import { commitCommand } from "./commands/commit.js"
import { setDebug, writeSessionHeader } from "./utils/debug.js"

describe("handleAutoSubcommand", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("calls writeSessionHeader and setDebug", async () => {
		vi.mocked(commitCommand).mockResolvedValue(undefined)

		await handleAutoSubcommand("1.0.0")

		expect(writeSessionHeader).toHaveBeenCalledTimes(1)
		expect(setDebug).toHaveBeenCalledWith(false)
	})

	it("delegates to commitCommand with auto: true", async () => {
		vi.mocked(commitCommand).mockResolvedValue(undefined)

		await handleAutoSubcommand("1.0.0")

		expect(commitCommand).toHaveBeenCalledWith({ auto: true, retry: false, agent: false }, "1.0.0")
	})
})
