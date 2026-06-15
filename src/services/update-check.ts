import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import { dirname, join } from "node:path"
import { log } from "@clack/prompts"
import { cyan, green, yellow } from "kolorist"
import semver from "semver"
import { debug } from "../utils/debug.js"

const REGISTRY_URL = "https://registry.npmjs.org/@kyubiware/commit-mint/latest"
const PACKAGE_NAME = "@kyubiware/commit-mint"
const TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5000

interface CacheEntry {
	latest: string
	checkedAt: number
}

let cachePath = join(os.homedir(), ".cache", "commit-mint", "update-check.json")
let fetchImpl: typeof fetch = globalThis.fetch

/** Override cache file path (used by tests to avoid polluting real cache). */
export function setCachePath(path: string): void {
	cachePath = path
}

/** Override fetch implementation (used by tests to avoid real network). */
export function setFetchImpl(fn: typeof fetch): void {
	fetchImpl = fn
}

/**
 * Returns true when the notifier must not run: env opt-out, CI, test env,
 * non-TTY stderr, or an invalid/missing current version.
 */
export function shouldSkip(currentVersion: string): boolean {
	const noUpdate = process.env.NO_UPDATE_NOTIFIER
	if (noUpdate !== undefined && noUpdate !== "") {
		return true
	}
	const ci = process.env.CI
	if (ci !== undefined && ci !== "" && ci !== "0") {
		return true
	}
	if (process.env.NODE_ENV === "test") {
		return true
	}
	if (process.stderr.isTTY !== true) {
		return true
	}
	if (currentVersion === undefined) {
		return true
	}
	if (currentVersion === "") {
		return true
	}
	if (semver.valid(currentVersion) === null) {
		return true
	}
	return false
}

function loadCache(): Promise<CacheEntry | null> {
	try {
		const raw = readFileSync(cachePath, "utf8")
		const parsed: unknown = JSON.parse(raw)
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			typeof (parsed as CacheEntry).latest === "string" &&
			typeof (parsed as CacheEntry).checkedAt === "number"
		) {
			const entry = parsed as CacheEntry
			const ageH = ((Date.now() - entry.checkedAt) / 3_600_000).toFixed(2)
			debug("loadCache: hit — latest=%s, age=%sh", entry.latest, ageH)
			return Promise.resolve(entry)
		}
		debug("loadCache: miss — malformed entry")
		return Promise.resolve(null)
	} catch {
		debug("loadCache: miss — %s does not exist", cachePath)
		return Promise.resolve(null)
	}
}

function saveCache(entry: CacheEntry): Promise<void> {
	try {
		mkdirSync(dirname(cachePath), { recursive: true })
		writeFileSync(cachePath, JSON.stringify(entry), "utf8")
		debug("saveCache: wrote latest=%s to %s", entry.latest, cachePath)
	} catch (err) {
		debug("saveCache: failed — %s", err instanceof Error ? err.message : String(err))
		// Silently ignore: EACCES, ENOSPC, etc. The nag is best-effort.
	}
	return Promise.resolve()
}

async function fetchLatest(): Promise<string | null> {
	debug("fetchLatest: GET %s (timeout=%dms)", REGISTRY_URL, FETCH_TIMEOUT_MS)
	try {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
		try {
			const response = await fetchImpl(REGISTRY_URL, { signal: controller.signal })
			if (!response.ok) {
				debug("fetchLatest: HTTP %d — returning null", response.status)
				return null
			}
			const data = (await response.json()) as { latest?: unknown }
			if (typeof data.latest !== "string") {
				debug("fetchLatest: response missing 'latest' field — returning null")
				return null
			}
			debug("fetchLatest: ok — latest=%s", data.latest)
			return data.latest
		} finally {
			clearTimeout(timer)
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		debug("fetchLatest: error — %s", msg)
		return null
	}
}

function displayNag(current: string, latest: string): void {
	debug("displayNag: %s → %s", current, latest)
	const message =
		`Update available: ${yellow(current)} → ${green(latest)}\n` +
		`Run ${cyan(`npm update -g ${PACKAGE_NAME}`)} to update`
	log.warn(message)
}

/**
 * Run the full update check. Exported for tests; the public surface is
 * {@link checkForUpdates}, which schedules this on `beforeExit`.
 */
export async function runUpdateCheck(currentVersion: string): Promise<void> {
	debug("runUpdateCheck: currentVersion=%s", currentVersion)
	if (shouldSkip(currentVersion)) {
		debug(
			"runUpdateCheck: skipped (NO_UPDATE_NOTIFIER / CI / NODE_ENV=test / non-TTY / invalid version)",
		)
		return
	}
	try {
		const cached = await loadCache()
		if (cached && Date.now() - cached.checkedAt < TTL_MS) {
			debug("runUpdateCheck: cache fresh (<%dh), skipping fetch", TTL_MS / 3_600_000)
			if (semver.gt(cached.latest, currentVersion)) {
				displayNag(currentVersion, cached.latest)
			} else {
				debug("runUpdateCheck: current >= latest, no nag")
			}
			return
		}
		if (cached) {
			debug("runUpdateCheck: cache stale, refetching")
		} else {
			debug("runUpdateCheck: no cache, fetching")
		}
		const latest = await fetchLatest()
		if (latest === null) {
			debug("runUpdateCheck: fetch returned null, not saving cache")
			return
		}
		await saveCache({ latest, checkedAt: Date.now() })
		if (semver.gt(latest, currentVersion)) {
			displayNag(currentVersion, latest)
		} else {
			debug("runUpdateCheck: current >= latest, no nag")
		}
	} catch (err) {
		// Silently swallow: update check must never surface errors to the user.
		debug("runUpdateCheck: unexpected error — %s", err instanceof Error ? err.message : String(err))
	}
	debug("runUpdateCheck: complete")
}

/**
 * Register the update check to run once on `process.beforeExit`.
 *
 * Uses `process.once` (not `on`) so the listener can't re-fire after the
 * async check schedules I/O — repeated re-fire is what kept the process
 * alive when the registry fetch failed or the undici keep-alive socket
 * lingered. After the check resolves we explicitly `process.exit` to
 * short-circuit the undici socket's ~4s keep-alive window; any caller-set
 * `process.exitCode` is preserved.
 */
export function checkForUpdates(currentVersion: string): void {
	debug("checkForUpdates: registering beforeExit listener (currentVersion=%s)", currentVersion)
	process.once("beforeExit", () => {
		debug("checkForUpdates: beforeExit fired, running update check")
		void runUpdateCheck(currentVersion).finally(() => {
			const code = process.exitCode ?? 0
			debug("checkForUpdates: forcing process.exit(%d)", code)
			process.exit(code)
		})
	})
}
