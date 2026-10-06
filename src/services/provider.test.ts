import type Groq from "groq-sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	ALLOWED_PROVIDERS,
	createProvider,
	fetchProviderModels,
	formatProviderName,
	isFreeModelId,
	isValidProvider,
	PROVIDER_CONFIGS,
	PROVIDER_ENV_KEYS,
	type ProviderName,
} from "./provider.js"

describe("isValidProvider", () => {
	it("returns true for valid providers", () => {
		expect(isValidProvider("groq")).toBe(true)
		expect(isValidProvider("cerebras")).toBe(true)
		expect(isValidProvider("mistral")).toBe(true)
		expect(isValidProvider("omniroute")).toBe(true)
		expect(isValidProvider("openrouter")).toBe(true)
		expect(isValidProvider("gemini")).toBe(true)
	})
	it("returns false for invalid providers", () => {
		expect(isValidProvider("openai")).toBe(false)
		expect(isValidProvider("")).toBe(false)
		expect(isValidProvider("Groq")).toBe(false)
	})
})

describe("createProvider", () => {
	it("creates client for each provider", () => {
		for (const provider of ALLOWED_PROVIDERS) {
			const result = createProvider({ provider, apiKey: "test-key" })
			expect(result.model).toBe(PROVIDER_CONFIGS[provider].defaultModel)
			expect(result.client).toBeDefined()
		}
	})
	it("throws for invalid provider", () => {
		expect(() => createProvider({ provider: "openai" as ProviderName, apiKey: "test" })).toThrow(
			'Invalid provider "openai"',
		)
	})
	it("uses modelOverride when provided", () => {
		const result = createProvider({
			provider: "groq",
			apiKey: "test",
			modelOverride: "custom-model",
		})
		expect(result.model).toBe("custom-model")
	})
	it("falls back to default model when modelOverride is undefined", () => {
		const result = createProvider({ provider: "cerebras", apiKey: "test" })
		expect(result.model).toBe(PROVIDER_CONFIGS.cerebras.defaultModel)
	})
})

describe("formatProviderName", () => {
	it("capitalizes first letter", () => {
		expect(formatProviderName("groq")).toBe("Groq")
		expect(formatProviderName("cerebras")).toBe("Cerebras")
		expect(formatProviderName("mistral")).toBe("Mistral")
	})
	it("handles already capitalized input", () => {
		expect(formatProviderName("Groq")).toBe("Groq")
	})
	it("uses the registry displayName override when present", () => {
		expect(formatProviderName("commandcode")).toBe("Command Code")
	})
	it("falls back to capitalized id for unknown providers", () => {
		expect(formatProviderName("openai")).toBe("Openai")
	})
})

describe("PROVIDER_ENV_KEYS", () => {
	it("has an entry for every allowed provider", () => {
		for (const provider of ALLOWED_PROVIDERS) {
			expect(PROVIDER_ENV_KEYS[provider]).toBeDefined()
			expect(PROVIDER_ENV_KEYS[provider]).toContain("_API_KEY")
		}
	})
})

describe("ALLOWED_PROVIDERS", () => {
	it("is derived from PROVIDER_CONFIGS", () => {
		expect(ALLOWED_PROVIDERS).toEqual(Object.keys(PROVIDER_CONFIGS) as ProviderName[])
	})
})

describe("PROVIDER_CONFIGS baseURL", () => {
	// The Groq SDK internally prefixes all paths with /openai/v1/
	// (e.g. chat completions calls POST /openai/v1/chat/completions).
	// If baseURL also includes /openai/v1/ the path doubles:
	//   https://api.groq.com/openai/v1/ + /openai/v1/chat/completions
	//   → https://api.groq.com/openai/v1/openai/v1/chat/completions  ← 404
	it("groq baseURL does not include the SDK's /openai/v1/ path prefix", () => {
		const groqBaseURL = PROVIDER_CONFIGS.groq.baseURL
		// Must NOT end with /openai/v1/ — SDK adds that internally
		expect(groqBaseURL).not.toContain("/openai/v1/")
		expect(groqBaseURL).toBe("https://api.groq.com")
	})
	it("non-groq providers do not duplicate path segments", () => {
		for (const provider of ALLOWED_PROVIDERS) {
			if (provider === "groq") continue
			const url = PROVIDER_CONFIGS[provider].baseURL
			// Should not contain /openai/v1/ (SDK adds it) and not end with /v1/ doubled
			expect(url.endsWith("/v1/v1/")).toBe(false)
		}
	})
})

