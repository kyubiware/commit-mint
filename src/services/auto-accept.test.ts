import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./config.js", () => ({
	readConfig: vi.fn(),
	writeConfig: vi.fn(),
}))

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}))

import { getAutoAccept, parseAutoAcceptValue, setAutoAccept } from "./auto-accept.js"
import { readConfig, writeConfig } from "./config.js"

describe("parseAutoAcceptValue", () => {
	it("returns true for 'true' (case-insensitive)", () => {
		expect(parseAutoAcceptValue("true")).toBe(true)
		expect(parseAutoAcceptValue("TRUE")).toBe(true)
		expect(parseAutoAcceptValue("True")).toBe(true)
	})

	it("returns true for '1' and 'yes'", () => {
		expect(parseAutoAcceptValue("1")).toBe(true)
		expect(parseAutoAcceptValue("yes")).toBe(true)
		expect(parseAutoAcceptValue("YES")).toBe(true)
	})

	it("returns false for 'false', '0', 'no'", () => {
		expect(parseAutoAcceptValue("false")).toBe(false)
		expect(parseAutoAcceptValue("0")).toBe(false)
		expect(parseAutoAcceptValue("no")).toBe(false)
	})

	it("returns false for undefined / empty / unknown values", () => {
		expect(parseAutoAcceptValue(undefined)).toBe(false)
		expect(parseAutoAcceptValue("")).toBe(false)
		expect(parseAutoAcceptValue("garbage")).toBe(false)
	})

	it("handles boolean true (as ini.parse returns from 'auto-accept = true')", () => {
		expect(parseAutoAcceptValue(true)).toBe(true)
	})

	it("handles boolean false (as ini.parse returns from 'auto-accept = false')", () => {
		expect(parseAutoAcceptValue(false)).toBe(false)
	})
})

describe("getAutoAccept", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns true when config has 'auto-accept' = 'true'", async () => {
		vi.mocked(readConfig).mockResolvedValue({ "auto-accept": "true" })
		expect(await getAutoAccept()).toBe(true)
	})

	it("returns false when config has 'auto-accept' = 'false'", async () => {
		vi.mocked(readConfig).mockResolvedValue({ "auto-accept": "false" })
		expect(await getAutoAccept()).toBe(false)
	})

	it("returns false when 'auto-accept' key is absent", async () => {
		vi.mocked(readConfig).mockResolvedValue({})
		expect(await getAutoAccept()).toBe(false)
	})

	it("handles boolean true from ini.parse round-trip", async () => {
		vi.mocked(readConfig).mockResolvedValue({ "auto-accept": true } as never)
		expect(await getAutoAccept()).toBe(true)
	})

	it("handles boolean false from ini.parse round-trip", async () => {
		vi.mocked(readConfig).mockResolvedValue({ "auto-accept": false } as never)
		expect(await getAutoAccept()).toBe(false)
	})
})

describe("setAutoAccept", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("writes 'true' when called with true", async () => {
		await setAutoAccept(true)
		expect(writeConfig).toHaveBeenCalledWith({ "auto-accept": "true" })
	})

	it("writes 'false' when called with false", async () => {
		await setAutoAccept(false)
		expect(writeConfig).toHaveBeenCalledWith({ "auto-accept": "false" })
	})
})
