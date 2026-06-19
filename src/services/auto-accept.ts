import { debug } from "../utils/debug.js"
import { readConfig, writeConfig } from "./config.js"

/** Parse a stored `auto-accept` INI value into a boolean.
 *  Accepts true variants ("true", "1", "yes" — case-insensitive).
 *  Handles boolean values from ini.parse (which converts unquoted
 *  `true`/`false` to actual booleans).
 *  Everything else (including undefined) returns false. */
export function parseAutoAcceptValue(value: unknown): boolean {
	if (typeof value === "boolean") return value
	if (typeof value !== "string" || !value) return false
	return ["true", "1", "yes"].includes(value.toLowerCase())
}

/** Read the persisted auto-accept preference from `~/.commit-mint`. */
export async function getAutoAccept(): Promise<boolean> {
	const config = await readConfig()
	const raw = config["auto-accept"]
	const enabled = parseAutoAcceptValue(raw)
	debug("getAutoAccept: raw=%s enabled=%s", raw, enabled)
	return enabled
}

/** Persist the auto-accept preference to `~/.commit-mint`. */
export async function setAutoAccept(enabled: boolean): Promise<void> {
	const value = enabled ? "true" : "false"
	debug("setAutoAccept: %s", value)
	await writeConfig({ "auto-accept": value })
}
