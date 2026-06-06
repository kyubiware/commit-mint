import { beforeEach, describe, expect, it, vi } from "vitest";
import { commitCommand } from "./commit.js";

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
	select: vi.fn(() => "use"),
	multiselect: vi.fn(),
	note: vi.fn(),
	text: vi.fn(),
}));

vi.mock("../services/git.js", () => ({
	assertGitRepo: vi.fn(),
	getChangedFiles: vi.fn(),
	getStagedDiff: vi.fn(),
	stageAll: vi.fn(),
	stageFiles: vi.fn(),
	getHead: vi.fn(),
	attemptCommit: vi.fn(),
	attemptCommitNoVerify: vi.fn(),
	getStatusShort: vi.fn(),
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

vi.mock("../services/hooks.js", () => ({
	parseHookErrors: vi.fn(() => []),
	parseToolChecks: vi.fn(() => []),
}));

vi.mock("../services/lint-staged.js", () => ({
	hasLintStagedConfig: vi.fn(() => Promise.resolve(false)),
	runLintStaged: vi.fn(),
}));

vi.mock("../ui/menu.js", () => ({
	showRecoveryMenu: vi.fn(),
	showStagingMenu: vi.fn(),
}));

vi.mock("../utils/cache.js", () => ({
	saveCachedCommit: vi.fn(),
	loadCachedCommit: vi.fn(),
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

vi.mock("../services/ai.js", () => ({
	generateCommitMessage: vi.fn(),
}));

vi.mock("../services/hook-progress.js", () => ({
	createProgressHandler: vi.fn(() => vi.fn()),
}));

vi.mock("../services/clipboard.js", () => ({
	copyToClipboard: vi.fn(),
}));

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
	setDebug: vi.fn(),
	isDebug: vi.fn(() => false),
}));

import { text } from "@clack/prompts";
import { generateCommitMessage } from "../services/ai.js";
import { getProviderApiKey, readConfig, setConfigValue } from "../services/config.js";
import {
	attemptCommit,
	getChangedFiles,
	getHead,
	getRepoRoot,
	getStagedDiff,
	getStatusShort,
	stageAll,
	stageFiles,
} from "../services/git.js";
import { showStagingMenu } from "../ui/menu.js";
import { saveCachedCommit } from "../utils/cache.js";

describe("commitCommand", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("handles errors from generateMessage without unhandled rejection", async () => {
		vi.mocked(getStatusShort).mockResolvedValue("M  src/foo.ts");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ status: "M", path: "src/foo.ts", staged: true },
		]);
		vi.mocked(stageFiles).mockResolvedValue(undefined);
		vi.mocked(getStagedDiff).mockResolvedValue({
			files: ["src/foo.ts"],
			diff: "some diff",
		});
		vi.mocked(readConfig).mockResolvedValue({
			model: "openai/gpt-oss-20b",
			provider: "groq",
			locale: "en",
		});
		vi.mocked(getProviderApiKey).mockRejectedValue(
			new Error("Please set your Groq API key via `cmint config set GROQ_API_KEY=<your token>`"),
		);

		// Should NOT throw — errors should be caught and handled gracefully
		await expect(commitCommand({ retry: false, auto: false })).resolves.not.toThrow();
	});

	it("prompts for API key when missing, saves it, then continues", async () => {
		vi.mocked(getStatusShort).mockResolvedValue("M  src/foo.ts");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ status: "M", path: "src/foo.ts", staged: true },
		]);
		vi.mocked(stageFiles).mockResolvedValue(undefined);
		vi.mocked(getStagedDiff).mockResolvedValue({
			files: ["src/foo.ts"],
			diff: "some diff",
		});
		vi.mocked(readConfig).mockResolvedValue({
			model: "openai/gpt-oss-20b",
			provider: "groq",
			locale: "en",
		});

		// First call throws (no key), second call succeeds (after prompt+save)
		vi.mocked(getProviderApiKey)
			.mockRejectedValueOnce(new Error("No API key"))
			.mockResolvedValueOnce("gsk_test_key_123");

		// User enters key in prompt
		vi.mocked(text).mockResolvedValue("gsk_test_key_123");
		vi.mocked(attemptCommit).mockResolvedValue({ ok: true });
		vi.mocked(getHead).mockResolvedValueOnce("abc123").mockResolvedValueOnce("abc123");

		await commitCommand({ retry: false, auto: false });

		// Should have prompted for the key
		expect(text).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("API key") }),
		);

		// Should have saved the key to config
		expect(setConfigValue).toHaveBeenCalledWith("GROQ_API_KEY", "gsk_test_key_123");
	});

	it("calls generateCommitMessage with correct options from config and flags", async () => {
		vi.mocked(getStatusShort).mockResolvedValue("M  src/foo.ts");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ status: "M", path: "src/foo.ts", staged: true },
		]);
		vi.mocked(stageFiles).mockResolvedValue(undefined);
		vi.mocked(getStagedDiff).mockResolvedValue({
			files: ["src/foo.ts"],
			diff: "some diff content",
		});
		vi.mocked(getProviderApiKey).mockResolvedValue("gsk_test_key");
		vi.mocked(readConfig).mockResolvedValue({
			model: "openai/gpt-oss-20b",
			type: "feat",
			timeout: "30000",
			locale: "en",
		});
		vi.mocked(generateCommitMessage).mockResolvedValue("feat: test commit");
		vi.mocked(attemptCommit).mockResolvedValue({ ok: true });
		vi.mocked(getHead).mockResolvedValueOnce("abc123").mockResolvedValueOnce("def456");

		await commitCommand({ retry: false, auto: false, hint: "refactor auth" });

		expect(generateCommitMessage).toHaveBeenCalledWith("some diff content", {
			apiKey: "gsk_test_key",
			model: "openai/gpt-oss-20b",
			type: "feat",
			timeout: 30000,
			hint: "refactor auth",
			provider: "groq",
		});
	});

	it("catches and displays errors from generateCommitMessage gracefully", async () => {
		vi.mocked(getStatusShort).mockResolvedValue("M  src/foo.ts");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ status: "M", path: "src/foo.ts", staged: true },
		]);
		vi.mocked(stageFiles).mockResolvedValue(undefined);
		vi.mocked(getStagedDiff).mockResolvedValue({
			files: ["src/foo.ts"],
			diff: "some diff",
		});
		vi.mocked(getProviderApiKey).mockResolvedValue("gsk_test_key");
		vi.mocked(readConfig).mockResolvedValue({
			model: "openai/gpt-oss-20b",

			locale: "en",
		});
		vi.mocked(generateCommitMessage).mockRejectedValue(new Error("Groq API error: rate limit"));

		await expect(commitCommand({ retry: false, auto: false })).resolves.not.toThrow();

		const { outro } = await import("@clack/prompts");
		expect(vi.mocked(outro)).toHaveBeenCalledWith(expect.stringContaining("rate limit"));
	});

	it("uses hardcoded message when all staged files are excluded", async () => {
		vi.mocked(getStatusShort).mockResolvedValue("M  package-lock.json");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ status: "M", path: "package-lock.json", staged: true },
		]);
		vi.mocked(stageFiles).mockResolvedValue(undefined);
		vi.mocked(getStagedDiff).mockResolvedValue({
			excludedFiles: ["package-lock.json"],
		});
		vi.mocked(getRepoRoot).mockResolvedValue("/tmp/test-repo");
		vi.mocked(attemptCommit).mockResolvedValue({ ok: true });
		vi.mocked(getHead).mockResolvedValueOnce("abc123").mockResolvedValueOnce("def456");

		await commitCommand({ retry: false, auto: false });

		// Should NOT call AI — message is hardcoded
		expect(generateCommitMessage).not.toHaveBeenCalled();
		// Should commit with a lockfile-specific message
		expect(attemptCommit).toHaveBeenCalledWith("chore: update lockfile", [], expect.any(Function));
		// Should cache the message
		expect(saveCachedCommit).toHaveBeenCalledWith("/tmp/test-repo", "chore: update lockfile");
	});

	it("shows staging menu when multiple files changed and --auto is not set", async () => {
		vi.mocked(getStatusShort).mockResolvedValue("M  src/foo.ts\n?? src/bar.ts");
		vi.mocked(getChangedFiles).mockResolvedValue([
			{ status: "M", path: "src/foo.ts", staged: true },
			{ status: "??", path: "src/bar.ts", staged: false },
		]);
		// User selects "Stage all" in the menu
		vi.mocked(showStagingMenu).mockResolvedValue({
			files: ["src/foo.ts", "src/bar.ts"],
			all: true,
		});
		vi.mocked(stageAll).mockResolvedValue(undefined);
		vi.mocked(getStagedDiff).mockResolvedValue({
			files: ["src/foo.ts", "src/bar.ts"],
			diff: "some diff",
		});
		vi.mocked(getProviderApiKey).mockResolvedValue("gsk_test_key");
		vi.mocked(readConfig).mockResolvedValue({
			model: "openai/gpt-oss-20b",

			locale: "en",
		});
		vi.mocked(generateCommitMessage).mockResolvedValue("feat: test");
		vi.mocked(attemptCommit).mockResolvedValue({ ok: true });
		vi.mocked(getHead).mockResolvedValueOnce("abc123").mockResolvedValueOnce("def456");

		await commitCommand({ retry: false, auto: false });

		expect(showStagingMenu).toHaveBeenCalledWith(
			[
				{ status: "M", path: "src/foo.ts", staged: true },
				{ status: "??", path: "src/bar.ts", staged: false },
			],
			false,
		);
		expect(stageAll).toHaveBeenCalled();
	});
});