describe("createProvider with proxy override", () => {
	it("uses proxy baseURL when provided instead of provider default", () => {
		const result = createProvider({
			provider: "groq",
			apiKey: "test",
			baseURLOverride: "https://custom-proxy.example.com",
		})
		expect(result.client).toBeDefined()
		// Verify the client was constructed with the override, not the default
		expect((result.client as Groq).baseURL).toBe("https://custom-proxy.example.com")
	})
	it("uses provider default baseURL when no override given", () => {
		const result = createProvider({ provider: "groq", apiKey: "test" })
		expect((result.client as Groq).baseURL).toBe(PROVIDER_CONFIGS.groq.baseURL)
	})
})

describe("omniroute provider", () => {
	it("defaults to the auto combo model on localhost:20128", () => {
		expect(PROVIDER_CONFIGS.omniroute.baseURL).toBe("http://localhost:20128/v1")
		expect(PROVIDER_CONFIGS.omniroute.defaultModel).toBe("auto/fast")
	})

	it("does not require an API key (keyless local gateway)", () => {
		expect(PROVIDER_CONFIGS.omniroute.requiresApiKey).toBe(false)
	})

	it("requires API keys for all other providers (explicit or by default)", () => {
		for (const provider of ALLOWED_PROVIDERS) {
			if (provider === "omniroute") continue
			expect(PROVIDER_CONFIGS[provider].requiresApiKey ?? true).toBe(true)
		}
	})

	it("routes through the fetch client, not the Groq SDK", () => {
		const result = createProvider({ provider: "omniroute", apiKey: "" })
		// Groq SDK instances expose a baseURL property; the plain fetch client does not
		expect((result.client as Groq).baseURL).toBeUndefined()
	})
})

describe("commandcode provider", () => {
	it("uses the CommandCode gateway URL with the deepseek flash default model", () => {
		expect(PROVIDER_CONFIGS.commandcode.baseURL).toBe("https://api.commandcode.ai/provider/v1")
		expect(PROVIDER_CONFIGS.commandcode.defaultModel).toBe("deepseek/deepseek-v4-flash")
	})

	it("exposes a live model list for selection", () => {
		expect(PROVIDER_CONFIGS.commandcode.supportsModelList).toBe(true)
	})

	it("is a valid provider mapped to the COMMANDCODE_API_KEY env var", () => {
		expect(isValidProvider("commandcode")).toBe(true)
		expect(PROVIDER_ENV_KEYS.commandcode).toBe("COMMANDCODE_API_KEY")
	})

	it("requires an API key (explicit or by default)", () => {
		expect(PROVIDER_CONFIGS.commandcode.requiresApiKey ?? true).toBe(true)
	})

	it("routes through the fetch client, not the Groq SDK", () => {
		const result = createProvider({ provider: "commandcode", apiKey: "" })
		// Groq SDK instances expose a baseURL property; the plain fetch client does not
		expect((result.client as Groq).baseURL).toBeUndefined()
	})
})

describe("openrouter provider", () => {
	it("uses the OpenRouter API URL with the stable free router as default", () => {
		expect(PROVIDER_CONFIGS.openrouter.baseURL).toBe("https://openrouter.ai/api/v1")
		expect(PROVIDER_CONFIGS.openrouter.defaultModel).toBe("openrouter/free")
	})

	it("exposes a live model list for selection", () => {
		expect(PROVIDER_CONFIGS.openrouter.supportsModelList).toBe(true)
	})

	it("is a valid provider mapped to the OPENROUTER_API_KEY env var", () => {
		expect(isValidProvider("openrouter")).toBe(true)
		expect(PROVIDER_ENV_KEYS.openrouter).toBe("OPENROUTER_API_KEY")
	})

	it("requires an API key (explicit or by default)", () => {
		expect(PROVIDER_CONFIGS.openrouter.requiresApiKey ?? true).toBe(true)
	})

	it("routes through the fetch client, not the Groq SDK", () => {
		const result = createProvider({ provider: "openrouter", apiKey: "" })
		// Groq SDK instances expose a baseURL property; the plain fetch client does not
		expect((result.client as Groq).baseURL).toBeUndefined()
	})
})

