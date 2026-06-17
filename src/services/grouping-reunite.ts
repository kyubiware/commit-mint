import type { CommitGroup } from "./grouping-parser.js"

/**
 * # Test/source reunification
 *
 * AI grouping prompts ask the model to keep a source file and its tests in the
 * same commit group, but the model frequently ignores that instruction (it
 * split `git.ts` from `git.test.ts` in the bug report that motivated this
 * module). The functions here provide a deterministic post-processing pass
 * that moves misplaced test files back into the group already containing
 * their source counterpart, regardless of what the model decided.
 *
 * Supported layouts (in priority order):
 * 1. Co-located: `src/foo.ts` ↔ `src/foo.test.ts`
 * 2. `__tests__/` mirror: `src/foo.ts` ↔ `src/__tests__/foo.test.ts`
 * 3. `tests/` or `test/` mirror: `src/foo.ts` ↔ `tests/foo.test.ts`
 *
 * Reunification runs inside `validateGroups()` (see `grouping.ts`) after
 * hallucinated-path filtering so only real files participate.
 */

/** Suffixes that mark a file as a test companion of a same-name source. */
const TEST_SUFFIXES = [".test", ".spec"] as const

/**
 * Extensions tried when looking for a source counterpart for a test file. The
 * test file's own extension is usually the right one, but we also try common
 * alternates (a `.test.tsx` may back a `.tsx` or a `.ts`).
 */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"] as const

/** Matches a test file by extension regardless of which suffix it uses. */
const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/

/** Directory prefixes/segments that mirror source layout for non-co-located tests. */
const TEST_DIR_PREFIXES = ["tests/", "test/"] as const

/** Marker segment for co-located `__tests__/` directories. */
const TESTS_DIR_SEGMENT = "/__tests__/"

function stripTestSuffix(filename: string): string | null {
	for (const suffix of TEST_SUFFIXES) {
		const marker = `${suffix}.`
		const idx = filename.lastIndexOf(marker)
		if (idx > 0) return filename.slice(0, idx)
	}
	return null
}

function withEachExtension(base: string): string[] {
	return SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`)
}

/** Co-located: `dir/foo.test.ts` → `dir/foo.{ts,tsx,...}` */
function colocatedCandidates(testPath: string): string[] {
	const base = stripTestSuffix(testPath)
	return base === null ? [] : withEachExtension(base)
}

/** `__tests__` mirror: `src/__tests__/foo.test.ts` → `src/foo.{ts,tsx,...}` */
function testsDirCandidates(testPath: string): string[] {
	const segmentIdx = testPath.indexOf(TESTS_DIR_SEGMENT)
	if (segmentIdx < 0) return []
	const parentDir = testPath.slice(0, segmentIdx)
	const filename = testPath.slice(segmentIdx + TESTS_DIR_SEGMENT.length)
	const base = stripTestSuffix(filename)
	if (base === null) return []
	return withEachExtension(`${parentDir}/${base}`)
}

/** `tests/` or `test/` mirror: `tests/services/foo.test.ts` → `src/services/foo.{ts,tsx,...}` */
function prefixedDirCandidates(testPath: string): string[] {
	for (const prefix of TEST_DIR_PREFIXES) {
		if (!testPath.startsWith(prefix)) continue
		const rest = testPath.slice(prefix.length)
		const base = stripTestSuffix(rest)
		if (base === null) return []
		return withEachExtension(`src/${base}`)
	}
	return []
}

/**
 * Compute candidate source paths for a test file in priority order: co-located
 * first, then `__tests__/` mirror, then `tests/`/`test/` mirror. Each mirror
 * emits one entry per `SOURCE_EXTENSIONS` candidate so the caller can match
 * against any of them.
 */
export function candidateSourcePaths(testPath: string): string[] {
	return [
		...colocatedCandidates(testPath),
		...testsDirCandidates(testPath),
		...prefixedDirCandidates(testPath),
	]
}

/**
 * Resolve the unambiguous target group for a single test file, or `null` when
 * no source counterpart exists / matches more than one group (ambiguous). A
 * test whose candidates span multiple groups (e.g. `foo.ts` and `foo.tsx` in
 * different groups) is intentionally left alone rather than guessed.
 */
function findTargetGroup(
	testFile: string,
	currentGi: number,
	fileToGroup: Map<string, number>,
): number | null {
	const targetGroups = new Set<number>()
	for (const candidate of candidateSourcePaths(testFile)) {
		const targetGi = fileToGroup.get(candidate)
		if (targetGi !== undefined && targetGi !== currentGi) {
			targetGroups.add(targetGi)
		}
	}
	return targetGroups.size === 1 ? [...targetGroups][0] : null
}

/**
 * Find the unambiguous target group for each misplaced test file.
 *
 * Returns a map of `testFile → targetGroupIndex`. A test is only moved when
 * its candidate source matches exactly one other group; ambiguous matches are
 * skipped (see {@link findTargetGroup}).
 */
function findMoves(groups: CommitGroup[], fileToGroup: Map<string, number>): Map<string, number> {
	const moves = new Map<string, number>()

	for (let gi = 0; gi < groups.length; gi++) {
		for (const file of groups[gi].files) {
			if (moves.has(file) || !TEST_FILE_PATTERN.test(file)) continue
			const target = findTargetGroup(file, gi, fileToGroup)
			if (target !== null) moves.set(file, target)
		}
	}

	return moves
}

/**
 * Apply queued moves to a fresh copy of the groups array. Tests are removed
 * from their original group and appended to the target group. Groups left
 * empty by moves are dropped.
 */
function applyMoves(groups: CommitGroup[], moves: Map<string, number>): CommitGroup[] {
	const result = groups.map((g) => ({ ...g, files: [...g.files] }))
	const movedFiles = new Set(moves.keys())

	const additionsByGroup = new Map<number, string[]>()
	for (const [file, toGroup] of moves) {
		const bucket = additionsByGroup.get(toGroup) ?? []
		bucket.push(file)
		additionsByGroup.set(toGroup, bucket)
	}

	for (let gi = 0; gi < result.length; gi++) {
		if (movedFiles.size > 0) {
			result[gi].files = result[gi].files.filter((f) => !movedFiles.has(f))
		}
		const additions = additionsByGroup.get(gi)
		if (!additions) continue
		const existing = new Set(result[gi].files)
		for (const file of additions) {
			// Additions come from other groups so they should always be new; the
			// de-dupe guard exists to keep the invariant explicit.
			if (!existing.has(file)) result[gi].files.push(file)
		}
	}

	return result.filter((g) => g.files.length > 0)
}

/**
 * Move test files (`.test.*` / `.spec.*`) into the group that already contains
 * their source counterpart. Returns the same array reference if no moves were
 * needed; otherwise returns a fresh array of new group objects.
 *
 * See module doc for the matching algorithm.
 */
export function reuniteTestsWithSources(groups: CommitGroup[]): CommitGroup[] {
	if (groups.length === 0) return groups

	const fileToGroup = new Map<string, number>()
	for (let gi = 0; gi < groups.length; gi++) {
		for (const file of groups[gi].files) fileToGroup.set(file, gi)
	}

	const moves = findMoves(groups, fileToGroup)
	if (moves.size === 0) return groups

	return applyMoves(groups, moves)
}
