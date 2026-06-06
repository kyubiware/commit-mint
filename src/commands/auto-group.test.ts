import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CommitFlags, runAutoGroupFlow } from "./auto-group.js";

// Mock all external dependencies
vi.mock("@clack/prompts", () => ({
	intro: vi.fn(),
	outro: vi.fn(),
	log: { info: vi.fn(), warn: vi.fn() },
	spinner: vi.fn(() => ({
		start: vi.fn(),
		stop: vi.fn(),
	})),
	isCancel: vi.fn(() => false),
	select: vi.fn(),
	multiselect: vi.fn(),
	note: vi.fn(),
	text: vi.fn(),
}));

vi.mock("../services/ai.js", () => ({
	generateCommitMessage: vi.fn(),
}));

vi.mock("../services/config.js", () => ({
	getApiKey: vi.fn(),
	readConfig: vi.fn(),
	setConfigValue: vi.fn(),
	getProviderApiKey: vi.fn(),
	getModelForProvider: vi.fn().mockReturnValue("openai/gpt-oss-20b"),
}));

vi.mock("../services/provider.js", () => ({
	isValidProvider: vi.fn(
		(name: string) => name === "groq" || name === "cerebras" || name === "mistral",
	),
	PROVIDER_CONFIGS: {
		groq: { baseURL: "https://api.groq.com/openai/v1/", defaultModel: "openai/gpt-oss-20b" },
		cerebras: { baseURL: "https://api.cerebras.ai/v1/", defaultModel: "gpt-oss-120b" },
		mistral: { baseURL: "https://api.mistral.ai/v1/", defaultModel: "mistral-small" },
	},
	PROVIDER_ENV_KEYS: {
		groq: "GROQ_API_KEY",
		cerebras: "CEREBRAS_API_KEY",
		mistral: "MISTRAL_API_KEY",
	},
	formatProviderName: vi.fn((name: string) => name.charAt(0).toUpperCase() + name.slice(1)),
}));

vi.mock("../services/git.js", () => ({
	attemptCommit: vi.fn(),
	attemptCommitNoVerify: vi.fn(),
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
	getHead: vi.fn(),
	getStagedDiff: vi.fn(),
	resetStaging: vi.fn(),
	stageFiles: vi.fn(),
	getRepoRoot: vi.fn(),
}));

vi.mock("../services/hooks.js", () => ({
	parseHookErrors: vi.fn(() => []),
	parseToolChecks: vi.fn(() => []),
}));

vi.mock("../services/grouping.js", () => ({
	filterExcludedFiles: vi.fn(),
	generateGroups: vi.fn(),
	validateGroups: vi.fn((groups) => groups),
}));

vi.mock("../ui/grouping.js", () => ({
	showGroupingConfirmation: vi.fn(),
	showGroupProgress: vi.fn(),
}));

vi.mock("../ui/menu.js", () => ({
	showRecoveryMenu: vi.fn(),
}));

vi.mock("../ui/review-message.js", () => ({
	reviewCommitMessage: vi.fn(),
}));

vi.mock("../utils/cache.js", () => ({
	saveCachedCommit: vi.fn(),
}));

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}));

import { outro } from "@clack/prompts";
import { generateCommitMessage } from "../services/ai.js";
import { getProviderApiKey, readConfig } from "../services/config.js";
import type { ChangedFile } from "../services/git.js";
import { attemptCommit, getHead, getRepoRoot, getStagedDiff, stageFiles } from "../services/git.js";
import { filterExcludedFiles, generateGroups } from "../services/grouping.js";
import { parseHookErrors, parseToolChecks } from "../services/hooks.js";
import { showGroupingConfirmation } from "../ui/grouping.js";
import { showRecoveryMenu } from "../ui/menu.js";
import { reviewCommitMessage } from "../ui/review-message.js";

