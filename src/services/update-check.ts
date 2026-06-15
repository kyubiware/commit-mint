import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import { dirname, join } from "node:path"
import { log, spinner } from "@clack/prompts"
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

/**
 * Fetch latest version from the registry. Aborts on FETCH_TIMEOUT_MS or when
 * `parentSignal` aborts (user keypress). Returns null on any failure so the
 * caller can degrade silently.
 */
async function fetchLatest(parentSignal?: AbortSignal): Promise<string | null> {
	debug("fetchLatest: GET %s (timeout=%dms)", REGISTRY_URL, FETCH_TIMEOUT_MS)
	try {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

		// Wire parent abort (user keypress) → fetch abort.
		const onParentAbort = () => controller.abort()
		if (parentSignal) {
			if (parentSignal.aborted) {
				controller.abort()
			} else {
				parentSignal.addEventListener("abort", onParentAbort, { once: true })
			}
		}

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
			if (parentSignal) parentSignal.removeEventListener("abort", onParentAbort)
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
 * Outcome of an update check. Callers use this to decide which (if any)
 * non-nag message to show — e.g. "You are on the latest version" is only
 * appropriate after a real fetch, not on a cache hit.
 */
export type UpdateCheckStatus =
	| "skipped"
	| "cache-update"
	| "cache-current"
	| "fetch-update"
	| "fetch-current"
	| "fetch-failed-or-aborted"
	| "error"

/**
 * Run the full update check. Exported for tests; the public surface is
 * {@link checkForUpdatesUpfront}. Accepts an optional AbortSignal that
 * propagates to the underlying fetch — used by the cancellable spinner.
 *
 * Returns an {@link UpdateCheckStatus} so the caller can distinguish a
 * real fetch that found the user current (eligible for "You are on the
 * latest version" feedback) from a silent cache hit.
 */
export async function runUpdateCheck(
	currentVersion: string,
	parentSignal?: AbortSignal,
): Promise<UpdateCheckStatus> {
	debug("runUpdateCheck: currentVersion=%s", currentVersion)
	if (shouldSkip(currentVersion)) {
		debug(
			"runUpdateCheck: skipped (NO_UPDATE_NOTIFIER / CI / NODE_ENV=test / non-TTY / invalid version)",
		)
		return "skipped"
	}
	try {
		const cached = await loadCache()
		if (cached && Date.now() - cached.checkedAt < TTL_MS) {
			debug("runUpdateCheck: cache fresh (<%dh), skipping fetch", TTL_MS / 3_600_000)
			if (semver.gt(cached.latest, currentVersion)) {
				displayNag(currentVersion, cached.latest)
				return "cache-update"
			}
			debug("runUpdateCheck: current >= latest, no nag")
			return "cache-current"
		}
		if (cached) {
			debug("runUpdateCheck: cache stale, refetching")
		} else {
			debug("runUpdateCheck: no cache, fetching")
		}
		const latest = await fetchLatest(parentSignal)
		if (latest === null) {
			debug("runUpdateCheck: fetch returned null, not saving cache")
			return "fetch-failed-or-aborted"
		}
		await saveCache({ latest, checkedAt: Date.now() })
		if (semver.gt(latest, currentVersion)) {
			displayNag(currentVersion, latest)
			return "fetch-update"
		}
		debug("runUpdateCheck: current >= latest, no nag")
		return "fetch-current"
	} catch (err) {
		// Silently swallow: update check must never surface errors to the user.
		debug("runUpdateCheck: unexpected error — %s", err instanceof Error ? err.message : String(err))
		return "error"
	}
}

/**
 * Run the update check at startup. Silent when:
 *   - skip conditions match (CI, NO_UPDATE_NOTIFIER, NODE_ENV=test, non-TTY
 *     stderr, invalid version)
 *   - cache is fresh (< 24h old) — only displays nag if update available.
 *     A cache-hit-current result produces NO output (no "latest version"
 *     message), because no actual check was performed.
 *   - stdin is non-interactive (piped) — runs silently without spinner, but
 *     still shows "You are on the latest version" after a successful fetch
 *
 * On a stale/missing cache with interactive stdin, shows a spinner that the
 * user can dismiss by pressing any key. Ctrl+C restores the terminal and
 * exits with conventional code 130.
 */
export async function checkForUpdatesUpfront(currentVersion: string): Promise<void> {
	debug("checkForUpdatesUpfront: currentVersion=%s", currentVersion)
	if (shouldSkip(currentVersion)) {
		debug(
			"checkForUpdatesUpfront: skipped (NO_UPDATE_NOTIFIER / CI / NODE_ENV=test / non-TTY / invalid version)",
		)
		return
	}

	// Fast path: fresh cache, no network needed. Silent on cache hit — the
	// "You are on the latest version" message is reserved for actual fetches.
	const cached = await loadCache()
	if (cached && Date.now() - cached.checkedAt < TTL_MS) {
		debug("checkForUpdatesUpfront: cache fresh (<%dh), skipping fetch", TTL_MS / 3_600_000)
		if (semver.gt(cached.latest, currentVersion)) {
			displayNag(currentVersion, cached.latest)
		} else {
			debug("checkForUpdatesUpfront: current >= latest, no nag")
		}
		return
	}

	if (cached) {
		debug("checkForUpdatesUpfront: cache stale, refetching")
	} else {
		debug("checkForUpdatesUpfront: no cache, fetching")
	}

	// Slow path: cancellable spinner if stdin is interactive.
	const stdin = process.stdin
	if (stdin.isTTY !== true || typeof stdin.setRawMode !== "function") {
		debug("checkForUpdatesUpfront: stdin not interactive, running silent check")
		const status = await runUpdateCheck(currentVersion)
		reportFetchCurrent(status)
		return
	}

	await runCheckWithSpinner(currentVersion)
}

/**
 * Surface "You are on the latest version" feedback only when the check
 * actually performed a fetch and the user is current. Silent on cache hits,
 * skips, failures, and aborts.
 */
function reportFetchCurrent(status: UpdateCheckStatus): void {
	if (status === "fetch-current") {
		log.info(green("You are on the latest version"))
	}
}

/**
 * Attach a "press any key to skip" listener to stdin. Returns a cleanup
 * function that restores raw mode + pauses stdin; safe to call multiple times.
 * Returns `failed: true` if raw mode could not be enabled (caller should fall
 * back to a silent check).
 *
 * On any keypress: aborts `controller`. On Ctrl+C (byte 0x03): runs cleanup,
 * stops the spinner with `spinnerMsg`, and exits with conventional code 130.
 */
function attachStdinSkip(
	controller: AbortController,
	spinner: { stop: (msg: string) => void },
	spinnerMsg: string,
): { cleanup: () => void; failed: boolean } {
	const stdin = process.stdin
	let cleanedUp = false

	const cleanup = (): void => {
		if (cleanedUp) return
		cleanedUp = true
		stdin.off("data", onData)
		try {
			stdin.setRawMode(false)
		} catch (err) {
			debug(
				"attachStdinSkip: setRawMode(false) failed — %s",
				err instanceof Error ? err.message : String(err),
			)
		}
		try {
			stdin.pause()
		} catch {
			// ignore — already paused
		}
	}

	function onData(buffer: Buffer): void {
		const byte = buffer[0]
		debug("attachStdinSkip: stdin byte=0x%s", byte.toString(16).padStart(2, "0"))
		if (byte === 0x03) {
			// Ctrl+C in raw mode does not auto-generate SIGINT. Restore the
			// terminal before exiting so the user's shell isn't left in raw mode.
			debug("attachStdinSkip: Ctrl+C (0x03), exiting")
			cleanup()
			spinner.stop(spinnerMsg)
			process.exit(130)
		}
		debug("attachStdinSkip: user pressed key, aborting check")
		controller.abort()
	}

	try {
		stdin.setRawMode(true)
		stdin.resume()
		stdin.on("data", onData)
		return { cleanup, failed: false }
	} catch (err) {
		debug(
			"attachStdinSkip: setRawMode failed — %s",
			err instanceof Error ? err.message : String(err),
		)
		return { cleanup: () => {}, failed: true }
	}
}

/**
 * Show a cancellable spinner while the check runs. Puts stdin in raw mode to
 * capture individual keypresses via {@link attachStdinSkip}.
 */
async function runCheckWithSpinner(currentVersion: string): Promise<void> {
	debug("runCheckWithSpinner: showing cancellable spinner")
	const s = spinner()
	s.start("Checking for updates (press any key to skip)")

	const controller = new AbortController()
	const handler = attachStdinSkip(controller, s, "Cancelled")

	if (handler.failed) {
		s.stop("")
		const status = await runUpdateCheck(currentVersion)
		reportFetchCurrent(status)
		return
	}

	let status: UpdateCheckStatus
	try {
		status = await runUpdateCheck(currentVersion, controller.signal)
	} finally {
		handler.cleanup()
	}

	if (controller.signal.aborted) {
		debug("runCheckWithSpinner: spinner dismissed by user")
		s.stop("Skipped")
	} else if (status === "fetch-current") {
		s.stop(green("You are on the latest version"))
	} else if (status === "fetch-update") {
		s.stop("") // nag already shown via log.warn inside runUpdateCheck
	} else if (status === "fetch-failed-or-aborted") {
		s.stop("Update check failed")
	} else {
		s.stop("")
	}
}
