import { Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	attemptCommit,
	attemptCommitNoVerify,
	getChangedFiles,
	getHead,
	getStagedDiff,
	resetStaging,
	stageFiles,
} from "./git.js"

// Mock execa
const mockExeca = vi.fn()
vi.mock("execa", () => ({
	execa: (...args: unknown[]) => mockExeca(...args),
}))

// Mock debug
vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}))

// Mock hook-progress (createStderrParser returns parser that detects [STARTED]/[COMPLETED]/[FAILED] lines)
vi.mock("../services/hook-progress.js", () => ({
	createStderrParser: vi.fn(() => {
		let buffer = ""
		return (chunk: string) => {
			buffer += chunk
			const steps: Array<{ status: string; command: string; tool: string }> = []
			const lines = buffer.split("\n")
			buffer = lines.pop() ?? ""
			for (const line of lines) {
				const match = line.match(/\[(STARTED|COMPLETED|FAILED)\]\s+(.+)/)
				if (match) {
					steps.push({
						status: match[1].toLowerCase(),
						command: match[2].trim(),
						tool: match[2].trim().split(" ")[0],
					})
				}
			}
			return steps
		}
	}),
}))

// Capture stderr output
const stderrChunks: string[] = []
const originalStderrWrite = process.stderr.write.bind(process.stderr)

beforeEach(() => {
	vi.clearAllMocks()
	stderrChunks.length = 0
	process.stderr.write = vi.fn((chunk: string | Buffer) => {
		stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString())
		return true
	}) as never
})

afterEach(() => {
	process.stderr.write = originalStderrWrite
})

/**
 * Creates a mock execa subprocess that:
 * - Has a .stderr Readable stream that emits given lines
 * - Is thenable (await resolves with { stdout, stderr })
 *
 * biome-ignore: the .then/.catch/.finally properties are required
 * to simulate execa's thenable subprocess return type.
 */
function createMockSubprocess(options?: { stderrLines?: string[] }) {
	const stderrStream = new Readable({ read() {} })

	const resultPromise = new Promise<{ stdout: string; stderr: string }>((resolve) => {
		setImmediate(() => {
			if (options?.stderrLines) {
				for (const line of options.stderrLines) {
					stderrStream.push(Buffer.from(`${line}\n`))
				}
			}
			stderrStream.push(null)
			resolve({
				stdout: "",
				stderr: options?.stderrLines?.join("\n") ?? "",
			})
		})
	})

	// execa returns a thenable subprocess with .stderr
	return Object.assign(resultPromise, {
		stderr: stderrStream,
		// biome-ignore lint/suspicious/noThenProperty: mock needs to be a thenable to simulate execa's subprocess
		then: resultPromise.then.bind(resultPromise),
		catch: resultPromise.catch.bind(resultPromise),
		finally: resultPromise.finally.bind(resultPromise),
	})
}

