import { readFile } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"

const LOG_PATH = join(os.homedir(), ".cache", "commit-mint", "debug.log")
const SESSION_SEPARATOR = /^--- session .+ ---$/

export async function logsCommand(flags: { lines?: number }): Promise<void> {
	let content: string
	try {
		content = await readFile(LOG_PATH, "utf8")
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			console.error("No debug logs found. Run cmint with any command first.")
			process.exit(1)
		}
		throw err
	}

	if (content.trim() === "") {
		console.error("No debug logs found. Run cmint with any command first.")
		process.exit(1)
	}

	const allLines = content.split("\n")
	let lastSessionIndex = -1
	for (let i = allLines.length - 1; i >= 0; i--) {
		if (SESSION_SEPARATOR.test(allLines[i])) {
			lastSessionIndex = i
			break
		}
	}

	const sessionLines = lastSessionIndex === -1 ? allLines : allLines.slice(lastSessionIndex + 1)
	const filtered = sessionLines.filter(
		(line) => line.length > 0 || sessionLines.indexOf(line) === 0,
	)

	if (filtered.length === 0) {
		console.error("No debug logs found. Run cmint with any command first.")
		process.exit(1)
	}

	const lines =
		flags.lines !== undefined && flags.lines > 0 ? filtered.slice(-flags.lines) : filtered

	for (const line of lines) {
		console.log(line)
	}
}
