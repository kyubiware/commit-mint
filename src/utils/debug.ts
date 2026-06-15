import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import { join } from "node:path"
import { dim } from "kolorist"

let enabled = false
let dirEnsured = false
let sessionWritten = false
let logFile = join(os.homedir(), ".cache", "commit-mint", "debug.log")

const LOG_DIR = join(os.homedir(), ".cache", "commit-mint")

function ensureLogDir(): void {
	if (dirEnsured) return
	mkdirSync(LOG_DIR, { recursive: true })
	dirEnsured = true
}

export function setDebug(value: boolean): void {
	enabled = value
}

export function isDebug(): boolean {
	return enabled
}

export function getLogFilePath(): string {
	return logFile
}

/** Override log file path (used by tests to avoid polluting real logs) */
export function setLogFilePath(path: string): void {
	logFile = path
}

export function writeSessionHeader(): void {
	if (sessionWritten) return
	ensureLogDir()
	writeFileSync(logFile, `--- session ${new Date().toISOString()} ---\n`, "utf8")
	sessionWritten = true
}

export function debug(...args: unknown[]): void {
	const timestamp = new Date().toISOString().slice(11, 23)
	const prefix = `[debug ${timestamp}]`
	ensureLogDir()
	appendFileSync(logFile, `${prefix} ${args.map(String).join(" ")}\n`, "utf8")
	if (!enabled) return
	console.error(dim(prefix), ...args)
}
