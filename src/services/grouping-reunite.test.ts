import { describe, expect, it } from "vitest"
import type { CommitGroup } from "./grouping-parser.js"
import { candidateSourcePaths, reuniteTestsWithSources } from "./grouping-reunite.js"

// Lightweight helper type for test-only fixtures (avoids repeating the field
// triple on every inline group literal).
type CommitGroupLike = { name: string; description: string; files: string[] }

const asGroups = (groups: CommitGroupLike[]): CommitGroup[] => groups

describe("reuniteTestsWithSources", () => {
	it("returns the same array reference when no moves are needed", () => {
		const groups = asGroups([
			{
				name: "Feature",
				description: "desc",
				files: ["src/foo.ts", "src/foo.test.ts"],
			},
		])
		// Referential equality signals "nothing changed" — used by validateGroups
		// to skip debug logging on the happy path.
		expect(reuniteTestsWithSources(groups)).toBe(groups)
	})

	it("returns the same array reference when there are no groups", () => {
		const groups: CommitGroup[] = []
		expect(reuniteTestsWithSources(groups)).toBe(groups)
	})

	it("moves a co-located test into the source's group", () => {
		const result = reuniteTestsWithSources(
			asGroups([
				{ name: "Impl", description: "d", files: ["src/foo.ts"] },
				{ name: "Tests", description: "d", files: ["src/foo.test.ts"] },
			]),
		)

		expect(result).toHaveLength(1)
		expect(result[0].files).toEqual(["src/foo.ts", "src/foo.test.ts"])
	})

	it("handles .spec suffix in addition to .test", () => {
		const result = reuniteTestsWithSources(
			asGroups([
				{ name: "Impl", description: "d", files: ["src/foo.ts"] },
				{ name: "Tests", description: "d", files: ["src/foo.spec.ts"] },
			]),
		)

		expect(result).toHaveLength(1)
		expect(result[0].files).toEqual(["src/foo.ts", "src/foo.spec.ts"])
	})

	it("moves __tests__ mirror into the source's group", () => {
		const result = reuniteTestsWithSources(
			asGroups([
				{ name: "Impl", description: "d", files: ["src/services/git.ts"] },
				{
					name: "Tests",
					description: "d",
					files: ["src/services/__tests__/git.test.ts"],
				},
			]),
		)

		expect(result).toHaveLength(1)
		expect(result[0].files).toEqual(["src/services/git.ts", "src/services/__tests__/git.test.ts"])
	})

	it("moves tests/ mirror into the source's group (preserving subpath)", () => {
		const result = reuniteTestsWithSources(
			asGroups([
				{ name: "Impl", description: "d", files: ["src/services/git.ts"] },
				{ name: "Tests", description: "d", files: ["tests/services/git.test.ts"] },
			]),
		)

		expect(result).toHaveLength(1)
		expect(result[0].files).toEqual(["src/services/git.ts", "tests/services/git.test.ts"])
	})

	it("moves test/ (singular) mirror into the source's group", () => {
		const result = reuniteTestsWithSources(
			asGroups([
				{ name: "Impl", description: "d", files: ["src/foo.ts"] },
				{ name: "Tests", description: "d", files: ["test/foo.test.ts"] },
			]),
		)

		expect(result).toHaveLength(1)
		expect(result[0].files).toEqual(["src/foo.ts", "test/foo.test.ts"])
	})

	it("moves multiple test files for the same source (spec + test conventions)", () => {
		// Two test files for the same source — e.g., a project migrating from
		// `.spec` to `.test` may have both temporarily. Both should follow the
		// source. (.integration.test.ts is intentionally NOT covered here: that
		// pattern is treated as a test for `foo.integration.ts`, not `foo.ts`.)
		const result = reuniteTestsWithSources(
			asGroups([
				{ name: "Impl", description: "d", files: ["src/foo.ts"] },
				{
					name: "Tests",
					description: "d",
					files: ["src/foo.test.ts", "src/foo.spec.ts"],
				},
			]),
		)

		expect(result).toHaveLength(1)
		expect(result[0].files).toEqual(["src/foo.ts", "src/foo.test.ts", "src/foo.spec.ts"])
	})

	it("leaves a test in place when no source counterpart exists in any group", () => {
		// A test with no matching source is the "real" change — keep the AI's
		// grouping instead of guessing.
		const groups = asGroups([
			{ name: "New tests", description: "d", files: ["src/brand-new.test.ts"] },
			{ name: "Unrelated", description: "d", files: ["src/other.ts"] },
		])

		const result = reuniteTestsWithSources(groups)

		expect(result).toBe(groups)
	})

	it("does not move when source counterpart exists in multiple groups (ambiguous)", () => {
		// Two source files share a basename (different extensions). We can't
		// tell which one the test belongs to, so leave the test where it is.
		const groups = asGroups([
			{ name: "A", description: "d", files: ["src/foo.ts"] },
			{ name: "B", description: "d", files: ["src/foo.tsx"] },
			{ name: "Tests", description: "d", files: ["src/foo.test.ts"] },
		])

		const result = reuniteTestsWithSources(groups)

		expect(result).toBe(groups)
	})

	it("does not move a test already in the same group as its source", () => {
		const groups = asGroups([
			{
				name: "All together",
				description: "d",
				files: ["src/foo.ts", "src/foo.test.ts"],
			},
			{ name: "Other", description: "d", files: ["src/bar.ts"] },
		])

		const result = reuniteTestsWithSources(groups)

		expect(result).toBe(groups)
	})

	it("drops a group left empty after its test is moved out", () => {
		const result = reuniteTestsWithSources(
			asGroups([
				{ name: "Impl", description: "d", files: ["src/foo.ts"] },
				{ name: "Tests", description: "d", files: ["src/foo.test.ts"] },
				{ name: "Docs", description: "d", files: ["README.md"] },
			]),
		)

		expect(result).toHaveLength(2)
		expect(result.map((g) => g.name).sort()).toEqual(["Docs", "Impl"])
	})

	it("moves several test/source pairs across different groups in one pass", () => {
		const result = reuniteTestsWithSources(
			asGroups([
				{ name: "Feature A impl", description: "d", files: ["src/a.ts"] },
				{ name: "Feature B impl", description: "d", files: ["src/b.ts"] },
				{
					name: "All tests",
					description: "d",
					files: ["src/a.test.ts", "src/b.test.ts"],
				},
			]),
		)

		// Two impl groups gain their tests; the bucket group is dropped.
		expect(result).toHaveLength(2)
		const a = result.find((g) => g.name === "Feature A impl")
		const b = result.find((g) => g.name === "Feature B impl")
		expect(a?.files).toEqual(["src/a.ts", "src/a.test.ts"])
		expect(b?.files).toEqual(["src/b.ts", "src/b.test.ts"])
	})

	it("preserves source group name and description when a test joins", () => {
		const result = reuniteTestsWithSources(
			asGroups([
				{
					name: "Original impl name",
					description: "Original impl description",
					files: ["src/foo.ts"],
				},
				{ name: "Test bucket", description: "tests", files: ["src/foo.test.ts"] },
			]),
		)

		expect(result).toHaveLength(1)
		expect(result[0].name).toBe("Original impl name")
		expect(result[0].description).toBe("Original impl description")
	})
})