describe("gemini provider", () => {
	it("uses the Gemini OpenAI-compat URL with the flash-lite default model", () => {
		// No trailing slash — the fetch client string-concatenates /chat/completions.
		expect(PROVIDER_CONFIGS.gemini.baseURL).toBe(
			"https://generativelanguage.googleapis.com/v1beta/openai",
		)
		expect(PROVIDER_CONFIGS.gemini.defaultModel).toBe("gemini-3.5-flash-lite")
	})

	it("exposes a live model list for selection", () => {
		expect(PROVIDER_CONFIGS.gemini.supportsModelList).toBe(true)
	})

	it("is a valid provider mapped to the GEMINI_API_KEY env var", () => {
		expect(isValidProvider("gemini")).toBe(true)
		expect(PROVIDER_ENV_KEYS.gemini).toBe("GEMINI_API_KEY")
	})

	it("requires an API key (explicit or by default)", () => {
		expect(PROVIDER_CONFIGS.gemini.requiresApiKey ?? true).toBe(true)
	})

	it("routes through the fetch client, not the Groq SDK", () => {
		const result = createProvider({ provider: "gemini", apiKey: "" })
		// Groq SDK instances expose a baseURL property; the plain fetch client does not
		expect((result.client as Groq).baseURL).toBeUndefined()
	})

	it("hides non-chat models while keeping chat models selectable", () => {
		const exclude = PROVIDER_CONFIGS.gemini.modelListExclude
		expect(exclude?.test("gemini-embedding-001")).toBe(true)
		expect(exclude?.test("gemini-2.5-flash-preview-tts")).toBe(true)
		expect(exclude?.test("veo-3.0-generate-001")).toBe(true)
		expect(exclude?.test("gemini-3.8-flash")).toBe(false)
	})
})

describe("fetch client Authorization header", () => {
	const OK_RESPONSE = () =>
		new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	async function callOnce(apiKey: string): Promise<Record<string, unknown>[]> {
		const fetchMock = vi.fn().mockResolvedValue(OK_RESPONSE())
		vi.stubGlobal("fetch", fetchMock)
		const { client, model } = createProvider({ provider: "omniroute", apiKey })
		await client.chat.completions.create({
			model,
			messages: [{ role: "user", content: "hi" }],
		})
		return fetchMock.mock.calls[0] as unknown as Record<string, unknown>[]
	}

	it("posts to <baseURL>/chat/completions with Bearer auth when a key is set", async () => {
		const [url, init] = (await callOnce("tok-123")) as [string, { headers: Record<string, string> }]
		expect(url).toBe("http://localhost:20128/v1/chat/completions")
		expect(init.headers.Authorization).toBe("Bearer tok-123")
	})

	it("omits the Authorization header entirely when apiKey is empty (keyless)", async () => {
		const [, init] = (await callOnce("")) as [string, { headers: Record<string, string> }]
		expect("Authorization" in init.headers).toBe(false)
	})

	it("requests a non-streaming response (stream: false)", async () => {
		const fetchMock = vi.fn().mockResolvedValue(OK_RESPONSE())
		vi.stubGlobal("fetch", fetchMock)
		const { client, model } = createProvider({ provider: "omniroute", apiKey: "" })
		await client.chat.completions.create({
			model,
			messages: [{ role: "user", content: "hi" }],
		})
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
		expect(JSON.parse(init.body).stream).toBe(false)
	})

	it("normalizes reasoning_content to reasoning (gateway reasoning models)", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							finish_reason: "stop",
							message: { role: "assistant", content: "", reasoning_content: "chore: update deps" },
						},
					],
				}),
				{ status: 200 },
			),
		)
		vi.stubGlobal("fetch", fetchMock)
		const { client, model } = createProvider({ provider: "omniroute", apiKey: "" })
		const completion = await client.chat.completions.create({
			model,
			messages: [{ role: "user", content: "hi" }],
		})
		expect(completion.choices[0]?.message?.reasoning).toBe("chore: update deps")
	})

	it("converts raw AbortError into a clear timeout error", async () => {
		const fetchMock = vi.fn().mockImplementation(
			(_url: unknown, init: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => {
						reject(new DOMException("This operation was aborted", "AbortError"))
					})
				}),
		)
		vi.stubGlobal("fetch", fetchMock)
		const { client } = createProvider({ provider: "omniroute", apiKey: "", timeout: 50 })
		await expect(
			client.chat.completions.create({
				model: "auto/fast",
				messages: [{ role: "user", content: "hi" }],
			}),
		).rejects.toThrow("Request timed out after 50ms")
	})
})

