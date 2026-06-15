import { beforeEach, describe, expect, it, vi } from "vitest"

const mockCreate = vi.fn()
const { mockCreateProvider } = vi.hoisted(() => ({
	mockCreateProvider: vi.fn(),
}))

vi.mock("groq-sdk", () => {
	class MockAPIError extends Error {
		constructor(
			public status?: number,
			public error?: unknown,
			message?: string,
			public headers?: unknown,
		) {
			super(message)
		}
	}

	class MockAuthenticationError extends MockAPIError {
		constructor(status?: number, error?: unknown, message?: string, headers?: unknown) {
			super(status ?? 401, error ?? {}, message ?? "Unauthorized", headers ?? {})
		}
	}

	class MockRateLimitError extends MockAPIError {
		constructor(status?: number, error?: unknown, message?: string, headers?: unknown) {
			super(status ?? 429, error ?? {}, message ?? "Rate limited", headers ?? {})
		}
	}

	class MockAPIConnectionTimeoutError extends MockAPIError {
		constructor(status?: number, error?: unknown, message?: string, headers?: unknown) {
			super(status ?? 0, error ?? {}, message ?? "Connection timeout", headers ?? {})
		}
	}

	class MockGroq {
		chat = {
			completions: {
				create: mockCreate,
			},
		}

		static AuthenticationError = MockAuthenticationError
		static RateLimitError = MockRateLimitError
		static APIConnectionTimeoutError = MockAPIConnectionTimeoutError
		static APIError = MockAPIError
	}

	return {
		default: MockGroq,
	}
})

vi.mock("./provider.js", () => ({
	createProvider: mockCreateProvider,
	PROVIDER_CONFIGS: {
		groq: { baseURL: "https://api.groq.com/openai/v1/", defaultModel: "openai/gpt-oss-20b" },
		cerebras: { baseURL: "https://api.cerebras.ai/v1/", defaultModel: "gpt-oss-120b" },
		mistral: { baseURL: "https://api.mistral.ai/v1/", defaultModel: "mistral-small" },
	},
	formatProviderName: vi.fn((name: string) => name.charAt(0).toUpperCase() + name.slice(1)),
}))

import { generateCommitMessage } from "./ai.js"