describe("attemptCommit", () => {
	it("collects hook stderr in CommitResult on success", async () => {
		const lintStagedOutput = [
			"[STARTED] biome check --write",
			"[COMPLETED] biome check --write",
			"[STARTED] npm run typecheck",
			"[COMPLETED] npm run typecheck",
		]

		mockExeca.mockReturnValue(createMockSubprocess({ stderrLines: lintStagedOutput }))

		const result = await attemptCommit("feat: add checks")

		expect(result.ok).toBe(true)
		expect(result.stderr).toContain("biome check --write")
		expect(result.stderr).toContain("npm run typecheck")
	})

	it("captures stderr in result on failure", async () => {
		const error = Object.assign(new Error("Command failed: git commit"), {
			stderr: "✖ Running tasks for staged files...\n✖ biome check --apply failed without output",
		})

		mockExeca.mockImplementation(() => {
			throw error
		})

		const result = await attemptCommit("feat: broken")

		expect(result.ok).toBe(false)
		expect(result.stderr).toContain("biome check --apply failed")
	})

	it("returns ok:true when commit succeeds with no hook output", async () => {
		mockExeca.mockReturnValue(createMockSubprocess({ stderrLines: [] }))

		const result = await attemptCommit("chore: cleanup")

		expect(result.ok).toBe(true)
	})

	it("passes correct args to execa", async () => {
		mockExeca.mockReturnValue(createMockSubprocess({ stderrLines: [] }))

		await attemptCommit("feat: test")

		expect(mockExeca).toHaveBeenCalledWith("git", ["commit", "-m", "feat: test"])
	})

	it("passes extra args to git commit", async () => {
		mockExeca.mockReturnValue(createMockSubprocess({ stderrLines: [] }))

		await attemptCommit("feat: test", ["--no-verify"])

		expect(mockExeca).toHaveBeenCalledWith("git", ["commit", "-m", "feat: test", "--no-verify"])
	})

	it("fires onProgress callback for STARTED lines", async () => {
		const stderrLines = ["[STARTED] biome check --write", "[COMPLETED] biome check --write"]
		mockExeca.mockReturnValue(createMockSubprocess({ stderrLines }))

		const onProgress = vi.fn()
		await attemptCommit("feat: test", [], onProgress)

		expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ status: "started" }))
	})

	it("fires onProgress callback for COMPLETED lines", async () => {
		const stderrLines = ["[STARTED] biome check --write", "[COMPLETED] biome check --write"]
		mockExeca.mockReturnValue(createMockSubprocess({ stderrLines }))

		const onProgress = vi.fn()
		await attemptCommit("feat: test", [], onProgress)

		expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }))
	})

	it("fires onProgress callback for FAILED lines", async () => {
		const stderrLines = ["[STARTED] eslint", "[FAILED] eslint"]
		mockExeca.mockReturnValue(createMockSubprocess({ stderrLines }))

		const onProgress = vi.fn()
		await attemptCommit("feat: test", [], onProgress)

		expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }))
	})

	it("works without onProgress callback (backward compat)", async () => {
		mockExeca.mockReturnValue(createMockSubprocess({ stderrLines: [] }))

		const result = await attemptCommit("feat: test")

		expect(result.ok).toBe(true)
	})
})

describe("attemptCommitNoVerify", () => {
	it("calls attemptCommit with --no-verify flag", async () => {
		mockExeca.mockReturnValue(createMockSubprocess({ stderrLines: [] }))

		const result = await attemptCommitNoVerify("feat: bypass hooks")

		expect(result.ok).toBe(true)
		expect(mockExeca).toHaveBeenCalledWith("git", [
			"commit",
			"-m",
			"feat: bypass hooks",
			"--no-verify",
		])
	})

	it("passes onProgress through to attemptCommit", async () => {
		const stderrLines = ["[STARTED] biome check --write", "[COMPLETED] biome check --write"]
		mockExeca.mockReturnValue(createMockSubprocess({ stderrLines }))

		const onProgress = vi.fn()
		await attemptCommitNoVerify("feat: test", onProgress)

		expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ status: "started" }))
		expect(mockExeca).toHaveBeenCalledWith("git", ["commit", "-m", "feat: test", "--no-verify"])
	})
})

describe("getStagedDiff", () => {
	it("returns null when nothing is staged", async () => {
		// First call: git diff --cached --name-only (no excludes) → empty
		mockExeca.mockResolvedValue({ stdout: "" })

		const result = await getStagedDiff()

		expect(result).toBeNull()
	})

	it("returns files and diff when non-excluded files are staged", async () => {
		mockExeca
			// First call: git diff --cached --name-only (no excludes) → finds staged files
			.mockResolvedValueOnce({ stdout: "src/foo.ts\nsrc/bar.ts" })
			// Second call: git diff --cached --name-only (with excludes) → same files
			.mockResolvedValueOnce({ stdout: "src/foo.ts\nsrc/bar.ts" })
			// Third call: git diff --cached --diff-algorithm=minimal (with excludes)
			.mockResolvedValueOnce({ stdout: "diff content here" })

		const result = await getStagedDiff()

		expect(result).toEqual({
			files: ["src/foo.ts", "src/bar.ts"],
			diff: "diff content here",
		})
	})

	it("returns excludedFiles when all staged files are excluded", async () => {
		mockExeca
			// First call: git diff --cached --name-only WITHOUT excludes → finds staged files
			.mockResolvedValueOnce({ stdout: "package-lock.json" })
			// Second call: git diff --cached --name-only WITH excludes → empty
			.mockResolvedValueOnce({ stdout: "" })

		const result = await getStagedDiff()

		expect(result).toEqual({ excludedFiles: ["package-lock.json"] })
	})

	it("returns excludedFiles with multiple lockfiles", async () => {
		mockExeca
			.mockResolvedValueOnce({ stdout: "package-lock.json\npnpm-lock.yaml" })
			.mockResolvedValueOnce({ stdout: "" })

		const result = await getStagedDiff()

		expect(result).toEqual({ excludedFiles: ["package-lock.json", "pnpm-lock.yaml"] })
	})
})

