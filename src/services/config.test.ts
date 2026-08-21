import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
}))

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}))

import { readFile } from "node:fs/promises"
import { getProviderApiKey } from "./config.js"

const ALL_PROVIDER_ENV_KEYS = [
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"MISTRAL_API_KEY",
	"OMNIROUTE_API_KEY",
] as const

function missingConfigFile() {
	return Object.assign(new Error("ENOENT: config file does not exist"), { code: "ENOENT" })
}

describe("getProviderApiKey keyless providers", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		for (const key of ALL_PROVIDER_ENV_KEYS) {
			delete process.env[key]
		}
	})

	it("returns '' instead of throwing for omniroute when no key is set anywhere", async () => {
		vi.mocked(readFile).mockRejectedValue(missingConfigFile())
		await expect(getProviderApiKey("omniroute")).resolves.toBe("")
	})

	it("still throws for providers that require a key (groq)", async () => {
		vi.mocked(readFile).mockRejectedValue(missingConfigFile())
		await expect(getProviderApiKey("groq")).rejects.toThrow(/Groq API key/)
	})

	it("prefers OMNIROUTE_API_KEY env var over the empty default", async () => {
		process.env.OMNIROUTE_API_KEY = "env-token"
		vi.mocked(readFile).mockRejectedValue(missingConfigFile())
		await expect(getProviderApiKey("omniroute")).resolves.toBe("env-token")
	})

	it("falls back to the INI value for remote deployments (scoped token)", async () => {
		process.env.OMNIROUTE_API_KEY = ""
		vi.mocked(readFile).mockResolvedValue("OMNIROUTE_API_KEY=ini-token\n")
		await expect(getProviderApiKey("omniroute")).resolves.toBe("ini-token")
	})
})
