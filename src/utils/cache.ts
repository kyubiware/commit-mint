import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { debug } from "./debug.js"

const CACHE_DIR = join(os.homedir(), ".cache", "commit-mint")

function repoHash(repoPath: string): string {
	return createHash("sha256").update(repoPath).digest("hex").slice(0, 12)
}

function cachePath(repoPath: string): string {
	return join(CACHE_DIR, `${repoHash(repoPath)}.json`)
}

export interface CachedCommit {
	message: string
	timestamp: number
	repoPath: string
}

export async function saveCachedCommit(repoPath: string, message: string) {
	await mkdir(CACHE_DIR, { recursive: true })
	const data: CachedCommit = {
		message,
		timestamp: Date.now(),
		repoPath,
	}
	const path = cachePath(repoPath)
	debug("saveCachedCommit: saving to %s", path)
	await writeFile(path, JSON.stringify(data, null, 2), "utf8")
}

export async function loadCachedCommit(repoPath: string): Promise<CachedCommit | null> {
	const path = cachePath(repoPath)
	debug("loadCachedCommit: loading from %s", path)
	try {
		const raw = await readFile(path, "utf8")
		const data = JSON.parse(raw) as CachedCommit
		debug("loadCachedCommit: found message from %s", new Date(data.timestamp).toISOString())
		return data
	} catch {
		debug("loadCachedCommit: no cached commit found")
		return null
	}
}
