import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./config.js", () => ({
	readConfig: vi.fn(),
	writeConfig: vi.fn(),
}))

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}))

import { readConfig, writeConfig } from "./config.js"
import { getRunChecks, parseRunChecksValue, setRunChecks } from "./run-checks.js"

describe("parseRunChecksValue", () => {
	it("returns true for 'true' (case-insensitive)", () => {
		expect(parseRunChecksValue("true")).toBe(true)
		expect(parseRunChecksValue("TRUE")).toBe(true)
		expect(parseRunChecksValue("True")).toBe(true)
	})

	it("returns true for '1' and 'yes'", () => {
		expect(parseRunChecksValue("1")).toBe(true)
		expect(parseRunChecksValue("yes")).toBe(true)
		expect(parseRunChecksValue("YES")).toBe(true)
	})

	it("returns false for 'false', '0', 'no'", () => {
		expect(parseRunChecksValue("false")).toBe(false)
		expect(parseRunChecksValue("0")).toBe(false)
		expect(parseRunChecksValue("no")).toBe(false)
	})

	it("returns TRUE for undefined / empty / unknown values (checks run by default)", () => {
		// Polarity is positive — missing key means checks ON.
		expect(parseRunChecksValue(undefined)).toBe(true)
		expect(parseRunChecksValue("")).toBe(true)
		expect(parseRunChecksValue("garbage")).toBe(true)
	})

	it("handles boolean true (as ini.parse returns from 'run-checks = true')", () => {
		expect(parseRunChecksValue(true)).toBe(true)
	})

	it("handles boolean false (as ini.parse returns from 'run-checks = false')", () => {
		expect(parseRunChecksValue(false)).toBe(false)
	})
})

describe("getRunChecks", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns true when config has 'run-checks' = 'true'", async () => {
		vi.mocked(readConfig).mockResolvedValue({ "run-checks": "true" })
		expect(await getRunChecks()).toBe(true)
	})

	it("returns false when config has 'run-checks' = 'false'", async () => {
		vi.mocked(readConfig).mockResolvedValue({ "run-checks": "false" })
		expect(await getRunChecks()).toBe(false)
	})

	it("returns true when 'run-checks' key is absent (checks run by default)", async () => {
		vi.mocked(readConfig).mockResolvedValue({})
		expect(await getRunChecks()).toBe(true)
	})

	it("handles boolean true from ini.parse round-trip", async () => {
		vi.mocked(readConfig).mockResolvedValue({ "run-checks": true } as never)
		expect(await getRunChecks()).toBe(true)
	})

	it("handles boolean false from ini.parse round-trip", async () => {
		vi.mocked(readConfig).mockResolvedValue({ "run-checks": false } as never)
		expect(await getRunChecks()).toBe(false)
	})
})

describe("setRunChecks", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("writes 'true' when called with true", async () => {
		await setRunChecks(true)
		expect(writeConfig).toHaveBeenCalledWith({ "run-checks": "true" })
	})

	it("writes 'false' when called with false", async () => {
		await setRunChecks(false)
		expect(writeConfig).toHaveBeenCalledWith({ "run-checks": "false" })
	})
})