describe("getChangedFiles", () => {
	it("returns empty array when no changes", async () => {
		mockExeca.mockResolvedValue({ stdout: "" })
		const result = await getChangedFiles()
		expect(result).toEqual([])
	})

	it("parses status short output into ChangedFile array", async () => {
		mockExeca.mockResolvedValue({ stdout: "M  src/foo.ts\n?? src/new.ts\n D src/old.ts" })
		const result = await getChangedFiles()
		expect(result).toEqual([
			{ status: "M", path: "src/foo.ts", staged: true },
			{ status: "??", path: "src/new.ts", staged: false },
			{ status: "D", path: "src/old.ts", staged: false },
		])
	})

	it("parses worktree-modified files with leading space in status", async () => {
		mockExeca.mockResolvedValue({ stdout: " M src/commands/commit.ts" })
		const result = await getChangedFiles()
		expect(result).toEqual([{ status: "M", path: "src/commands/commit.ts", staged: false }])
	})

	it("calls git status --short with --untracked-files=all", async () => {
		mockExeca.mockResolvedValue({ stdout: "" })
		await getChangedFiles()
		expect(mockExeca).toHaveBeenCalledWith("git", ["status", "--short", "--untracked-files=all"])
	})
})

describe("stageFiles", () => {
	it("stages specific files", async () => {
		mockExeca.mockResolvedValue({ stdout: "" })
		await stageFiles(["src/foo.ts", "src/bar.ts"])
		expect(mockExeca).toHaveBeenCalledWith("git", ["add", "src/foo.ts", "src/bar.ts"])
	})

	it("stages a single file", async () => {
		mockExeca.mockResolvedValue({ stdout: "" })
		await stageFiles(["src/foo.ts"])
		expect(mockExeca).toHaveBeenCalledWith("git", ["add", "src/foo.ts"])
	})
})

describe("resetStaging", () => {
	it("unstages files via git reset HEAD on a normal repo", async () => {
		mockExeca.mockResolvedValue({ stdout: "" })

		await resetStaging()

		expect(mockExeca).toHaveBeenCalledWith("git", ["reset", "HEAD"])
	})

	it("does not throw when HEAD does not exist (fresh repo with no commits)", async () => {
		// Repro: `git reset HEAD` exits non-zero on a repo that has no commits yet,
		// because HEAD doesn't resolve. cmint must support making the first commit.
		const headError = new Error("fatal: ambiguous argument 'HEAD': unknown revision")
		mockExeca.mockRejectedValueOnce(headError).mockResolvedValue({ stdout: "" })

		await expect(resetStaging()).resolves.not.toThrow()
	})

	it("falls back to git rm --cached when HEAD does not exist", async () => {
		// Verify the implementation actually clears the index without referencing HEAD,
		// not just that it swallows the error. `git rm -r --cached --quiet .` removes
		// every path from the index while keeping the working tree intact.
		const headError = new Error("fatal: ambiguous argument 'HEAD'")
		mockExeca.mockRejectedValueOnce(headError).mockResolvedValue({ stdout: "" })

		await resetStaging()

		expect(mockExeca).toHaveBeenCalledWith("git", ["rm", "-r", "--cached", "--quiet", "."])
	})
})

describe("getHead", () => {
	it("returns HEAD sha on a repo with commits", async () => {
		mockExeca.mockResolvedValue({ stdout: "abc123def456\n" })

		const result = await getHead()

		expect(result).toBe("abc123def456")
	})

	it("returns null when HEAD does not exist (fresh repo with no commits)", async () => {
		// Repro: `git rev-parse HEAD` exits non-zero on a repo with zero commits.
		// Callers treat "no prior HEAD" + "commit succeeded" as "first commit succeeded."
		mockExeca.mockRejectedValueOnce(new Error("fatal: ambiguous argument 'HEAD'"))

		const result = await getHead()

		expect(result).toBeNull()
	})
})
