import { beforeEach, describe, expect, it, vi } from "vitest";

const mockChatCreate = vi.fn();

vi.mock("./provider.js", () => ({
	createProvider: vi.fn(),
	PROVIDER_CONFIGS: {
		groq: { baseURL: "https://api.groq.com/openai/v1/", defaultModel: "openai/gpt-oss-20b" },
		cerebras: { baseURL: "https://api.cerebras.ai/v1/", defaultModel: "gpt-oss-120b" },
		mistral: { baseURL: "https://api.mistral.ai/v1/", defaultModel: "mistral-small" },
	},
	formatProviderName: vi.fn((name: string) => name.charAt(0).toUpperCase() + name.slice(1)),
}));

vi.mock("./ai.js", () => ({
	compressDiff: vi.fn((d: string) => d),
	buildStatSummary: vi.fn(
		() => "file.ts | +5 -2\n1 files changed, 5 insertions(+), 2 deletions(-)",
	),
	extractContentText: vi.fn((c: unknown) => (typeof c === "string" ? c : "")),
	deriveMessageFromReasoning: vi.fn(() => null),
	mapGroqError: vi.fn((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
}));

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}));

import {
	buildStatSummary,
	compressDiff,
	deriveMessageFromReasoning,
	extractContentText,
	mapGroqError,
} from "./ai.js";
import { createProvider } from "./provider.js";
import { generateCodeReview } from "./review-ai.js";

const mockedCreateProvider = vi.mocked(createProvider);
const mockedCompressDiff = vi.mocked(compressDiff);
const mockedBuildStatSummary = vi.mocked(buildStatSummary);
const mockedExtractContentText = vi.mocked(extractContentText);
const mockedDeriveMessageFromReasoning = vi.mocked(deriveMessageFromReasoning);
const mockedMapGroqError = vi.mocked(mapGroqError);

describe("generateCodeReview", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockedCreateProvider.mockReturnValue({
			client: { chat: { completions: { create: mockChatCreate } } },
			model: "openai/gpt-oss-20b",
		} as unknown as ReturnType<typeof createProvider>);
	});

	it("returns review content on happy path", async () => {
		mockChatCreate.mockResolvedValue({
			choices: [
				{
					message: {
						content: "- SEVERITY: critical\n- LOCATION: src/cli.ts:42\n- ISSUE: null pointer",
					},
					finish_reason: "stop",
				},
			],
		});

		const result = await generateCodeReview("some diff", ["src/cli.ts"], { apiKey: "test_key" });

		expect(result).toContain("SEVERITY: critical");
		expect(result).toContain("src/cli.ts:42");
		expect(mockChatCreate).toHaveBeenCalledTimes(1);
	});

	it("returns NO_ISSUES_FOUND when content is empty and no reasoning", async () => {
		mockChatCreate.mockResolvedValue({
			choices: [
				{
					message: { content: null, reasoning: null },
					finish_reason: "stop",
				},
			],
		});

		const result = await generateCodeReview("clean diff", ["src/clean.ts"], { apiKey: "test_key" });

		expect(result).toBe("NO_ISSUES_FOUND");
		expect(mockedExtractContentText).toHaveBeenCalled();
		expect(mockedDeriveMessageFromReasoning).not.toHaveBeenCalled();
	});

	it("falls back to reasoning when content is empty but reasoning is present", async () => {
		mockedDeriveMessageFromReasoning.mockReturnValue(
			"- SEVERITY: major\n- ISSUE: memory leak from reasoning",
		);

		mockChatCreate.mockResolvedValue({
			choices: [
				{
					message: {
						content: null,
						reasoning: "I analyzed and found a memory leak in the cache layer.",
					},
					finish_reason: "stop",
				},
			],
		});

		const result = await generateCodeReview("leaky diff", ["src/cache.ts"], { apiKey: "test_key" });

		expect(result).toContain("SEVERITY: major");
		expect(result).toContain("memory leak");
		expect(mockedDeriveMessageFromReasoning).toHaveBeenCalledWith(
			"I analyzed and found a memory leak in the cache layer.",
		);
	});

	it("returns NO_ISSUES_FOUND when reasoning fallback returns null", async () => {
		mockedDeriveMessageFromReasoning.mockReturnValue(null);

		mockChatCreate.mockResolvedValue({
			choices: [
				{
					message: { content: null, reasoning: "unparseable reasoning" },
					finish_reason: "stop",
				},
			],
		});

		const result = await generateCodeReview("some diff", ["src/file.ts"], { apiKey: "test_key" });

		expect(result).toBe("NO_ISSUES_FOUND");
		expect(mockedDeriveMessageFromReasoning).toHaveBeenCalled();
	});

	it("propagates API errors through mapGroqError", async () => {
		const apiError = new Error("API failure");
		mockChatCreate.mockRejectedValue(apiError);

		await expect(generateCodeReview("diff", ["file.ts"], { apiKey: "test_key" })).rejects.toThrow(
			"API failure",
		);

		expect(mockedMapGroqError).toHaveBeenCalledWith(apiError, undefined);
	});

	it("passes provider option through to createProvider", async () => {
		mockChatCreate.mockResolvedValue({
			choices: [{ message: { content: "all good" }, finish_reason: "stop" }],
		});

		await generateCodeReview("diff", ["file.ts"], { apiKey: "test_key", provider: "cerebras" });

		expect(mockedCreateProvider).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "cerebras" }),
		);
	});

	it("passes model override through to createProvider", async () => {
		mockChatCreate.mockResolvedValue({
			choices: [{ message: { content: "all good" }, finish_reason: "stop" }],
		});

		await generateCodeReview("diff", ["file.ts"], { apiKey: "test_key", model: "custom-model-v2" });

		expect(mockedCreateProvider).toHaveBeenCalledWith(
			expect.objectContaining({ modelOverride: "custom-model-v2" }),
		);
	});

	it("calls compressDiff and buildStatSummary with the diff", async () => {
		const diff =
			"diff --git a/src/cli.ts b/src/cli.ts\n--- a/src/cli.ts\n+++ b/src/cli.ts\n@@ -1,5 +1,10 @@\n+new line\n-old line\n";
		const files = ["src/cli.ts"];

		mockChatCreate.mockResolvedValue({
			choices: [
				{
					message: { content: "- SEVERITY: minor\n- ISSUE: nitpick" },
					finish_reason: "stop",
				},
			],
		});

		await generateCodeReview(diff, files, { apiKey: "test_key" });

		expect(mockedCompressDiff).toHaveBeenCalledWith(diff);
		expect(mockedBuildStatSummary).toHaveBeenCalledWith(diff);
	});

	it("uses default groq provider when none specified", async () => {
		mockChatCreate.mockResolvedValue({
			choices: [{ message: { content: "all clear" }, finish_reason: "stop" }],
		});

		await generateCodeReview("diff", ["file.ts"], { apiKey: "test_key" });

		expect(mockedCreateProvider).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "groq" }),
		);
	});

	it("passes apiKey and timeout through to createProvider", async () => {
		mockChatCreate.mockResolvedValue({
			choices: [{ message: { content: "done" }, finish_reason: "stop" }],
		});

		await generateCodeReview("diff", ["file.ts"], {
			apiKey: "gsk_secret",
			timeout: 30000,
		});

		expect(mockedCreateProvider).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: "gsk_secret",
				timeout: 30000,
			}),
		);
	});
});
