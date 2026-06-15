import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { log } from "@clack/prompts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	checkForUpdates,
	runUpdateCheck,
	setCachePath,
	setFetchImpl,
	shouldSkip,
} from "./update-check.js"

vi.mock("@clack/prompts", () => ({
	log: {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		success: vi.fn(),
		message: vi.fn(),
	},
}))

const warnSpy = vi.mocked(log.warn)

const ENV_KEYS = ["NO_UPDATE_NOTIFIER", "CI", "NODE_ENV"] as const
const savedEnv: Record<string, string | undefined> = {}

let tempDir: string
let isTTYDescriptor: PropertyDescriptor | undefined
let listeners: Array<[string, (...args: unknown[]) => void]> = []

function setStderrIsTTY(value: boolean | undefined): void {
	Object.defineProperty(process.stderr, "isTTY", { value, configurable: true })
}

function trackListener(target: NodeJS.EventEmitter, event: string): void {
	const original = target.listeners(event) as Array<(...args: unknown[]) => void>
	for (const fn of original) {
		target.removeListener(event, fn)
		listeners.push([event, fn])
	}
}

beforeEach(() => {
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key]
		delete process.env[key]
	}
	isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY")
	setStderrIsTTY(true)
	tempDir = mkdtempSync(join(tmpdir(), "cmint-update-"))
	setCachePath(join(tempDir, "update-check.json"))
	warnSpy.mockClear()
	listeners = []
	trackListener(process, "beforeExit")
})

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) {
			delete process.env[key]
		} else {
			process.env[key] = savedEnv[key]
		}
	}
	if (isTTYDescriptor) {
		Object.defineProperty(process.stderr, "isTTY", isTTYDescriptor)
	} else {
		Object.defineProperty(process.stderr, "isTTY", { value: undefined, configurable: true })
	}
	rmSync(tempDir, { recursive: true, force: true })
	for (const [event, fn] of listeners) {
		process.on(event, fn)
	}
})

function writeCache(latest: string, checkedAt: number): void {
	mkdirSync(tempDir, { recursive: true })
	writeFileSync(join(tempDir, "update-check.json"), JSON.stringify({ latest, checkedAt }), "utf8")
}

function cacheExists(): boolean {
	return existsSync(join(tempDir, "update-check.json"))
}

function makeFetchOk(latest: string | unknown): typeof fetch {
	return (async () => ({
		ok: true,
		status: 200,
		json: async () => ({ latest }),
	})) as unknown as typeof fetch
}

function makeFetchNotOk(status = 404): typeof fetch {
	return (async () => ({
		ok: false,
		status,
		json: async () => ({}),
	})) as unknown as typeof fetch
}

describe("skip conditions", () => {
	it("skips when NO_UPDATE_NOTIFIER is set", () => {
		process.env.NO_UPDATE_NOTIFIER = "1"
		expect(shouldSkip("1.0.0")).toBe(true)
	})

	it("skips when NO_UPDATE_NOTIFIER=0", () => {
		process.env.NO_UPDATE_NOTIFIER = "0"
		expect(shouldSkip("1.0.0")).toBe(true)
	})

	it("skips when CI is set", () => {
		process.env.CI = "1"
		expect(shouldSkip("1.0.0")).toBe(true)
	})

	it("skips when NODE_ENV=test", () => {
		process.env.NODE_ENV = "test"
		expect(shouldSkip("1.0.0")).toBe(true)
	})

	it("skips when currentVersion is undefined", () => {
		expect(shouldSkip(undefined as unknown as string)).toBe(true)
	})

	it("skips when currentVersion is empty string", () => {
		expect(shouldSkip("")).toBe(true)
	})

	it("skips when currentVersion is not valid semver", () => {
		expect(shouldSkip("not-a-version")).toBe(true)
	})

	it("skips when process.stderr.isTTY is false", () => {
		setStderrIsTTY(false)
		expect(shouldSkip("1.0.0")).toBe(true)
	})
})

describe("cache behavior", () => {
	it("loads fresh cache and skips network when within TTL", async () => {
		writeCache("1.0.0", Date.now())
		const fetchSpy = vi.fn()
		setFetchImpl(fetchSpy as unknown as typeof fetch)
		await runUpdateCheck("0.6.6")
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(warnSpy).toHaveBeenCalled()
	})

	it("refetches when cache is stale (>24h old)", async () => {
		writeCache("0.6.6", Date.now() - 25 * 60 * 60 * 1000)
		setFetchImpl(makeFetchOk("1.0.0"))
		await runUpdateCheck("0.6.6")
		expect(warnSpy).toHaveBeenCalled()
	})

	it("refetches when cache file is missing", async () => {
		setFetchImpl(makeFetchOk("1.0.0"))
		await runUpdateCheck("0.6.6")
		expect(warnSpy).toHaveBeenCalled()
	})

	it("recovers from malformed cache JSON (writes invalid file, then fetches)", async () => {
		mkdirSync(tempDir, { recursive: true })
		writeFileSync(join(tempDir, "update-check.json"), "garbage{{{", "utf8")
		setFetchImpl(makeFetchOk("1.0.0"))
		await runUpdateCheck("0.6.6")
		expect(warnSpy).toHaveBeenCalled()
	})

	it("ignores cache entry missing the 'latest' field", async () => {
		mkdirSync(tempDir, { recursive: true })
		writeFileSync(
			join(tempDir, "update-check.json"),
			JSON.stringify({ checkedAt: Date.now() }),
			"utf8",
		)
		setFetchImpl(makeFetchOk("1.0.0"))
		await runUpdateCheck("0.6.6")
		expect(warnSpy).toHaveBeenCalled()
	})

	it("saveCache handles EACCES silently (mock fs.writeFile to throw)", async () => {
		setFetchImpl(makeFetchOk("1.0.0"))
		chmodSync(tempDir, 0o444)
		try {
			await expect(runUpdateCheck("0.6.6")).resolves.toBeUndefined()
		} finally {
			chmodSync(tempDir, 0o755)
		}
	})
})

