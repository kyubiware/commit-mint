import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { copyToClipboard } from "./clipboard.js"

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}))

vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}))

import { spawn } from "node:child_process"

function mockSuccessfulChild() {
	return {
		on: vi.fn(),
		stdin: {
			write: vi.fn((_content: string, cb: (err?: null) => void) => cb(null)),
			end: vi.fn((cb: () => void) => cb()),
		},
		stderr: { on: vi.fn() },
		unref: vi.fn(),
	}
}

function mockFailedChild() {
	return {
		on: vi.fn(),
		stdin: {
			write: vi.fn((_content: string, cb: (err: Error) => void) => cb(new Error("not found"))),
			end: vi.fn(),
		},
		stderr: { on: vi.fn() },
		unref: vi.fn(),
	}
}

describe("copyToClipboard", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("should copy content using wl-copy --foreground when available", async () => {
		vi.mocked(spawn).mockReturnValue(mockSuccessfulChild() as never)

		const promise = copyToClipboard("test content")
		await vi.advanceTimersByTimeAsync(200)
		const result = await promise

		expect(result).toBe(true)
		expect(spawn).toHaveBeenCalledWith("wl-copy", ["--foreground"], {
			stdio: ["pipe", "ignore", "pipe"],
		})
	})

	it("should fall back to wl-copy without --foreground on wl-clipboard 1.x", async () => {
		// First call (wl-copy --foreground) fails: exit 1 during grace period
		// (wl-clipboard 1.x rejects the unknown --foreground flag).
		const foregroundChild = mockSuccessfulChild()
		foregroundChild.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			if (event === "exit") handler(1)
		})
		// Second call (plain wl-copy) succeeds.
		const plainChild = mockSuccessfulChild()

		vi.mocked(spawn)
			.mockReturnValueOnce(foregroundChild as never)
			.mockReturnValueOnce(plainChild as never)

		const promise = copyToClipboard("test content")
		// Advance past grace period for the --foreground attempt (fails with exit 1)
		await vi.advanceTimersByTimeAsync(200)
		// Advance past grace period for the plain wl-copy fallback (succeeds)
		await vi.advanceTimersByTimeAsync(200)
		const result = await promise

		expect(result).toBe(true)
		expect(spawn).toHaveBeenNthCalledWith(1, "wl-copy", ["--foreground"], {
			stdio: ["pipe", "ignore", "pipe"],
		})
		expect(spawn).toHaveBeenNthCalledWith(2, "wl-copy", [], {
			stdio: ["pipe", "ignore", "pipe"],
		})
	})

	it("should fallback to xclip when wl-copy is not available", async () => {
		vi.mocked(spawn)
			.mockReturnValueOnce(mockFailedChild() as never) // wl-copy --foreground fails
			.mockReturnValueOnce(mockFailedChild() as never) // wl-copy (no flag) fails
			.mockReturnValueOnce(mockSuccessfulChild() as never) // xclip succeeds

		const promise = copyToClipboard("test content")
		await vi.advanceTimersByTimeAsync(200)
		const result = await promise

		expect(result).toBe(true)
		expect(spawn).toHaveBeenCalledWith("xclip", ["-selection", "clipboard"], {
			stdio: ["pipe", "ignore", "pipe"],
		})
	})

	it("should try all tools and return false when none are available", async () => {
		vi.mocked(spawn).mockReturnValue(mockFailedChild() as never)

		const result = await copyToClipboard("test content")

		expect(result).toBe(false)
		expect(spawn).toHaveBeenCalledTimes(5) // wl-copy x2 + xclip + xsel + pbcopy
	})

	it("should detect quick exit with non-zero code during grace period", async () => {
		const child = mockSuccessfulChild()
		// Simulate exit with code 1 — stored as exitCode, detected after grace period
		child.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			if (event === "exit") {
				handler(1)
			}
		})

		const fallback = mockSuccessfulChild()

		vi.mocked(spawn)
			.mockReturnValueOnce(child as never)
			.mockReturnValueOnce(fallback as never)

		const promise = copyToClipboard("test content")
		// Advance past grace period for wl-copy (fails with exit 1)
		await vi.advanceTimersByTimeAsync(200)
		// Advance past grace period for xclip fallback (succeeds)
		await vi.advanceTimersByTimeAsync(200)
		const result = await promise

		expect(result).toBe(true)
		expect(spawn).toHaveBeenCalledTimes(2)
	})

	it("should report success when child exits with 0 during grace period", async () => {
		const child = mockSuccessfulChild()
		child.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			if (event === "exit") {
				handler(0)
			}
		})

		vi.mocked(spawn).mockReturnValue(child as never)

		const promise = copyToClipboard("test content")
		await vi.advanceTimersByTimeAsync(200)
		const result = await promise

		expect(result).toBe(true)
	})
})