describe("generateCommitMessage", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockCreateProvider.mockImplementation((options) => ({
			client: { chat: { completions: { create: mockCreate } } },
			model: options?.modelOverride ?? "openai/gpt-oss-20b",
		}))
	})

	it("returns valid conventional commit on happy path", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat(cli): add hint flag" } }],
		})

		const result = await generateCommitMessage("some diff", { apiKey: "test_key" })

		expect(result).toBe("feat(cli): add hint flag")
		expect(mockCreate).toHaveBeenCalledTimes(1)
	})

	it("sets max_tokens for non-reasoning models and leaves max_completion_tokens undefined", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})

		await generateCommitMessage("some diff", { apiKey: "test_key", model: "llama-3.3-70b" })

		const callArgs = mockCreate.mock.calls[0][0]
		expect(callArgs.max_tokens).toBeGreaterThanOrEqual(1024)
		expect(callArgs.max_completion_tokens).toBeUndefined()
	})

	it("injects hint into user prompt content", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})

		await generateCommitMessage("some diff", { apiKey: "test_key", hint: "refactor auth" })

		const userPrompt = mockCreate.mock.calls[0][0].messages[1].content
		expect(userPrompt).toContain("Context: refactor auth")
	})

	it("adds type constraint to system prompt when type is provided", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})

		await generateCommitMessage("some diff", { apiKey: "test_key", type: "feat" })

		const systemPrompt = mockCreate.mock.calls[0][0].messages[0].content
		expect(systemPrompt).toContain("MUST use type: feat")
	})

	it("does not force a type when type is undefined", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})

		await generateCommitMessage("some diff", { apiKey: "test_key" })

		const systemPrompt = mockCreate.mock.calls[0][0].messages[0].content
		expect(systemPrompt).not.toContain("MUST use type:")
	})

	it("does not force a type when type is empty string", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})

		await generateCommitMessage("some diff", { apiKey: "test_key", type: "" })

		const systemPrompt = mockCreate.mock.calls[0][0].messages[0].content
		expect(systemPrompt).not.toContain("MUST use type:")
	})

	it("passes full diff under 20K chars without truncation", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})

		const diff = "a".repeat(1000)
		await generateCommitMessage(diff, { apiKey: "test_key" })

		const userPrompt = mockCreate.mock.calls[0][0].messages[1].content
		expect(userPrompt).toContain(diff)
	})

	it("strips context lines when diff exceeds 20K chars", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})

		// Build a diff >20K with many context lines (start with space) and fewer changed lines
		// so that after stripping context, the remaining diff is <= 20K
		const contextLines = Array.from(
			{ length: 400 },
			(_, i) => ` unchanged context line ${i} ${"x".repeat(60)}`,
		)
		const changedLines = Array.from({ length: 50 }, (_, i) => `+added line ${i} ${"x".repeat(60)}`)
		const diff = `diff --git a/file b/file\nindex 123..456\n--- a/file\n+++ b/file\n@@ -1,5 +1,55 @@\n${contextLines.join("\n")}\n${changedLines.join("\n")}`

		await generateCommitMessage(diff, { apiKey: "test_key" })

		const userPrompt = mockCreate.mock.calls[0][0].messages[1].content
		expect(userPrompt).not.toContain(" unchanged context line 0")
		expect(userPrompt).not.toContain(" unchanged context line 399")
		expect(userPrompt).toContain("+added line 0")
		expect(userPrompt).toContain("+added line 49")
	})

	it("truncates hunks when diff still exceeds 20K after stripping context", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})

		// Create a diff >20K with no context lines (all + lines)
		const lines = Array.from({ length: 250 }, (_, i) => `+line ${i} ${"x".repeat(180)}`)
		const diff = `diff --git a/file1 b/file1\n${lines.join("\n")}\ndiff --git a/file2 b/file2\n${lines.join("\n")}`
		await generateCommitMessage(diff, { apiKey: "test_key" })

		const userPrompt = mockCreate.mock.calls[0][0].messages[1].content
		// After truncation, should be <= 21K (20K + prefix overhead)
		expect(userPrompt.length).toBeLessThanOrEqual(21000)
	})

	it("includes stat summary in user prompt", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})

		const diff =
			"diff --git a/src/services/ai.ts b/src/services/ai.ts\n" +
			"--- a/src/services/ai.ts\n" +
			"+++ b/src/services/ai.ts\n" +
			"@@ -1,5 +1,10 @@\n" +
			"+new line 1\n" +
			"+new line 2\n" +
			"-old line 1\n" +
			"diff --git a/src/cli.ts b/src/cli.ts\n" +
			"--- a/src/cli.ts\n" +
			"+++ b/src/cli.ts\n" +
			"@@ -1,2 +1,3 @@\n" +
			"+another new line\n"

		await generateCommitMessage(diff, { apiKey: "test_key" })

		const userPrompt = mockCreate.mock.calls[0][0].messages[1].content
		expect(userPrompt).toContain("Change summary:")
		expect(userPrompt).toContain("src/services/ai.ts")
		expect(userPrompt).toContain("src/cli.ts")
		expect(userPrompt).toContain("+2 -1")
		expect(userPrompt).toContain("+1 -0")
	})

	it("falls back to file summary for very large diffs", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})

		// Create a massive diff with many files and many changed lines per hunk
		// so that even after context stripping and hunk capping it still exceeds 20K
		const files: string[] = []
		for (let f = 0; f < 30; f++) {
			const lines = Array.from({ length: 50 }, (_, i) => `+line ${i} ${"x".repeat(400)}`)
			files.push(`diff --git a/file${f}.ts b/file${f}.ts\n@@ -1,5 +1,55 @@\n${lines.join("\n")}`)
		}
		const diff = files.join("\n")

		await generateCommitMessage(diff, { apiKey: "test_key" })

		const userPrompt = mockCreate.mock.calls[0][0].messages[1].content
		expect(userPrompt).toContain("Summary of changes:")
		expect(userPrompt).toContain("file0.ts | changed")
		expect(userPrompt).toContain("file29.ts | changed")
	})

	it("throws when API response content is empty string", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "" }, finish_reason: "stop" }],
		})

		await expect(generateCommitMessage("some diff", { apiKey: "test_key" })).rejects.toThrow(
			"AI returned an empty commit message",
		)
	})

	it("throws when API response content is null", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: null }, finish_reason: "stop" }],
		})

		await expect(generateCommitMessage("some diff", { apiKey: "test_key" })).rejects.toThrow(
			"AI returned an empty commit message",
		)
	})

	it("extracts text from array content format", async () => {
		mockCreate.mockResolvedValue({
			choices: [
				{
					message: { content: [{ type: "text", text: "feat: array content" }] },
					finish_reason: "stop",
				},
			],
		})

		const result = await generateCommitMessage("some diff", { apiKey: "test_key" })

		expect(result).toBe("feat: array content")
		expect(mockCreate).toHaveBeenCalledTimes(1)
	})

	it("throws when array content has no text parts", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: [] }, finish_reason: "stop" }],
		})

		await expect(generateCommitMessage("some diff", { apiKey: "test_key" })).rejects.toThrow(
			"AI returned an empty commit message",
		)
	})

	it("auto-retries once when AI returns non-conventional format and second call succeeds", async () => {
		mockCreate
			.mockResolvedValueOnce({
				choices: [{ message: { content: "not a conventional commit" } }],
			})
			.mockResolvedValueOnce({
				choices: [{ message: { content: "feat: valid commit" } }],
			})

		const result = await generateCommitMessage("some diff", { apiKey: "test_key" })

		expect(result).toBe("feat: valid commit")
		expect(mockCreate).toHaveBeenCalledTimes(2)
	})

	it("returns original message when auto-retry also fails", async () => {
		mockCreate
			.mockResolvedValueOnce({
				choices: [{ message: { content: "not valid" } }],
			})
			.mockResolvedValueOnce({
				choices: [{ message: { content: "still not valid" } }],
			})

		const result = await generateCommitMessage("some diff", { apiKey: "test_key" })

		expect(result).toBe("not valid")
		expect(mockCreate).toHaveBeenCalledTimes(2)
	})

	it("does not retry when AI returns correctly formatted conventional commit", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: valid commit" } }],
		})

		const result = await generateCommitMessage("some diff", { apiKey: "test_key" })

		expect(result).toBe("feat: valid commit")
		expect(mockCreate).toHaveBeenCalledTimes(1)
	})

	it("throws clear API key message on AuthenticationError", async () => {
		const { default: Groq } = await import("groq-sdk")
		mockCreate.mockRejectedValue(new Groq.AuthenticationError(401, {}, "Unauthorized", {}))

		await expect(generateCommitMessage("some diff", { apiKey: "test_key" })).rejects.toThrow(
			"Invalid API key for Groq",
		)
	})

	it("throws rate limit message on RateLimitError", async () => {
		const { default: Groq } = await import("groq-sdk")
		mockCreate.mockRejectedValue(new Groq.RateLimitError(429, {}, "Rate limited", {}))

		await expect(generateCommitMessage("some diff", { apiKey: "test_key" })).rejects.toThrow(
			"Rate limited by Groq",
		)
	})

	it("throws timeout message on APIConnectionTimeoutError", async () => {
		const { default: Groq } = await import("groq-sdk")
		mockCreate.mockRejectedValue(new Groq.APIConnectionTimeoutError({ message: "Timeout" }))

		await expect(generateCommitMessage("some diff", { apiKey: "test_key" })).rejects.toThrow(
			"Request timed out",
		)
	})

	it("throws API error message on generic APIError", async () => {
		const { default: Groq } = await import("groq-sdk")
		mockCreate.mockRejectedValue(new Groq.APIError(500, {}, "Server Error", {}))

		await expect(generateCommitMessage("some diff", { apiKey: "test_key" })).rejects.toThrow(
			"Groq API error: Server Error",
		)
	})

	it("throws unexpected error message on non-Groq error", async () => {
		mockCreate.mockRejectedValue(new Error("Something went wrong"))

		await expect(generateCommitMessage("some diff", { apiKey: "test_key" })).rejects.toThrow(
			"Unexpected error: Something went wrong",
		)
	})

	// ── Think tag stripping ──

	it("strips think tags from string content", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "<think>reasoning here</think>feat: real message" } }],
		})
		const result = await generateCommitMessage("some diff", { apiKey: "test_key" })
		expect(result).toBe("feat: real message")
	})

	it("strips think tags case-insensitively across multiple lines", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "<THINK>\nmultiline reasoning\n</THINK>feat: test" } }],
		})
		const result = await generateCommitMessage("some diff", { apiKey: "test_key" })
		expect(result).toBe("feat: test")
	})

	it("does not modify content without think tags", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: clean message" } }],
		})
		const result = await generateCommitMessage("some diff", { apiKey: "test_key" })
		expect(result).toBe("feat: clean message")
	})

	it("strips think tags from array content parts", async () => {
		mockCreate.mockResolvedValue({
			choices: [
				{
					message: {
						content: [
							{ type: "text", text: "<think>why?</think>" },
							{ type: "text", text: "feat: from array" },
						],
					},
				},
			],
		})
		const result = await generateCommitMessage("some diff", { apiKey: "test_key" })
		expect(result).toBe("feat: from array")
	})

	// ── Model-aware max_tokens vs max_completion_tokens ──

	it("uses max_completion_tokens for o-series reasoning models", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})
		await generateCommitMessage("some diff", { apiKey: "test_key", model: "o3-mini" })
		const callArgs = mockCreate.mock.calls[0][0]
		expect(callArgs.max_completion_tokens).toBeGreaterThanOrEqual(1024)
		expect(callArgs.max_tokens).toBeUndefined()
	})

	it("uses max_completion_tokens for gpt-oss models", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})
		await generateCommitMessage("some diff", { apiKey: "test_key", model: "openai/gpt-oss-20b" })
		const callArgs = mockCreate.mock.calls[0][0]
		expect(callArgs.max_completion_tokens).toBeGreaterThanOrEqual(1024)
		expect(callArgs.max_tokens).toBeUndefined()
	})

	it("uses max_completion_tokens for gpt-5 models", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})
		await generateCommitMessage("some diff", { apiKey: "test_key", model: "gpt-5-turbo" })
		const callArgs = mockCreate.mock.calls[0][0]
		expect(callArgs.max_completion_tokens).toBeGreaterThanOrEqual(1024)
		expect(callArgs.max_tokens).toBeUndefined()
	})

	it("includes reasoning_format parsed for Groq reasoning models", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})
		await generateCommitMessage("some diff", { apiKey: "test_key", provider: "groq" })
		const callArgs = mockCreate.mock.calls[0][0]
		expect(callArgs.reasoning_format).toBe("parsed")
	})

	it("omits reasoning_format for non-Groq providers", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})
		await generateCommitMessage("some diff", { apiKey: "test_key", provider: "mistral" })
		const callArgs = mockCreate.mock.calls[0][0]
		expect(callArgs.reasoning_format).toBeUndefined()
	})

	// ── Reasoning fallback ──

	it("extracts conventional commit from reasoning when content is empty", async () => {
		mockCreate.mockResolvedValue({
			choices: [
				{
					message: {
						content: "",
						reasoning: "Let me analyze... fix(auth): resolve token expiry issue",
					},
				},
			],
		})
		const result = await generateCommitMessage("some diff", { apiKey: "test_key" })
		expect(result).toBe("fix(auth): resolve token expiry issue")
	})

	it("falls back to first meaningful sentence from reasoning when no conventional commit", async () => {
		mockCreate.mockResolvedValue({
			choices: [
				{
					message: {
						content: null,
						reasoning:
							"I think the main change here is about adding dark mode support. Also there are some lint fixes.",
					},
				},
			],
		})
		const result = await generateCommitMessage("some diff", { apiKey: "test_key" })
		expect(result).toBe("I think the main change here is about adding dark mode support")
	})

	it("throws when both content and reasoning are empty", async () => {
		mockCreate.mockResolvedValue({
			choices: [
				{
					message: {
						content: "",
						reasoning: "",
					},
				},
			],
		})
		await expect(generateCommitMessage("some diff", { apiKey: "test_key" })).rejects.toThrow(
			"AI returned an empty commit message",
		)
	})

	it("strips think tags from reasoning-derived message", async () => {
		mockCreate.mockResolvedValue({
			choices: [
				{
					message: {
						content: null,
						reasoning: "<think>should I use feat or fix?</think> feat: add caching layer",
					},
				},
			],
		})
		const result = await generateCommitMessage("some diff", { apiKey: "test_key" })
		expect(result).toBe("feat: add caching layer")
	})

	// ── Provider factory support ──

	it("passes provider to createProvider", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})

		await generateCommitMessage("diff --git a/file b/file", {
			apiKey: "key",
			provider: "cerebras",
		})

		expect(mockCreateProvider).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "cerebras" }),
		)
	})

	it("defaults provider to groq", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})

		await generateCommitMessage("diff --git a/file b/file", {
			apiKey: "key",
		})

		expect(mockCreateProvider).toHaveBeenCalledWith(expect.objectContaining({ provider: "groq" }))
	})

	it("uses model from factory return value", async () => {
		mockCreate.mockResolvedValue({
			choices: [{ message: { content: "feat: test" } }],
		})

		mockCreateProvider.mockReturnValue({
			client: { chat: { completions: { create: mockCreate } } },
			model: "gpt-oss-120b",
		})

		await generateCommitMessage("diff --git a/file b/file", {
			apiKey: "key",
		})

		const callArgs = mockCreate.mock.calls[0][0]
		expect(callArgs.model).toBe("gpt-oss-120b")
	})
})
