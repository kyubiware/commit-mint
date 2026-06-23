import { debug } from "../utils/debug.js"
import { readConfig, writeConfig } from "./config.js"

/**
 * Parse a stored `run-checks` INI value into a boolean.
 *
 * Polarity is positive: `true` means "run user-defined pre-commit checks"
 * (the default behavior), `false` means "skip them".
 *
 * Accepts true variants ("true", "1", "yes" — case-insensitive) and boolean
 * values from ini.parse (which converts unquoted `true`/`false` to actual
 * booleans). Returns **true** for undefined / empty / unknown values so the
 * default behavior is to run checks — a fresh install with no INI key must
 * behave identically to `run-checks = true`.
 */
export function parseRunChecksValue(value: unknown): boolean {
	if (typeof value === "boolean") return value
	if (typeof value !== "string" || !value) return true
	return !["false", "0", "no"].includes(value.toLowerCase())
}

/** Read the persisted run-checks preference from `~/.commit-mint`. Defaults to true. */
export async function getRunChecks(): Promise<boolean> {
	const config = await readConfig()
	const raw = config["run-checks"]
	const enabled = parseRunChecksValue(raw)
	debug("getRunChecks: raw=%s enabled=%s", raw, enabled)
	return enabled
}

/** Persist the run-checks preference to `~/.commit-mint`. */
export async function setRunChecks(enabled: boolean): Promise<void> {
	const value = enabled ? "true" : "false"
	debug("setRunChecks: %s", value)
	await writeConfig({ "run-checks": value })
}
