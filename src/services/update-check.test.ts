import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { log } from "@clack/prompts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	checkForUpdatesUpfront,
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
const infoSpy = vi.mocked(log.info)

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
	infoSpy.mockClear()
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

function readCacheFile(): { latest: string; checkedAt: number } {
	const raw = readFileSync(join(tempDir, "update-check.json"), "utf8")
	return JSON.parse(raw) as { latest: string; checkedAt: number }
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
			// Returns fetch-update even when saveCache fails (EACCES) — the
			// nag is still shown; only persistence is skipped.
			await expect(runUpdateCheck("0.6.6")).resolves.toBe("fetch-update")
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

describe("stale-while-revalidate background refresh", () => {
	it("SWR: cache age in SWR band (e.g. 2h) triggers background refresh that overwrites cache file", async () => {
		const originalCheckedAt = Date.now() - 2 * 60 * 60 * 1000 // 2h old → SWR band
		writeCache("1.0.0", originalCheckedAt)
		setFetchImpl(makeFetchOk("1.1.0"))
		await runUpdateCheck("1.0.0")
		await vi.waitFor(() => {
			const parsed = readCacheFile()
			expect(parsed.latest).toBe("1.1.0")
			expect(parsed.checkedAt).toBeGreaterThan(originalCheckedAt)
		})
	})

	it("SWR: cache age < FRESH_MS (e.g. 10 minutes) does NOT trigger a background refresh", async () => {
		const originalCheckedAt = Date.now() - 10 * 60 * 1000 // 10 min old → FRESH band
		writeCache("1.0.0", originalCheckedAt)
		const fetchSpy = vi.fn()
		setFetchImpl(fetchSpy as unknown as typeof fetch)
		await runUpdateCheck("1.0.0")
		// Flush any pending microtasks so a stray background refresh cannot
		// leak into the next test before we assert.
		await new Promise((r) => setTimeout(r, 50))
		expect(fetchSpy).not.toHaveBeenCalled()
		// Cache file must remain exactly as written — no silent mutation.
		const parsed = readCacheFile()
		expect(parsed.latest).toBe("1.0.0")
		expect(parsed.checkedAt).toBe(originalCheckedAt)
	})

	it("SWR: runUpdateCheck returns well before a slow background fetch resolves (fire-and-forget)", async () => {
		writeCache("1.0.0", Date.now() - 2 * 60 * 60 * 1000) // SWR band
		const FETCH_DELAY_MS = 150
		setFetchImpl((async () => {
			await new Promise((r) => setTimeout(r, FETCH_DELAY_MS))
			return { ok: true, status: 200, json: async () => ({ latest: "1.1.0" }) }
		}) as unknown as typeof fetch)
		const start = Date.now()
		const status = await runUpdateCheck("1.0.0")
		const elapsed = Date.now() - start
		// If refresh is truly fire-and-forget, the function must return long
		// before the fetch delay elapses. Allow generous slack for CI jitter.
		expect(elapsed).toBeLessThan(FETCH_DELAY_MS)
		expect(status).toBe("cache-current")
		// Flush the pending background refresh so it doesn't leak.
		await new Promise((r) => setTimeout(r, FETCH_DELAY_MS + 50))
	})

	it("SWR: background fetch that throws (ENETUNREACH) leaves cache file unchanged and silent", async () => {
		const originalCheckedAt = Date.now() - 2 * 60 * 60 * 1000 // SWR band
		writeCache("1.0.0", originalCheckedAt)
		setFetchImpl((async () => {
			throw new Error("ENETUNREACH")
		}) as unknown as typeof fetch)
		warnSpy.mockClear()
		infoSpy.mockClear()
		await runUpdateCheck("1.0.0")
		// Wait long enough for the floating IIFE to settle — `fetchLatest`
		// catches the throw internally, so this just drains the microtask queue.
		await new Promise((r) => setTimeout(r, 50))
		const parsed = readCacheFile()
		expect(parsed.latest).toBe("1.0.0")
		expect(parsed.checkedAt).toBe(originalCheckedAt)
		// No user-facing output from the background refresh — only debug() log.
		expect(warnSpy).not.toHaveBeenCalled()
		expect(infoSpy).not.toHaveBeenCalled()
	})

	it("SWR: background fetch that returns HTTP 404 leaves cache file unchanged and silent", async () => {
		const originalCheckedAt = Date.now() - 2 * 60 * 60 * 1000 // SWR band
		writeCache("1.0.0", originalCheckedAt)
		setFetchImpl(makeFetchNotOk(404))
		warnSpy.mockClear()
		infoSpy.mockClear()
		await runUpdateCheck("1.0.0")
		await new Promise((r) => setTimeout(r, 50))
		const parsed = readCacheFile()
		expect(parsed.latest).toBe("1.0.0")
		expect(parsed.checkedAt).toBe(originalCheckedAt)
		expect(warnSpy).not.toHaveBeenCalled()
		expect(infoSpy).not.toHaveBeenCalled()
	})

	it("SWR: checkForUpdatesUpfront (non-TTY stdin) in SWR band triggers background refresh", async () => {
		// stderr TTY (passes shouldSkip) + stdin non-TTY (skips cancellable
		// spinner → exercises the silent-fetch path inside checkForUpdatesUpfront).
		Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true })
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })
		const originalCheckedAt = Date.now() - 2 * 60 * 60 * 1000 // SWR band
		writeCache("1.0.0", originalCheckedAt)
		setFetchImpl(makeFetchOk("1.1.0"))
		await checkForUpdatesUpfront("1.0.0")
		await vi.waitFor(() => {
			const parsed = readCacheFile()
			expect(parsed.latest).toBe("1.1.0")
			expect(parsed.checkedAt).toBeGreaterThan(originalCheckedAt)
		})
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
		expect(message).toMatch(/cmint update/)
	})

	it("does not call log.warn when nag is suppressed", async () => {
		setStderrIsTTY(false)
		setFetchImpl(makeFetchOk("1.0.0"))
		await runUpdateCheck("0.6.6")
		expect(warnSpy).not.toHaveBeenCalled()
	})
})

