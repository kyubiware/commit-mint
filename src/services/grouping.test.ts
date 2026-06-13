import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangedFile } from "./git.js";
import {
	buildGroupingSystemPrompt,
	filterExcludedFiles,
	generateGroups,
	isLowQualityGrouping,
	parseGroupingResponse,
	validateGroups,
} from "./grouping.js";

const mockCreateProvider = vi.hoisted(() => vi.fn());

vi.mock("./provider.js", () => ({
	createProvider: mockCreateProvider,
	PROVIDER_CONFIGS: {
		groq: { baseURL: "https://api.groq.com/openai/v1/", defaultModel: "openai/gpt-oss-20b" },
		cerebras: { baseURL: "https://api.cerebras.ai/v1/", defaultModel: "gpt-oss-120b" },
		mistral: { baseURL: "https://api.mistral.ai/v1/", defaultModel: "mistral-small" },
	},
	isValidProvider: vi.fn((name: string) => ["groq", "cerebras", "mistral"].includes(name)),
	formatProviderName: vi.fn((name: string) => name.charAt(0).toUpperCase() + name.slice(1)),
}));

vi.mock("./ai.js", () => ({
	mapGroqError: vi.fn((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
}));

beforeEach(() => {
	vi.clearAllMocks();
	const mockChatCreate = vi.fn();
	mockCreateProvider.mockReturnValue({
		client: { chat: { completions: { create: mockChatCreate } } },
		model: "openai/gpt-oss-20b",
	});
});

describe("filterExcludedFiles", () => {
	it("includes package-lock.json when package.json is present", () => {
		const files: ChangedFile[] = [
			{ status: "M", path: "package.json", staged: true },
			{ status: "M", path: "package-lock.json", staged: true },
			{ status: "M", path: "src/index.ts", staged: true },
		];

		const { included, excluded } = filterExcludedFiles(files);

		expect(included.map((f) => f.path)).toContain("package-lock.json");
		expect(included.map((f) => f.path)).toContain("package.json");
		expect(included.map((f) => f.path)).toContain("src/index.ts");
		expect(excluded).toEqual([]);
	});

	it("still excludes package-lock.json when no companion package.json exists", () => {
		const files: ChangedFile[] = [
			{ status: "M", path: "package-lock.json", staged: true },
			{ status: "M", path: "src/index.ts", staged: true },
		];

		const { included, excluded } = filterExcludedFiles(files);

		expect(included.map((f) => f.path)).not.toContain("package-lock.json");
		expect(excluded).toContain("package-lock.json");
	});

	it("still excludes unrelated lockfiles when no companion manifest exists", () => {
		const files: ChangedFile[] = [
			{ status: "M", path: "some-random.lock", staged: true },
			{ status: "M", path: "src/index.ts", staged: true },
		];

		const { included, excluded } = filterExcludedFiles(files);

		expect(included.map((f) => f.path)).not.toContain("some-random.lock");
		expect(excluded).toContain("some-random.lock");
	});

	it("still excludes node_modules and dist directories", () => {
		const files: ChangedFile[] = [
			{ status: "M", path: "node_modules/foo/index.js", staged: true },
			{ status: "M", path: "dist/bundle.js", staged: true },
			{ status: "M", path: "src/index.ts", staged: true },
		];

		const { included, excluded } = filterExcludedFiles(files);

		expect(included).toHaveLength(1);
		expect(included[0].path).toBe("src/index.ts");
		expect(excluded).toContain("node_modules/foo/index.js");
		expect(excluded).toContain("dist/bundle.js");
	});

	it("includes bun.lock when package.json is present", () => {
		const files: ChangedFile[] = [
			{ status: "M", path: "package.json", staged: true },
			{ status: "M", path: "bun.lock", staged: true },
			{ status: "M", path: "src/index.ts", staged: true },
		];

		const { included, excluded } = filterExcludedFiles(files);

		expect(included.map((f) => f.path)).toContain("bun.lock");
		expect(included.map((f) => f.path)).toContain("package.json");
		expect(excluded).toEqual([]);
	});

	it("includes bun.lockb when package.json is present", () => {
		const files: ChangedFile[] = [
			{ status: "M", path: "package.json", staged: true },
			{ status: "M", path: "bun.lockb", staged: true },
		];

		const { included, excluded } = filterExcludedFiles(files);

		expect(included.map((f) => f.path)).toContain("bun.lockb");
		expect(excluded).toEqual([]);
	});

	it("still excludes bun.lock when no companion package.json exists", () => {
		const files: ChangedFile[] = [
			{ status: "M", path: "bun.lock", staged: true },
			{ status: "M", path: "src/index.ts", staged: true },
		];

		const { included, excluded } = filterExcludedFiles(files);

		expect(included.map((f) => f.path)).not.toContain("bun.lock");
		expect(excluded).toContain("bun.lock");
	});

	it("excludes *.min.js and *.log files", () => {
		const files: ChangedFile[] = [
			{ status: "M", path: "vendor.min.js", staged: true },
			{ status: "M", path: "debug.log", staged: true },
			{ status: "M", path: "src/index.ts", staged: true },
		];

		const { included, excluded } = filterExcludedFiles(files);

		expect(included).toHaveLength(1);
		expect(excluded).toContain("vendor.min.js");
		expect(excluded).toContain("debug.log");
	});
});

describe("validateGroups", () => {
	it("filters out AI-hallucinated file paths that do not exist in changed files", () => {
		const allFiles: ChangedFile[] = [
			{ status: "M", path: "packages/youtube-helper/api/routes/flashcards.py", staged: true },
			{ status: "M", path: "packages/youtube-helper/models/review_hub.py", staged: true },
			{ status: "M", path: "src/a.ts", staged: true },
		];

		const groups = [
			{
				name: "Backend changes",
				description: "desc",
				files: [
					"packages/youtube-helper/api/routes/flashcards.py",
					"packages/youtube-hook/api/routes/flashcards_stats.py", // hallucinated typo
					"packages/youtube-helper/models/review_hub.py",
				],
			},
			{
				name: "Frontend",
				description: "desc",
				files: ["src/a.ts", "src/nonexistent.ts"], // one real, one hallucinated
			},
		];

		const result = validateGroups(groups, allFiles);

		// Hallucinated paths should be removed
		expect(result[0].files).toEqual([
			"packages/youtube-helper/api/routes/flashcards.py",
			"packages/youtube-helper/models/review_hub.py",
		]);
		expect(result[1].files).toEqual(["src/a.ts"]);

		// No "Other changes" group — all real files are accounted for
		expect(result).toHaveLength(2);
	});

	it("adds hallucinated files' real counterparts to 'Other changes' if not covered by any group", () => {
		const allFiles: ChangedFile[] = [
			{ status: "M", path: "src/real.ts", staged: true },
			{ status: "M", path: "src/also-real.ts", staged: true },
		];

		const groups = [
			{
				name: "Group 1",
				description: "desc",
				files: ["src/real.ts", "src/fake.ts"], // real + hallucinated
			},
		];

		const result = validateGroups(groups, allFiles);

		expect(result[0].files).toEqual(["src/real.ts"]);
		// also-real.ts not in any group → "Other changes"
		expect(result[1].name).toBe("Other changes");
		expect(result[1].files).toEqual(["src/also-real.ts"]);
	});

	it("removes entire group if all its files are hallucinated", () => {
		const allFiles: ChangedFile[] = [{ status: "M", path: "src/real.ts", staged: true }];

		const groups = [
			{
				name: "Phantom group",
				description: "all hallucinated",
				files: ["src/fake1.ts", "src/fake2.ts"],
			},
		];

		const result = validateGroups(groups, allFiles);

		// Only "Other changes" with the real file
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("Other changes");
		expect(result[0].files).toEqual(["src/real.ts"]);
	});
});

describe("parseGroupingResponse", () => {
	it("parses plain JSON array", () => {
		const content = JSON.stringify([
			{ name: "Backend", description: "API changes", files: ["src/api.ts"] },
		]);
		const groups = parseGroupingResponse(content);
		expect(groups).toHaveLength(1);
		expect(groups[0].name).toBe("Backend");
		expect(groups[0].files).toEqual(["src/api.ts"]);
	});

	it("extracts JSON from markdown code fences", () => {
		const content =
			"```json\n" +
			JSON.stringify([{ name: "Backend", description: "API changes", files: ["src/api.ts"] }]) +
			"\n```";
		const groups = parseGroupingResponse(content);
		expect(groups).toHaveLength(1);
		expect(groups[0].name).toBe("Backend");
	});

	it("extracts JSON when model adds explanation after the array", () => {
		const groups = JSON.stringify([
			{ name: "Backend", description: "API changes", files: ["src/api.ts"] },
			{ name: "Tests", description: "Test updates", files: ["src/api.test.ts"] },
		]);
		const content =
			groups +
			"\n\nI grouped these files by separating the backend API logic from the test suite. The API changes are all in one commit for atomicity.";
		const result = parseGroupingResponse(content);
		expect(result).toHaveLength(2);
		expect(result[0].name).toBe("Backend");
		expect(result[1].name).toBe("Tests");
	});

	it("extracts JSON when model adds text before the array", () => {
		const groups = JSON.stringify([
			{ name: "Backend", description: "API changes", files: ["src/api.ts"] },
		]);
		const content = "Here are the grouped files:\n\n" + groups;
		const result = parseGroupingResponse(content);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("Backend");
	});

	it("extracts JSON from think tags followed by JSON array", () => {
		const groups = JSON.stringify([
			{ name: "Backend", description: "API changes", files: ["src/api.ts"] },
		]);
		const content = "<think\nLet me analyze these files...\n</think\n\n" + groups;
		const result = parseGroupingResponse(content);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("Backend");
	});

	it("extracts JSON from fenced block with trailing explanation", () => {
		const groups = JSON.stringify([
			{ name: "Backend", description: "API changes", files: ["src/api.ts"] },
		]);
		const content = "```json\n" + groups + "\n```\n\nNote: I kept related files together.";
		const result = parseGroupingResponse(content);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("Backend");
	});

	it("skips items missing required fields", () => {
		const content = JSON.stringify([
			{ name: "Backend", description: "API changes", files: ["src/api.ts"] },
			{ name: "No files" },
			{ description: "No name", files: ["src/other.ts"] },
		]);
		const result = parseGroupingResponse(content);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("Backend");
	});

	it("throws when no JSON array found", () => {
		expect(() => parseGroupingResponse("No JSON here at all")).toThrow();
	});
});

describe("isLowQualityGrouping", () => {
	it("flags single group containing all files as low quality", () => {
		const allFiles: ChangedFile[] = Array.from({ length: 15 }, (_, i) => ({
			status: "M",
			path: `packages/web/src/pages/text-study/file${i}.ts`,
			staged: true,
		}));

		const groups = [
			{
				name: "Other changes",
				description: "Miscellaneous changes that did not fit into other groups",
				files: allFiles.map((f) => f.path),
			},
		];

		expect(isLowQualityGrouping(groups, allFiles)).toBe(true);
	});

	it("flags single named group containing all files as low quality", () => {
		const allFiles: ChangedFile[] = Array.from({ length: 15 }, (_, i) => ({
			status: "M",
			path: `src/module/file${i}.ts`,
			staged: true,
		}));

		const groups = [
			{
				name: "Feature refactor",
				description: "All changes related to the feature",
				files: allFiles.map((f) => f.path),
			},
		];

		expect(isLowQualityGrouping(groups, allFiles)).toBe(true);
	});

	it("does not flag multiple groups as low quality", () => {
		const allFiles: ChangedFile[] = Array.from({ length: 10 }, (_, i) => ({
			status: "M",
			path: `src/file${i}.ts`,
			staged: true,
		}));

		const groups = [
			{
				name: "Backend",
				description: "API changes",
				files: allFiles.slice(0, 7).map((f) => f.path),
			},
			{
				name: "Other changes",
				description: "Remaining",
				files: allFiles.slice(7).map((f) => f.path),
			},
		];

		expect(isLowQualityGrouping(groups, allFiles)).toBe(false);
	});

	it("does not flag small changesets (under 5 files) with single group", () => {
		const allFiles: ChangedFile[] = [
			{ status: "M", path: "src/a.ts", staged: true },
			{ status: "M", path: "src/b.ts", staged: true },
			{ status: "M", path: "src/c.ts", staged: true },
		];

		const groups = [
			{
				name: "Small change",
				description: "A focused change",
				files: allFiles.map((f) => f.path),
			},
		];

		expect(isLowQualityGrouping(groups, allFiles)).toBe(false);
	});

	it("does not flag empty groups", () => {
		expect(isLowQualityGrouping([], [])).toBe(false);
	});
});

describe("buildGroupingSystemPrompt", () => {
	it("includes a rule to separate documentation from code", () => {
		const prompt = buildGroupingSystemPrompt();
		expect(prompt).toContain("documentation");
		expect(prompt).toMatch(/separate.*doc/i);
	});

	it("includes rule to keep related files together", () => {
		const prompt = buildGroupingSystemPrompt();
		expect(prompt).toContain("Keep related files together");
	});
});

describe("generateGroups", () => {
	function makeFiles(count: number): ChangedFile[] {
		return Array.from({ length: count }, (_, i) => ({
			status: "M" as const,
			path: `src/module/file${i}.ts`,
			staged: true,
		}));
	}

	function makeAIResponse(groups: { name: string; files: string[] }[]) {
		return JSON.stringify(
			groups.map((g) => ({ name: g.name, description: `${g.name} changes`, files: g.files })),
		);
	}

	it("retries once with stricter prompt when first result is a single catch-all group", async () => {
		const files = makeFiles(10);
		const mockChatCreate = vi.fn();

		// First call: single group (low quality)
		mockChatCreate.mockResolvedValueOnce({
			choices: [
				{
					message: {
						content: makeAIResponse([{ name: "Other changes", files: files.map((f) => f.path) }]),
					},
				},
			],
		});
		// Second call (retry): two groups (good quality)
		const half = Math.floor(files.length / 2);
		mockChatCreate.mockResolvedValueOnce({
			choices: [
				{
					message: {
						content: makeAIResponse([
							{ name: "Core logic", files: files.slice(0, half).map((f) => f.path) },
							{ name: "Tests", files: files.slice(half).map((f) => f.path) },
						]),
					},
				},
			],
		});

		mockCreateProvider.mockReturnValue({
			client: { chat: { completions: { create: mockChatCreate } } },
			model: "test-model",
		});

		const result = await generateGroups(files, "test-key");

		// Should have retried
		expect(mockChatCreate).toHaveBeenCalledTimes(2);
		// Second call should use the retry prompt
		const secondCallSystem = mockChatCreate.mock.calls[1][0].messages[0].content;
		expect(secondCallSystem).toContain("PREVIOUS ATTEMPT FAILED");
		// Result should have 2 groups (from retry)
		expect(result.groups.length).toBeGreaterThanOrEqual(2);
	});

	it("does not retry when grouping result has multiple groups", async () => {
		const files = makeFiles(10);
		const mockChatCreate = vi.fn();
		const half = Math.floor(files.length / 2);

		mockChatCreate.mockResolvedValueOnce({
			choices: [
				{
					message: {
						content: makeAIResponse([
							{ name: "Backend", files: files.slice(0, half).map((f) => f.path) },
							{ name: "Frontend", files: files.slice(half).map((f) => f.path) },
						]),
					},
				},
			],
		});

		mockCreateProvider.mockReturnValue({
			client: { chat: { completions: { create: mockChatCreate } } },
			model: "test-model",
		});

		await generateGroups(files, "test-key");

		expect(mockChatCreate).toHaveBeenCalledTimes(1);
	});

	it("returns single-group result when retry also produces low quality", async () => {
		const files = makeFiles(10);
		const mockChatCreate = vi.fn();

		// Both calls return single group
		const singleGroup = makeAIResponse([
			{ name: "Other changes", files: files.map((f) => f.path) },
		]);
		mockChatCreate.mockResolvedValue({
			choices: [{ message: { content: singleGroup } }],
		});

		mockCreateProvider.mockReturnValue({
			client: { chat: { completions: { create: mockChatCreate } } },
			model: "test-model",
		});

		const result = await generateGroups(files, "test-key");

		// Should have retried once
		expect(mockChatCreate).toHaveBeenCalledTimes(2);
		// But still returns the result (no infinite retry)
		expect(result.groups).toHaveLength(1);
	});
});
