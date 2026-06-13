import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { dim } from "kolorist";

let enabled = false;
let dirEnsured = false;
let sessionWritten = false;

const LOG_DIR = join(os.homedir(), ".cache", "commit-mint");
const LOG_FILE = join(LOG_DIR, "debug.log");

function ensureLogDir(): void {
	if (dirEnsured) return;
	mkdirSync(LOG_DIR, { recursive: true });
	dirEnsured = true;
}

export function setDebug(value: boolean): void {
	enabled = value;
}

export function isDebug(): boolean {
	return enabled;
}

export function getLogFilePath(): string {
	return LOG_FILE;
}

export function writeSessionHeader(): void {
	if (sessionWritten) return;
	ensureLogDir();
	appendFileSync(LOG_FILE, `--- session ${new Date().toISOString()} ---\n`, "utf8");
	sessionWritten = true;
}

export function debug(...args: unknown[]): void {
	if (!enabled) return;
	const timestamp = new Date().toISOString().slice(11, 23);
	const prefix = `[debug ${timestamp}]`;
	console.error(dim(prefix), ...args);
	ensureLogDir();
	appendFileSync(LOG_FILE, `${prefix} ${args.map(String).join(" ")}\n`, "utf8");
}
