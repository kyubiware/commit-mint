import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitFlags } from "./auto-group.js";

// Mock all external dependencies
vi.mock("../services/git.js", () => ({
	assertGitRepo: vi.fn(),
	getStatusShort: vi.fn(),
	getChangedFiles: vi.fn(),
	stageFiles: vi.fn(),
	getStagedDiff: vi.fn(),
	attemptCommit: vi.fn(),
	getHead: vi.fn(),
	resetStaging: vi.fn(),
	getRepoRoot: vi.fn(),
	getDefaultExcludes: vi.fn(() => [
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
	]),
}));

vi.mock("../services/ai.js", () => ({
	generateCommitMessage: vi.fn(),
}));

vi.mock("../services/grouping.js", () => ({
	filterExcludedFiles: vi.fn(),
	generateGroups: vi.fn(),
	validateGroups: vi.fn(),
}));

vi.mock("../services/hooks.js", () => ({
	parseHookErrors: vi.fn(),
	parseCheckErrors: vi.fn(),
}));

vi.mock("../services/checks.js", () => ({
	detectConfig: vi.fn(),
	runAllChecks: vi.fn(),
}));

vi.mock("../services/config.js", () => ({
	readConfig: vi.fn(),
	getProviderApiKey: vi.fn(),
	getModelForProvider: vi.fn(),
}));

vi.mock("../services/provider.js", () => ({
	isValidProvider: vi.fn(),
	PROVIDER_CONFIGS: { groq: { defaultModel: "test-model" } },
	PROVIDER_ENV_KEYS: { groq: "GROQ_API_KEY" },
}));

vi.mock("../utils/cache.js", () => ({
	saveCachedCommit: vi.fn(),
}));

vi.mock("../utils/agent.js", () => ({
	EXIT_CODES: { SUCCESS: 0, GENERIC: 1, NO_CHANGES: 2, GIT: 3, AI: 4, CHECK: 5, HOOK: 6 },
	writeAgentResult: vi.fn(),
}));

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}));

import { generateCommitMessage } from "../services/ai.js";
import { detectConfig, runAllChecks } from "../services/checks.js";
import { getModelForProvider, getProviderApiKey, readConfig } from "../services/config.js";
import {
	assertGitRepo,
	attemptCommit,
	getChangedFiles,
	getHead,
	getRepoRoot,
	getStagedDiff,
	getStatusShort,
	resetStaging,
	stageFiles,
} from "../services/git.js";
import { filterExcludedFiles, generateGroups, validateGroups } from "../services/grouping.js";
import { parseCheckErrors, parseHookErrors } from "../services/hooks.js";
import { isValidProvider } from "../services/provider.js";
import { EXIT_CODES, writeAgentResult } from "../utils/agent.js";
import { saveCachedCommit } from "../utils/cache.js";
import { agentCommand } from "./agent.js";

