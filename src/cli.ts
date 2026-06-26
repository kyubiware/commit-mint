import { commitCommand } from "./commands/commit.js"
import { setDebug, writeSessionHeader } from "./utils/debug.js"

/** `cmint auto` subcommand handler — equivalent to `cmint --auto`. */
export async function handleAutoSubcommand(version: string) {
	writeSessionHeader()
	setDebug(false)
	await commitCommand({ auto: true, retry: false, agent: false }, version)
}
