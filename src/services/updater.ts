import { execa } from "execa"
import semver from "semver"
import { debug } from "../utils/debug.js"

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun"

export const PACKAGE_NAME = "@kyubiware/commit-mint"

/**
 * Detect the active package manager from the `npm_config_user_agent` env var.
 * Format: "<pm>/<version> <...>" — e.g. "npm/10.2.0 node/v20.10.0".
 * Empty/undefined input and unrecognized prefixes fall back to "npm".
 */
export function detectPackageManager(userAgent: string | undefined): PackageManager {
	if (!userAgent) {
		debug("updater: empty userAgent, defaulting to npm")
		return "npm"
	}
	const prefix = userAgent.split("/")[0]
	switch (prefix) {
		case "pnpm":
			return "pnpm"
		case "yarn":
			return "yarn"
		case "bun":
			return "bun"
		case "npm":
			return "npm"
		default:
			debug("updater: unknown userAgent prefix '%s', defaulting to npm", prefix)
			return "npm"
	}
}

/**
 * Build the global install shell command for the given package manager.
 * Returned as a single string suitable for `execa(cmd, [], { shell: true })`.
 */
export function buildUpdateCommand(pm: PackageManager, packageName: string = PACKAGE_NAME): string {
	switch (pm) {
		case "npm":
			return `npm install -g ${packageName}@latest`
		case "pnpm":
			return `pnpm add -g ${packageName}@latest`
		case "yarn":
			return `yarn global add ${packageName}@latest`
		case "bun":
			return `bun add -g ${packageName}@latest`
	}
}

/**
 * Fetch the latest version from the npm registry via `npm view <pkg> version`.
 * Returns the trimmed version string on success, or null on any failure
 * (non-zero exit, empty stdout, thrown error). Never throws.
 */
export async function fetchLatestVersion(
	packageName: string = PACKAGE_NAME,
): Promise<string | null> {
	debug("updater: fetching latest version for %s", packageName)
	try {
		const result = await execa("npm", ["view", packageName, "version"], { reject: false })
		if (result.exitCode !== 0) {
			debug("updater: npm view exited %d", result.exitCode)
			return null
		}
		const trimmed = result.stdout.trim()
		if (!trimmed) {
			debug("updater: npm view returned empty stdout")
			return null
		}
		debug("updater: latest=%s", trimmed)
		return trimmed
	} catch (err) {
		debug(
			"updater: fetchLatestVersion error — %s",
			err instanceof Error ? err.message : String(err),
		)
		return null
	}
}

/**
 * True iff `latest` is strictly greater than `current` per semver. Returns
 * false on invalid semver input rather than throwing.
 */
export function isUpdateAvailable(current: string, latest: string): boolean {
	try {
		return semver.gt(latest, current)
	} catch (err) {
		debug("updater: isUpdateAvailable error — %s", err instanceof Error ? err.message : String(err))
		return false
	}
}

/**
 * Run the global install command for the given package manager. Streams
 * the installer's live output to the user's terminal via `stdio: "inherit"`.
 * Returns true iff the install exits with code 0.
 */
export async function runUpdate(
	pm: PackageManager,
	packageName: string = PACKAGE_NAME,
): Promise<boolean> {
	const command = buildUpdateCommand(pm, packageName)
	debug("updater: running %s", command)
	try {
		const result = await execa(command, [], {
			shell: true,
			reject: false,
			stdio: "inherit",
		})
		return result.exitCode === 0
	} catch (err) {
		debug("updater: runUpdate error — %s", err instanceof Error ? err.message : String(err))
		return false
	}
}