describe("agentCommand", () => {
	let savedExitCode: string | number | undefined;

	beforeEach(() => {
		vi.resetAllMocks();
		savedExitCode = process.exitCode ?? undefined;
		process.exitCode = undefined;
	});

	afterEach(() => {
		process.exitCode = savedExitCode;
	});

	const defaultFlags = (overrides: Partial<CommitFlags> = {}): CommitFlags => ({
		retry: false,
		auto: false,
		agent: true,
		message: undefined,
		hint: undefined,
		noCheck: false,
		...overrides,
	});

	const makeChangedFiles = (paths: string[]) =>
		paths.map((p) => ({ status: "M" as const, path: p, staged: false }));

	// ---------------------------------------------------------------------------
	// 1. --retry rejection
	// ---------------------------------------------------------------------------
	it("--retry rejection: exits GENERIC with failure", async () => {
		const flags = defaultFlags({ retry: true });

		await agentCommand(flags);

		expect(process.exitCode).toBe(EXIT_CODES.GENERIC);
		expect(vi.mocked(writeAgentResult)).toHaveBeenCalledWith({
			status: "failure",
			commits: [],
			errors: ["--agent is not compatible with --retry"],
		});
	});

	// ---------------------------------------------------------------------------
	// 2. no-changes
	// ---------------------------------------------------------------------------
	it("no-changes: exits NO_CHANGES with empty status", async () => {
		vi.mocked(assertGitRepo).mockResolvedValue(undefined);
		vi.mocked(getStatusShort).mockResolvedValue("");

		await agentCommand(defaultFlags());

		expect(process.exitCode).toBe(EXIT_CODES.NO_CHANGES);
		expect(vi.mocked(writeAgentResult)).toHaveBeenCalledWith({
			status: "no_changes",
			commits: [],
		});
	});

	// ---------------------------------------------------------------------------
	// 3. git failure
	// ---------------------------------------------------------------------------
	it("git failure: exits GIT when assertGitRepo throws", async () => {
		vi.mocked(assertGitRepo).mockRejectedValue(new Error("not a git repo"));

		await agentCommand(defaultFlags());

		expect(process.exitCode).toBe(EXIT_CODES.GIT);
		expect(vi.mocked(writeAgentResult)).toHaveBeenCalledWith({
			status: "failure",
			commits: [],
			errors: ["not a git repo"],
		});
	});

	// ---------------------------------------------------------------------------
	// 4. excluded-only files
	// ---------------------------------------------------------------------------
	it("excluded-only files: hardcoded message commit", async () => {
		vi.mocked(assertGitRepo).mockResolvedValue(undefined);
		vi.mocked(getStatusShort).mockResolvedValue("M package-lock.json");
		vi.mocked(getChangedFiles).mockResolvedValue(makeChangedFiles(["package-lock.json"]));
		vi.mocked(stageFiles).mockResolvedValue(undefined);
		vi.mocked(getStagedDiff).mockResolvedValue({
			excludedFiles: ["package-lock.json"],
		});
		vi.mocked(getHead).mockResolvedValueOnce("hash-before").mockResolvedValueOnce("hash-after");
		vi.mocked(attemptCommit).mockResolvedValue({ ok: true, stderr: "" });

		await agentCommand(defaultFlags());

		expect(process.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(vi.mocked(writeAgentResult)).toHaveBeenCalledWith({
			status: "success",
			commits: [
				{
					message: "chore: update lockfile",
					hash: "hash-after",
					files: ["package-lock.json"],
				},
			],
		});
	});

	// ---------------------------------------------------------------------------
	// 5. --message mode
	// ---------------------------------------------------------------------------
	it("--message mode: single commit, no AI call", async () => {
		vi.mocked(assertGitRepo).mockResolvedValue(undefined);
		vi.mocked(getStatusShort).mockResolvedValue("M a.ts");
		vi.mocked(getChangedFiles).mockResolvedValue(makeChangedFiles(["src/a.ts"]));
		vi.mocked(stageFiles).mockResolvedValue(undefined);
		vi.mocked(getStagedDiff).mockResolvedValue({
			files: ["src/a.ts"],
			diff: "diff content",
		});
		vi.mocked(getHead).mockResolvedValueOnce("hash-before").mockResolvedValueOnce("hash-after");
		vi.mocked(attemptCommit).mockResolvedValue({ ok: true, stderr: "" });

		await agentCommand(defaultFlags({ message: "fix: bug" }));

		expect(process.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(vi.mocked(generateCommitMessage)).not.toHaveBeenCalled();
		expect(vi.mocked(writeAgentResult)).toHaveBeenCalledWith({
			status: "success",
			commits: [
				{
					message: "fix: bug",
					hash: "hash-after",
					files: ["src/a.ts"],
				},
			],
		});
	});

	// ---------------------------------------------------------------------------
	// 6. check failure
	// ---------------------------------------------------------------------------
	it("check failure: exits CHECK", async () => {
		vi.mocked(assertGitRepo).mockResolvedValue(undefined);
		vi.mocked(getStatusShort).mockResolvedValue("M a.ts\nM b.ts");
		vi.mocked(getChangedFiles).mockResolvedValue(makeChangedFiles(["src/a.ts", "src/b.ts"]));
		vi.mocked(stageFiles).mockResolvedValue(undefined);
		vi.mocked(getStagedDiff).mockResolvedValue({
			files: ["src/a.ts", "src/b.ts"],
			diff: "diff content",
		});
		vi.mocked(getRepoRoot).mockResolvedValue("/tmp/test-repo");
		vi.mocked(detectConfig).mockResolvedValue("/tmp/test-repo/.cmintrc");
		vi.mocked(runAllChecks).mockResolvedValue({
			ok: false,
			results: [
				{
					ok: false,
					tool: "biome",
					command: "biome check src/a.ts",
					stdout: "",
					stderr: "src/a.ts:1:1 lint error",
					files: ["src/a.ts"],
				},
			],
		});
		vi.mocked(parseCheckErrors).mockReturnValue([
			{ tool: "biome", message: "src/a.ts:1:1 lint error", raw: "raw" },
		]);

		await agentCommand(defaultFlags());

		expect(process.exitCode).toBe(EXIT_CODES.CHECK);
		expect(vi.mocked(writeAgentResult)).toHaveBeenCalledWith({
			status: "failure",
			commits: [],
			errors: ["[biome] src/a.ts:1:1 lint error"],
		});
	});

	// ---------------------------------------------------------------------------
	// 7. hook failure on single commit (--message mode)
	// ---------------------------------------------------------------------------
	it("hook failure on single commit: exits HOOK", async () => {
		vi.mocked(assertGitRepo).mockResolvedValue(undefined);
		vi.mocked(getStatusShort).mockResolvedValue("M a.ts");
		vi.mocked(getChangedFiles).mockResolvedValue(makeChangedFiles(["src/a.ts"]));
		vi.mocked(stageFiles).mockResolvedValue(undefined);
		vi.mocked(getStagedDiff).mockResolvedValue({
			files: ["src/a.ts"],
			diff: "diff content",
		});
		vi.mocked(getHead).mockResolvedValueOnce("hash-before").mockResolvedValueOnce("hash-before"); // same → hooks failed
		vi.mocked(attemptCommit).mockResolvedValue({
			ok: false,
			stderr: "pre-commit hook error output",
		});
		vi.mocked(parseHookErrors).mockReturnValue([
			{ tool: "biome", message: "hook failed", raw: "pre-commit hook error output" },
		]);

		await agentCommand(defaultFlags({ message: "fix: bug" }));

		expect(process.exitCode).toBe(EXIT_CODES.HOOK);
		expect(vi.mocked(writeAgentResult)).toHaveBeenCalledWith({
			status: "failure",
			commits: [],
			errors: ["[biome] hook failed"],
		});
	});

	// ---------------------------------------------------------------------------
	// 8. AI failure: generateGroups throws
	// ---------------------------------------------------------------------------
	it("AI failure: exits AI when generateGroups throws", async () => {
		vi.mocked(assertGitRepo).mockResolvedValue(undefined);
		vi.mocked(getStatusShort).mockResolvedValue("M a.ts");
		vi.mocked(getChangedFiles).mockResolvedValue(makeChangedFiles(["src/a.ts"]));
		vi.mocked(stageFiles).mockResolvedValue(undefined);
		vi.mocked(getStagedDiff).mockResolvedValue({
			files: ["src/a.ts"],
			diff: "diff content",
		});
		vi.mocked(getRepoRoot).mockResolvedValue("/tmp/test-repo");
		vi.mocked(detectConfig).mockResolvedValue(null); // skip checks
		vi.mocked(filterExcludedFiles).mockReturnValue({
			included: makeChangedFiles(["src/a.ts"]),
			excluded: [],
		});
		vi.mocked(readConfig).mockResolvedValue({
			provider: "groq",
			model: "test-model",
		});
		vi.mocked(isValidProvider).mockReturnValue(true);
		vi.mocked(getProviderApiKey).mockResolvedValue("gsk-test-key");
		vi.mocked(getModelForProvider).mockReturnValue("test-model");
		vi.mocked(generateGroups).mockRejectedValue(new Error("AI service unavailable"));
		vi.mocked(validateGroups).mockImplementation((groups) => groups);

		await agentCommand(defaultFlags());

		expect(process.exitCode).toBe(EXIT_CODES.AI);
		expect(vi.mocked(writeAgentResult)).toHaveBeenCalledWith({
			status: "failure",
			commits: [],
			errors: ["AI service unavailable"],
		});
	});

	// ---------------------------------------------------------------------------
	// 9. API key missing
	// ---------------------------------------------------------------------------
	it("API key missing: exits AI", async () => {
		vi.mocked(assertGitRepo).mockResolvedValue(undefined);
		vi.mocked(getStatusShort).mockResolvedValue("M a.ts");
		vi.mocked(getChangedFiles).mockResolvedValue(makeChangedFiles(["src/a.ts"]));
		vi.mocked(stageFiles).mockResolvedValue(undefined);
		vi.mocked(getStagedDiff).mockResolvedValue({
			files: ["src/a.ts"],
			diff: "diff content",
		});
		vi.mocked(getRepoRoot).mockResolvedValue("/tmp/test-repo");
		vi.mocked(detectConfig).mockResolvedValue(null); // skip checks
		vi.mocked(filterExcludedFiles).mockReturnValue({
			included: makeChangedFiles(["src/a.ts"]),
			excluded: [],
		});
		vi.mocked(readConfig).mockResolvedValue({
			provider: "groq",
			model: "test-model",
		});
		vi.mocked(isValidProvider).mockReturnValue(true);
		vi.mocked(getProviderApiKey).mockRejectedValue(new Error("missing key"));

		await agentCommand(defaultFlags());

		expect(process.exitCode).toBe(EXIT_CODES.AI);
		expect(vi.mocked(writeAgentResult)).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "failure",
				commits: [],
				errors: [expect.stringContaining("API key")],
			}),
		);
	});

	// ---------------------------------------------------------------------------
	// 10. --noCheck skips checks
	// ---------------------------------------------------------------------------
	it("--noCheck skips checks", async () => {
		vi.mocked(assertGitRepo).mockResolvedValue(undefined);
		vi.mocked(getStatusShort).mockResolvedValue("M a.ts");
		vi.mocked(getChangedFiles).mockResolvedValue(makeChangedFiles(["src/a.ts"]));
		vi.mocked(stageFiles).mockResolvedValue(undefined);
		vi.mocked(getStagedDiff).mockResolvedValue({
			files: ["src/a.ts"],
			diff: "diff content",
		});
		vi.mocked(filterExcludedFiles).mockReturnValue({
			included: [],
			excluded: [],
		});

		await agentCommand(defaultFlags({ noCheck: true }));

		expect(vi.mocked(detectConfig)).not.toHaveBeenCalled();
		expect(vi.mocked(runAllChecks)).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(vi.mocked(writeAgentResult)).toHaveBeenCalledWith({
			status: "success",
			commits: [],
		});
	});

	// ---------------------------------------------------------------------------
	// 11. auto-group success: multiple commits
	// ---------------------------------------------------------------------------
	it("auto-group success: multiple commits", async () => {
		const changed = makeChangedFiles(["src/a.ts", "src/b.ts"]);
		const groups = [
			{ name: "Feat A", description: "desc", files: ["src/a.ts"] },
			{ name: "Feat B", description: "desc", files: ["src/b.ts"] },
		];

		vi.mocked(assertGitRepo).mockResolvedValue(undefined);
		vi.mocked(getStatusShort).mockResolvedValue("M a.ts\nM b.ts");
		vi.mocked(getChangedFiles).mockResolvedValue(changed);
		vi.mocked(stageFiles).mockResolvedValue(undefined);
		vi.mocked(getStagedDiff).mockResolvedValue({
			files: ["src/a.ts", "src/b.ts"],
			diff: "full diff",
		});
		vi.mocked(getRepoRoot).mockResolvedValue("/tmp/test-repo");
		vi.mocked(detectConfig).mockResolvedValue(null); // skip checks
		vi.mocked(filterExcludedFiles).mockReturnValue({
			included: changed,
			excluded: [],
		});
		vi.mocked(readConfig).mockResolvedValue({
			provider: "groq",
			model: "test-model",
		});
		vi.mocked(isValidProvider).mockReturnValue(true);
		vi.mocked(getProviderApiKey).mockResolvedValue("gsk-test-key");
		vi.mocked(getModelForProvider).mockReturnValue("test-model");
		vi.mocked(generateGroups).mockResolvedValue({ groups, excluded: [] });
		vi.mocked(validateGroups).mockImplementation((g) => g);
		vi.mocked(generateCommitMessage)
			.mockResolvedValueOnce("feat: add feature A")
			.mockResolvedValueOnce("feat: add feature B");
		vi.mocked(saveCachedCommit).mockResolvedValue(undefined);
		vi.mocked(resetStaging).mockResolvedValue(undefined);
		vi.mocked(attemptCommit)
			.mockResolvedValueOnce({ ok: true, stderr: "" })
			.mockResolvedValueOnce({ ok: true, stderr: "" });
		vi.mocked(getHead)
			.mockResolvedValueOnce("before-A")
			.mockResolvedValueOnce("after-A")
			.mockResolvedValueOnce("before-B")
			.mockResolvedValueOnce("after-B");

		await agentCommand(defaultFlags());

		expect(process.exitCode).toBe(EXIT_CODES.SUCCESS);
		expect(vi.mocked(writeAgentResult)).toHaveBeenCalledWith({
			status: "success",
			commits: [
				{
					message: "feat: add feature A",
					hash: "after-A",
					files: ["src/a.ts"],
					groupName: "Feat A",
				},
				{
					message: "feat: add feature B",
					hash: "after-B",
					files: ["src/b.ts"],
					groupName: "Feat B",
				},
			],
		});
		expect(vi.mocked(generateCommitMessage)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(attemptCommit)).toHaveBeenCalledTimes(2);
	});

	// ---------------------------------------------------------------------------
	// 12. hook failure mid-sequence: partial commits returned
	// ---------------------------------------------------------------------------
	it("hook failure mid-sequence: partial commits returned", async () => {
		const changed = makeChangedFiles(["src/a.ts", "src/b.ts", "src/c.ts"]);
		const groups = [
			{ name: "Feat A", description: "desc", files: ["src/a.ts"] },
			{ name: "Feat B", description: "desc", files: ["src/b.ts"] },
			{ name: "Feat C", description: "desc", files: ["src/c.ts"] },
		];

		vi.mocked(assertGitRepo).mockResolvedValue(undefined);
		vi.mocked(getStatusShort).mockResolvedValue("M a.ts\nM b.ts\nM c.ts");
		vi.mocked(getChangedFiles).mockResolvedValue(changed);
		vi.mocked(stageFiles).mockResolvedValue(undefined);
		vi.mocked(getStagedDiff).mockResolvedValue({
			files: ["src/a.ts", "src/b.ts", "src/c.ts"],
			diff: "full diff",
		});
		vi.mocked(getRepoRoot).mockResolvedValue("/tmp/test-repo");
		vi.mocked(detectConfig).mockResolvedValue(null); // skip checks
		vi.mocked(filterExcludedFiles).mockReturnValue({
			included: changed,
			excluded: [],
		});
		vi.mocked(readConfig).mockResolvedValue({
			provider: "groq",
			model: "test-model",
		});
		vi.mocked(isValidProvider).mockReturnValue(true);
		vi.mocked(getProviderApiKey).mockResolvedValue("gsk-test-key");
		vi.mocked(getModelForProvider).mockReturnValue("test-model");
		vi.mocked(generateGroups).mockResolvedValue({ groups, excluded: [] });
		vi.mocked(validateGroups).mockImplementation((g) => g);
		vi.mocked(generateCommitMessage)
			.mockResolvedValueOnce("feat: add feature A")
			.mockResolvedValueOnce("feat: add feature B");
		// generateCommitMessage for group C is never reached
		vi.mocked(saveCachedCommit).mockResolvedValue(undefined);
		vi.mocked(resetStaging).mockResolvedValue(undefined);
		vi.mocked(attemptCommit)
			.mockResolvedValueOnce({ ok: true, stderr: "" })
			.mockResolvedValueOnce({ ok: false, stderr: "hook rejected" });
		// Group A: before/after differ → success
		// Group B: before === after → hook failure
		vi.mocked(getHead)
			.mockResolvedValueOnce("before-A")
			.mockResolvedValueOnce("after-A")
			.mockResolvedValueOnce("before-B")
			.mockResolvedValueOnce("before-B");
		vi.mocked(parseHookErrors).mockReturnValue([
			{ tool: "biome", message: "pre-commit rejected", raw: "hook rejected" },
		]);

		await agentCommand(defaultFlags());

		expect(process.exitCode).toBe(EXIT_CODES.HOOK);
		expect(vi.mocked(writeAgentResult)).toHaveBeenCalledWith({
			status: "failure",
			commits: [
				{
					message: "feat: add feature A",
					hash: "after-A",
					files: ["src/a.ts"],
					groupName: "Feat A",
				},
			],
			errors: ["[biome] pre-commit rejected"],
		});
	});
});