describe("candidateSourcePaths", () => {
	it("returns co-located candidates first", () => {
		const candidates = candidateSourcePaths("src/services/git.test.ts")
		// First candidate is the same-extension co-located source.
		expect(candidates[0]).toBe("src/services/git.ts")
		// Other same-dir alternates follow.
		expect(candidates).toContain("src/services/git.tsx")
		expect(candidates).toContain("src/services/git.js")
	})

	it("returns __tests__ mirror candidates", () => {
		const candidates = candidateSourcePaths("src/services/__tests__/git.test.ts")
		expect(candidates).toContain("src/services/git.ts")
	})

	it("returns tests/ prefix mirror candidates under src/", () => {
		const candidates = candidateSourcePaths("tests/services/git.test.ts")
		expect(candidates).toContain("src/services/git.ts")
	})

	it("returns test/ (singular) prefix mirror candidates under src/", () => {
		const candidates = candidateSourcePaths("test/foo.test.ts")
		// Co-located candidates come first (test/foo.ts), then the prefix-mirror
		// candidate that walks out of `test/` into `src/`.
		expect(candidates).toContain("test/foo.ts")
		expect(candidates).toContain("src/foo.ts")
	})

	it("handles .spec suffix", () => {
		const candidates = candidateSourcePaths("src/foo.spec.tsx")
		expect(candidates[0]).toBe("src/foo.ts")
		expect(candidates).toContain("src/foo.tsx")
	})

	it("returns empty array for a non-test file", () => {
		// No test suffix to strip — nothing to look up.
		expect(candidateSourcePaths("src/foo.ts")).toEqual([])
	})

	it("returns empty array for a test file that does not parse", () => {
		// Pathological input: ends with the marker but doesn't match the
		// expected shape. Should return [] rather than throwing.
		expect(candidateSourcePaths(".test.ts")).toEqual([])
	})
})