describe("registry fetch", () => {
	it("returns null on network error (fetch throws)", async () => {
		setFetchImpl((async () => {
			throw new Error("ENETUNREACH")
		}) as unknown as typeof fetch)
		await runUpdateCheck("0.6.6")
		expect(warnSpy).not.toHaveBeenCalled()
		expect(cacheExists()).toBe(false)
	})

	it("returns null on HTTP 404 (response.ok=false)", async () => {
		setFetchImpl(makeFetchNotOk(404))
		await runUpdateCheck("0.6.6")
		expect(warnSpy).not.toHaveBeenCalled()
		expect(cacheExists()).toBe(false)
	})

	it("returns null on HTTP 500 (response.ok=false)", async () => {
		setFetchImpl(makeFetchNotOk(500))
		await runUpdateCheck("0.6.6")
		expect(warnSpy).not.toHaveBeenCalled()
		expect(cacheExists()).toBe(false)
	})

	it("returns null on AbortController timeout (5s)", async () => {
		vi.useFakeTimers()
		try {
			setFetchImpl(((_url: string | URL | Request, options?: RequestInit) => {
				return new Promise((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () => {
						const err = new Error("aborted") as Error & { name: string }
						err.name = "AbortError"
						reject(err)
					})
				})
			}) as unknown as typeof fetch)
			const promise = runUpdateCheck("0.6.6")
			await vi.advanceTimersByTimeAsync(5000)
			await promise
			expect(warnSpy).not.toHaveBeenCalled()
			expect(cacheExists()).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})

	it("returns null on malformed JSON response", async () => {
		setFetchImpl((async () => ({
			ok: true,
			status: 200,
			json: async () => {
				throw new SyntaxError("Unexpected token")
			},
		})) as unknown as typeof fetch)
		await runUpdateCheck("0.6.6")
		expect(warnSpy).not.toHaveBeenCalled()
		expect(cacheExists()).toBe(false)
	})

	it("returns null when response is missing 'latest' field", async () => {
		setFetchImpl((async () => ({
			ok: true,
			status: 200,
			json: async () => ({ foo: "bar" }),
		})) as unknown as typeof fetch)
		await runUpdateCheck("0.6.6")
		expect(warnSpy).not.toHaveBeenCalled()
		expect(cacheExists()).toBe(false)
	})

	it("returns 'latest' value when response is valid", async () => {
		setFetchImpl(makeFetchOk("1.0.0"))
		await runUpdateCheck("0.6.6")
		expect(warnSpy).toHaveBeenCalled()
		expect(cacheExists()).toBe(true)
	})
})

describe("version comparison", () => {
	it("does not nag when current === latest (0.6.6 vs 0.6.6)", async () => {
		writeCache("0.6.6", Date.now())
		setFetchImpl(vi.fn() as unknown as typeof fetch)
		await runUpdateCheck("0.6.6")
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it("does not nag when current > latest (0.7.0 vs 0.6.6)", async () => {
		writeCache("0.6.6", Date.now())
		setFetchImpl(vi.fn() as unknown as typeof fetch)
		await runUpdateCheck("0.7.0")
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it("does not nag when current is prerelease ahead (0.7.0-beta.1 vs 0.6.6)", async () => {
		writeCache("0.6.6", Date.now())
		setFetchImpl(vi.fn() as unknown as typeof fetch)
		await runUpdateCheck("0.7.0-beta.1")
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it("nags when current < latest (0.6.6 vs 1.0.0)", async () => {
		writeCache("1.0.0", Date.now())
		setFetchImpl(vi.fn() as unknown as typeof fetch)
		await runUpdateCheck("0.6.6")
		expect(warnSpy).toHaveBeenCalled()
	})
})

describe("nag display", () => {
	it("calls log.warn with formatted message containing both versions and install command", async () => {
		setFetchImpl(makeFetchOk("1.0.0"))
		await runUpdateCheck("0.6.6")
		expect(warnSpy).toHaveBeenCalledTimes(1)
		const message = warnSpy.mock.calls[0][0] as string
		expect(message).toMatch(/0\.6\.6/)
		expect(message).toMatch(/1\.0\.0/)
		expect(message).toMatch(/npm update -g @kyubiware\/commit-mint/)
	})

	it("does not call log.warn when nag is suppressed", async () => {
		setStderrIsTTY(false)
		setFetchImpl(makeFetchOk("1.0.0"))
		await runUpdateCheck("0.6.6")
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it("checkForUpdates registers a beforeExit listener", () => {
		const before = process.listenerCount("beforeExit")
		checkForUpdates("1.0.0")
		const after = process.listenerCount("beforeExit")
		expect(after).toBe(before + 1)
	})
})
