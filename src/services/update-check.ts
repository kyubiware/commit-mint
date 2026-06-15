import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import { dirname, join } from "node:path"
import { log } from "@clack/prompts"
import { cyan, green, yellow } from "kolorist"
import semver from "semver"

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
			return Promise.resolve(parsed as CacheEntry)
		}
		return Promise.resolve(null)
	} catch {
		return Promise.resolve(null)
	}
}

function saveCache(entry: CacheEntry): Promise<void> {
	try {
		mkdirSync(dirname(cachePath), { recursive: true })
		writeFileSync(cachePath, JSON.stringify(entry), "utf8")
	} catch {
		// Silently ignore: EACCES, ENOSPC, etc. The nag is best-effort.
	}
	return Promise.resolve()
}

async function fetchLatest(): Promise<string | null> {
	try {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
		try {
			const response = await fetchImpl(REGISTRY_URL, { signal: controller.signal })
			if (!response.ok) {
				return null
			}
			const data = (await response.json()) as { latest?: unknown }
			if (typeof data.latest !== "string") {
				return null
			}
			return data.latest
		} finally {
			clearTimeout(timer)
		}
	} catch {
		return null
	}
}

function displayNag(current: string, latest: string): void {
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
	if (shouldSkip(currentVersion)) {
		return
	}
	try {
		const cached = await loadCache()
		if (cached && Date.now() - cached.checkedAt < TTL_MS) {
			if (semver.gt(cached.latest, currentVersion)) {
				displayNag(currentVersion, cached.latest)
			}
			return
		}
		const latest = await fetchLatest()
		if (latest === null) {
			return
		}
		await saveCache({ latest, checkedAt: Date.now() })
		if (semver.gt(latest, currentVersion)) {
			displayNag(currentVersion, latest)
		}
	} catch {
		// Silently swallow: update check must never surface errors to the user.
	}
}

/** Register the update check to run on `process.beforeExit`. */
export function checkForUpdates(currentVersion: string): void {
	process.on("beforeExit", () => {
		void runUpdateCheck(currentVersion)
	})
}
