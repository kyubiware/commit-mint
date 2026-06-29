import type { ExecaError } from "execa"
import { execa } from "execa"
import { debug } from "../utils/debug.js"
import { createStderrParser, type ProgressHandler } from "./hook-progress.js"

export class KnownError extends Error {}

export async function assertGitRepo() {
	debug("assertGitRepo")
	const { failed } = await execa("git", ["rev-parse", "--show-toplevel"], {
		reject: false,
	})
	if (failed) {
		throw new KnownError("The current directory must be a Git repository!")
	}
}

export async function getRepoRoot() {
	const { stdout } = await execa("git", ["rev-parse", "--show-toplevel"])
	debug("getRepoRoot:", stdout.trim())
	return stdout.trim()
}

export interface StagedDiffResult {
	files: string[]
	diff: string
}

export interface ExcludedFilesResult {
	excludedFiles: string[]
}

export type DiffResult = StagedDiffResult | ExcludedFilesResult | null

export interface ChangedFile {
	path: string
	status: string
	staged: boolean
}

const DEFAULT_EXCLUDES = [
	"package-lock.json",
	"node_modules/**",
	"dist/**",
	"build/**",
	".next/**",
	"coverage/**",
	"*.log",
	"*.min.js",
	"*.min.css",
	"*.lock",
	".DS_Store",
]

export function getDefaultExcludes(): string[] {
	return [...DEFAULT_EXCLUDES]
}

export async function getStagedDiff(exclude?: string[]): Promise<DiffResult> {
	const excludeArgs = (exclude ?? []).map((e) => `:(exclude)${e}`)
	const defaultExcludeArgs = DEFAULT_EXCLUDES.map((e) => `:(exclude)${e}`)

	// Check all staged files without excludes to detect "all excluded" case
	const { stdout: allFiles } = await execa("git", ["diff", "--cached", "--name-only"])
	if (!allFiles) {
		debug("getStagedDiff: no staged files")
		return null
	}

	// Check staged files with excludes applied
	const { stdout: files } = await execa("git", [
		"diff",
		"--cached",
		"--name-only",
		...defaultExcludeArgs,
		...excludeArgs,
	])

	if (!files) {
		// All staged files were excluded
		const excludedFiles = allFiles.split("\n").filter(Boolean)
		debug("getStagedDiff: all files excluded:", excludedFiles)
		return { excludedFiles }
	}

	const { stdout: diff } = await execa("git", [
		"diff",
		"--cached",
		"--diff-algorithm=minimal",
		...defaultExcludeArgs,
		...excludeArgs,
	])

	debug("getStagedDiff:", files.split("\n").filter(Boolean).length, "files,", diff.length, "chars")
	return { files: files.split("\n").filter(Boolean), diff }
}

export async function stageAll() {
	debug("stageAll: git add -A")
	await execa("git", ["add", "-A"])
}

export async function resetStaging() {
	// On a repo with no commits, `git reset HEAD` fails because HEAD doesn't
	// resolve yet (exit 128, "ambiguous argument 'HEAD'"). Fall back to clearing
	// the index without referencing HEAD so the first commit can proceed.
	try {
		debug("resetStaging: git reset HEAD")
		await execa("git", ["reset", "HEAD"])
	} catch {
		debug("resetStaging: HEAD missing, falling back to git rm --cached")
		await execa("git", ["rm", "-r", "--cached", "--quiet", "."])
	}
}

export async function getHead(): Promise<string | null> {
	// Returns null on a repo with no commits — `git rev-parse HEAD` exits 128
	// on a fresh repo. Callers treat "headBefore === headAfter === null" as
	// "commit failed" and "null → SHA" as "first commit succeeded."
	try {
		const { stdout } = await execa("git", ["rev-parse", "HEAD"])
		return stdout.trim()
	} catch {
		debug("getHead: HEAD does not exist (fresh repo)")
		return null
	}
}

export async function getStatusShort() {
	const { stdout } = await execa("git", ["status", "--short"])
	return stdout.trim()
}