describe("runAutoGroupFlow loop control", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	const changedFiles: ChangedFile[] = [
		{ status: "M", path: "src/a.ts", staged: true },
		{ status: "M", path: "src/b.ts", staged: true },
	];

	const flags: CommitFlags = { retry: false, auto: false };

	const twoGroups = [
		{ name: "Group 1", description: "desc", files: ["src/a.ts"] },
		{ name: "Group 2", description: "desc", files: ["src/b.ts"] },
	];

	const oneGroup = [{ name: "Group 1", description: "desc", files: ["src/a.ts"] }];

	function setupCommonMocks(groups = twoGroups) {
		vi.mocked(filterExcludedFiles).mockReturnValue({
			included: changedFiles,
			excluded: [],
		});
		vi.mocked(generateGroups).mockResolvedValue({
			groups: groups as { name: string; description: string; files: string[] }[],
			excluded: [],
		});
		vi.mocked(showGroupingConfirmation).mockResolvedValue(true);
		vi.mocked(getProviderApiKey).mockResolvedValue("gsk_test_key");
		vi.mocked(readConfig).mockResolvedValue({
			model: "openai/gpt-oss-20b",
			locale: "en",
		});
		vi.mocked(generateCommitMessage).mockResolvedValue("feat: test message");
		vi.mocked(getStagedDiff).mockResolvedValue({ files: ["src/a.ts"], diff: "diff" });
		vi.mocked(getHead).mockResolvedValue("abc123");
		vi.mocked(getRepoRoot).mockResolvedValue("/tmp/test-repo");
		vi.mocked(reviewCommitMessage).mockImplementation(async (msg) => msg);
		vi.mocked(parseHookErrors).mockReturnValue([{ tool: "biome", message: "error", raw: "raw" }]);
		vi.mocked(parseToolChecks).mockReturnValue([]);
	}

	it("recovery success → continues to next group", async () => {
		setupCommonMocks();
		vi.mocked(attemptCommit)
			.mockResolvedValueOnce({ ok: false })
			.mockResolvedValueOnce({ ok: true })
			.mockResolvedValueOnce({ ok: true });

		vi.mocked(showRecoveryMenu).mockImplementation(async (_errors, onRetry) => {
			await onRetry();
			return "committed";
		});

		await runAutoGroupFlow(changedFiles, flags);

		expect(stageFiles).toHaveBeenCalledWith(["src/a.ts"]);
		expect(stageFiles).toHaveBeenCalledWith(["src/b.ts"]);
		expect(attemptCommit).toHaveBeenCalledTimes(3);
	});

	it("recovery failure → stops loop", async () => {
		setupCommonMocks();
		vi.mocked(attemptCommit).mockResolvedValueOnce({ ok: false });
		vi.mocked(showRecoveryMenu).mockResolvedValue("failed");

		await runAutoGroupFlow(changedFiles, flags);

		expect(attemptCommit).toHaveBeenCalledTimes(1);
		expect(stageFiles).toHaveBeenCalledTimes(1);
	});

	it("recovery cancelled → stops loop", async () => {
		setupCommonMocks();
		vi.mocked(attemptCommit).mockResolvedValueOnce({ ok: false });
		vi.mocked(showRecoveryMenu).mockResolvedValue("cancelled");

		await runAutoGroupFlow(changedFiles, flags);

		expect(attemptCommit).toHaveBeenCalledTimes(1);
		expect(stageFiles).toHaveBeenCalledTimes(1);
		expect(outro).not.toHaveBeenCalledWith(expect.stringContaining("All groups committed."));
	});

	it("last group recovery success → loop ends naturally", async () => {
		setupCommonMocks(oneGroup);
		vi.mocked(attemptCommit).mockResolvedValueOnce({ ok: false });
		vi.mocked(showRecoveryMenu).mockResolvedValue("committed");

		await runAutoGroupFlow([{ status: "M", path: "src/a.ts", staged: true }], flags);

		expect(attemptCommit).toHaveBeenCalledTimes(1);
		expect(outro).not.toHaveBeenCalledWith(expect.stringContaining("All groups committed."));
	});
});