describe("checkForUpdatesUpfront", () => {
	function setIsTTY(stderr: boolean, stdin: boolean): void {
		Object.defineProperty(process.stderr, "isTTY", { value: stderr, configurable: true })
		Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true })
	}

	it("skips silently when shouldSkip returns true (non-TTY stderr)", async () => {
		setIsTTY(false, false)
		const fetchSpy = vi.fn()
		setFetchImpl(fetchSpy)
		await checkForUpdatesUpfront("0.6.6")
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it("cache fresh + update available → shows nag, no fetch, no spinner", async () => {
		setIsTTY(true, true)
		writeCache("1.0.0", Date.now())
		const fetchSpy = vi.fn()
		setFetchImpl(fetchSpy)
		await checkForUpdatesUpfront("0.6.6")
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(warnSpy).toHaveBeenCalledTimes(1)
	})

	it("cache fresh + up-to-date → silent (no nag, no fetch)", async () => {
		setIsTTY(true, true)
		writeCache("0.6.6", Date.now())
		const fetchSpy = vi.fn()
		setFetchImpl(fetchSpy)
		await checkForUpdatesUpfront("0.6.6")
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(warnSpy).not.toHaveBeenCalled()
	})

	it("cache stale + non-TTY stdin → falls back to silent check (no spinner)", async () => {
		setIsTTY(true, false) // stderr is TTY (passes shouldSkip) but stdin is not
		writeCache("0.6.6", Date.now() - 25 * 60 * 60 * 1000)
		setFetchImpl(makeFetchOk("1.0.0"))
		// spinner() from @clack/prompts is mocked at the top level; assert the
		// silent path by checking that the fetch still runs and the nag shows.
		await checkForUpdatesUpfront("0.6.6")
		expect(warnSpy).toHaveBeenCalledTimes(1)
	})

	it("cache missing + non-TTY stdin → falls back to silent check", async () => {
		setIsTTY(true, false)
		setFetchImpl(makeFetchOk("1.0.0"))
		await checkForUpdatesUpfront("0.6.6")
		expect(warnSpy).toHaveBeenCalledTimes(1)
		expect(cacheExists()).toBe(true)
	})

	it("non-TTY stdin + fetch succeeds + up-to-date → shows 'You are on the latest version'", async () => {
		setIsTTY(true, false)
		setFetchImpl(makeFetchOk("0.6.6"))
		await checkForUpdatesUpfront("0.6.6")
		expect(warnSpy).not.toHaveBeenCalled()
		expect(infoSpy).toHaveBeenCalledTimes(1)
		expect(String(infoSpy.mock.calls[0][0])).toMatch(/latest version/i)
	})

	it("cache fresh + up-to-date → does NOT show 'You are on the latest version' (silent on cache hit)", async () => {
		setIsTTY(true, false)
		writeCache("0.6.6", Date.now())
		setFetchImpl(makeFetchOk("0.6.6"))
		await checkForUpdatesUpfront("0.6.6")
		// Cache-hit-current path must be fully silent — the "latest version"
		// message is reserved for actual fetches.
		expect(warnSpy).not.toHaveBeenCalled()
		expect(infoSpy).not.toHaveBeenCalled()
	})

	it("non-TTY stdin + fetch fails → no 'latest version' message, no nag", async () => {
		setIsTTY(true, false)
		setFetchImpl((async () => {
			throw new Error("ENETUNREACH")
		}) as unknown as typeof fetch)
		await checkForUpdatesUpfront("0.6.6")
		expect(warnSpy).not.toHaveBeenCalled()
		expect(infoSpy).not.toHaveBeenCalled()
	})
})