export async function getChangedFiles(): Promise<ChangedFile[]> {
	const { stdout } = await execa("git", ["status", "--short", "--untracked-files=all"])
	if (!stdout.trim()) return []
	const files = stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const indexStatus = line[0]
			const worktreeStatus = line[1]
			let path = line.slice(3)
			// `git status --short` formats rename lines as:
			//   R  oldpath -> newpath
			// `git add` (used by stageFiles()) expects only the current path,
			// so extract the path after ` -> ` when either status is R.
			if (indexStatus === "R" || worktreeStatus === "R") {
				const arrow = path.lastIndexOf(" -> ")
				if (arrow !== -1) {
					path = path.slice(arrow + 4)
				}
			}
			return {
				status: line.slice(0, 2).trim(),
				path,
				staged: indexStatus !== " " && indexStatus !== "?",
			}
		})
	debug("getChangedFiles:", files.length, "files")
	return files
}

/**
 * Return staged file paths relative to the repository root, excluding deletions.
 *
 * `git status --short` reports paths relative to the current working directory,
 * but `.cmintrc` globs are written from the repo root (matching lint-staged
 * conventions). Use this helper whenever staged paths need to match repo-root
 * globs. `--diff-filter=d` excludes staged deletions so check commands don't
 * receive paths whose content no longer exists.
 */
export async function getStagedFiles(): Promise<string[]> {
	const { stdout } = await execa("git", ["diff", "--cached", "--name-only", "--diff-filter=d"])
	const files = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
	debug("getStagedFiles:", files.length, "files")
	return files
}

/**
 * Convert cwd-relative file paths to repo-root-relative paths.
 *
 * Uses `git rev-parse --show-prefix` to discover the prefix of the current
 * working directory relative to the repo root (e.g. `"extension/"` when cwd
 * is `<repo>/extension`, or `""` when at the repo root). Useful when a caller
 * has cwd-relative paths from `getChangedFiles()` but needs to match them
 * against repo-root-relative `.cmintrc` globs (e.g. the auto-group flow,
 * which runs checks BEFORE files are staged — so `getStagedFiles()` can't be
 * used because the index doesn't yet contain those paths).
 */
export async function resolveToRepoRoot(cwdRelativePaths: string[]): Promise<string[]> {
	if (cwdRelativePaths.length === 0) return []
	const { stdout } = await execa("git", ["rev-parse", "--show-prefix"])
	const prefix = stdout.trim()
	if (!prefix) return [...cwdRelativePaths]
	return cwdRelativePaths.map((p) => `${prefix}${p}`)
}

export async function stageFiles(paths: string[]): Promise<void> {
	debug("stageFiles:", paths)
	await execa("git", ["add", ...paths])
}

export interface CommitResult {
	ok: boolean
	error?: string
	/** Collected stderr from hooks/lint-staged — set on both success and failure */
	stderr?: string
}

export async function attemptCommit(
	message: string,
	extraArgs: string[] = [],
	onProgress?: ProgressHandler,
): Promise<CommitResult> {
	debug("attemptCommit:", message, extraArgs.length ? extraArgs : "(no extra args)")
	try {
		const subprocess = execa("git", ["commit", "-m", message, ...extraArgs])

		// Collect hook output (lint-staged, biome, etc.) for post-commit display
		const stderrChunks: string[] = []
		const parser = onProgress ? createStderrParser() : null
		subprocess.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString()
			stderrChunks.push(text)
			if (parser && onProgress) {
				for (const step of parser(text)) {
					onProgress(step)
				}
			}
		})

		await subprocess
		debug("attemptCommit: success")
		return { ok: true, stderr: stderrChunks.join("") }
	} catch (error) {
		const e = error as ExecaError
		debug("attemptCommit: failed —", e.message?.slice(0, 200))
		return {
			ok: false,
			error: e.message,
			stderr: typeof e.stderr === "string" ? e.stderr : "",
		}
	}
}

export async function attemptCommitNoVerify(
	message: string,
	onProgress?: ProgressHandler,
): Promise<CommitResult> {
	debug("attemptCommitNoVerify:", message)
	return attemptCommit(message, ["--no-verify"], onProgress)
}