describe("fetchProviderModels", () => {
	const MODELS_RESPONSE = () =>
		new Response(
			JSON.stringify({
				object: "list",
				data: [
					{
						id: "claude-sonnet-5",
						object: "model",
						name: "Claude Sonnet 5",
						context_length: 1000000,
					},
					{ id: "deepseek/deepseek-v4-flash" },
					{ id: 42, name: 7, context_length: "1M" },
					{ name: "no id" },
				],
			}),
			{ status: 200 },
		)

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("parses data[] into ProviderModelInfo entries, skipping entries without an id", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(MODELS_RESPONSE()))
		const models = await fetchProviderModels("commandcode")
		expect(models).toEqual([
			{ id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 1000000 },
			{ id: "deepseek/deepseek-v4-flash", name: undefined, contextLength: undefined },
			{ id: "42", name: undefined, contextLength: undefined },
		])
	})

	it("hits the provider's /models endpoint exactly", async () => {
		const fetchMock = vi.fn().mockResolvedValue(MODELS_RESPONSE())
		vi.stubGlobal("fetch", fetchMock)
		await fetchProviderModels("commandcode")
		const [url] = fetchMock.mock.calls[0] as unknown as [string]
		expect(url).toBe("https://api.commandcode.ai/provider/v1/models")
	})

	it("hits openrouter's /models endpoint exactly", async () => {
		const fetchMock = vi.fn().mockResolvedValue(MODELS_RESPONSE())
		vi.stubGlobal("fetch", fetchMock)
		await fetchProviderModels("openrouter")
		const [url] = fetchMock.mock.calls[0] as unknown as [string]
		expect(url).toBe("https://openrouter.ai/api/v1/models")
	})

	it("hits gemini's OpenAI-compat /models endpoint exactly", async () => {
		const fetchMock = vi.fn().mockResolvedValue(MODELS_RESPONSE())
		vi.stubGlobal("fetch", fetchMock)
		await fetchProviderModels("gemini")
		const [url] = fetchMock.mock.calls[0] as unknown as [string]
		expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/models")
	})

	it("sends Bearer auth when a key is provided", async () => {
		const fetchMock = vi.fn().mockResolvedValue(MODELS_RESPONSE())
		vi.stubGlobal("fetch", fetchMock)
		await fetchProviderModels("commandcode", "tok-123")
		const [, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			{ headers: Record<string, string> },
		]
		expect(init.headers.Authorization).toBe("Bearer tok-123")
	})

	it("omits the Authorization header entirely when apiKey is empty (keyless)", async () => {
		const fetchMock = vi.fn().mockResolvedValue(MODELS_RESPONSE())
		vi.stubGlobal("fetch", fetchMock)
		await fetchProviderModels("commandcode", "")
		const [, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			{ headers: Record<string, string> },
		]
		expect("Authorization" in init.headers).toBe(false)
	})

	it("rejects with the HTTP status on non-2xx responses", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })))
		await expect(fetchProviderModels("commandcode", "bad-key")).rejects.toThrow(
			"Failed to fetch models from commandcode (HTTP 401)",
		)
	})

	it("rejects on a malformed body without a data array", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [] }), { status: 200 })),
		)
		await expect(fetchProviderModels("commandcode")).rejects.toThrow(
			"Invalid model list response from commandcode",
		)
	})
})
describe("isFreeModelId", () => {
	it("matches the provider's free-model id suffixes", () => {
		expect(isFreeModelId("poolside/laguna-s-2.1-free")).toBe(true)
		expect(isFreeModelId("meituan/LongCat-2.0:free")).toBe(true)
	})
	it("is case-insensitive and end-anchored", () => {
		expect(isFreeModelId("vendor/Model-FREE")).toBe(true)
		expect(isFreeModelId("freebird/large")).toBe(false)
		expect(isFreeModelId("groq/openai/gpt-oss-20b")).toBe(false)
	})
	it("treats OpenRouter's free router id as free", () => {
		expect(isFreeModelId("openrouter/free")).toBe(true)
		expect(isFreeModelId("openrouter/auto")).toBe(false)
		expect(isFreeModelId("openrouter/free/extra")).toBe(false)
	})
})
