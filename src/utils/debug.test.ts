import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { debug, isDebug, setDebug, setLogFilePath, writeSessionHeader } from "./debug.js"

describe("debug utility", () => {
	const originalStderr = console.error
	let tempDir: string

	beforeEach(() => {
		console.error = vi.fn()
		tempDir = mkdtempSync(join(tmpdir(), "cmint-test-"))
		setLogFilePath(join(tempDir, "debug.log"))
		writeSessionHeader()
	})

	afterEach(() => {
		setDebug(false)
		console.error = originalStderr
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("does not output when debug is disabled", () => {
		setDebug(false)
		debug("test message")
		expect(console.error).not.toHaveBeenCalled()
	})

	it("outputs to stderr when debug is enabled", () => {
		setDebug(true)
		debug("test message")
		expect(console.error).toHaveBeenCalled()
		const call = vi.mocked(console.error).mock.calls[0]
		expect(call[0]).toMatch(/\[debug .+\]/)
		expect(call[1]).toBe("test message")
	})

	it("outputs multiple arguments", () => {
		setDebug(true)
		debug("key:", "value", 42, { foo: "bar" })
		expect(console.error).toHaveBeenCalled()
		const call = vi.mocked(console.error).mock.calls[0]
		expect(call[1]).toBe("key:")
		expect(call[2]).toBe("value")
		expect(call[3]).toBe(42)
		expect(call[4]).toEqual({ foo: "bar" })
	})

	it("includes timestamp in HH:mm:ss.SSS format", () => {
		setDebug(true)
		debug("test")
		const call = vi.mocked(console.error).mock.calls[0]
		expect(call[0]).toMatch(/\[debug \d{2}:\d{2}:\d{2}\.\d{3}\]/)
	})

	it("isDebug returns false by default", () => {
		expect(isDebug()).toBe(false)
	})

	it("isDebug returns true after setDebug(true)", () => {
		setDebug(true)
		expect(isDebug()).toBe(true)
	})

	it("isDebug returns false after setDebug(true) then setDebug(false)", () => {
		setDebug(true)
		setDebug(false)
		expect(isDebug()).toBe(false)
	})
})
