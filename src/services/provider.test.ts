import { describe, expect, it } from "vitest";
import {
	ALLOWED_PROVIDERS,
	createProvider,
	formatProviderName,
	isValidProvider,
	PROVIDER_CONFIGS,
	PROVIDER_ENV_KEYS,
	type ProviderName,
} from "./provider.js";

describe("isValidProvider", () => {
	it("returns true for valid providers", () => {
		expect(isValidProvider("groq")).toBe(true);
		expect(isValidProvider("cerebras")).toBe(true);
		expect(isValidProvider("mistral")).toBe(true);
	});
	it("returns false for invalid providers", () => {
		expect(isValidProvider("openai")).toBe(false);
		expect(isValidProvider("")).toBe(false);
		expect(isValidProvider("Groq")).toBe(false);
	});
});

describe("createProvider", () => {
	it("creates client for each provider", () => {
		for (const provider of ALLOWED_PROVIDERS) {
			const result = createProvider({ provider, apiKey: "test-key" });
			expect(result.model).toBe(PROVIDER_CONFIGS[provider].defaultModel);
			expect(result.client).toBeDefined();
		}
	});
	it("throws for invalid provider", () => {
		expect(() => createProvider({ provider: "openai" as ProviderName, apiKey: "test" })).toThrow(
			'Invalid provider "openai"',
		);
	});
	it("uses modelOverride when provided", () => {
		const result = createProvider({
			provider: "groq",
			apiKey: "test",
			modelOverride: "custom-model",
		});
		expect(result.model).toBe("custom-model");
	});
	it("falls back to default model when modelOverride is undefined", () => {
		const result = createProvider({ provider: "cerebras", apiKey: "test" });
		expect(result.model).toBe(PROVIDER_CONFIGS.cerebras.defaultModel);
	});
});

describe("formatProviderName", () => {
	it("capitalizes first letter", () => {
		expect(formatProviderName("groq")).toBe("Groq");
		expect(formatProviderName("cerebras")).toBe("Cerebras");
		expect(formatProviderName("mistral")).toBe("Mistral");
	});
	it("handles already capitalized input", () => {
		expect(formatProviderName("Groq")).toBe("Groq");
	});
});

describe("PROVIDER_ENV_KEYS", () => {
	it("has an entry for every allowed provider", () => {
		for (const provider of ALLOWED_PROVIDERS) {
			expect(PROVIDER_ENV_KEYS[provider]).toBeDefined();
			expect(PROVIDER_ENV_KEYS[provider]).toContain("_API_KEY");
		}
	});
});

describe("ALLOWED_PROVIDERS", () => {
	it("is derived from PROVIDER_CONFIGS", () => {
		expect(ALLOWED_PROVIDERS).toEqual(Object.keys(PROVIDER_CONFIGS) as ProviderName[]);
	});
});

describe("PROVIDER_CONFIGS baseURL", () => {
	// The Groq SDK internally prefixes all paths with /openai/v1/
	// (e.g. chat completions calls POST /openai/v1/chat/completions).
	// If baseURL also includes /openai/v1/ the path doubles:
	//   https://api.groq.com/openai/v1/ + /openai/v1/chat/completions
	//   → https://api.groq.com/openai/v1/openai/v1/chat/completions  ← 404
	it("groq baseURL does not include the SDK's /openai/v1/ path prefix", () => {
		const groqBaseURL = PROVIDER_CONFIGS.groq.baseURL;
		// Must NOT end with /openai/v1/ — SDK adds that internally
		expect(groqBaseURL).not.toContain("/openai/v1/");
		expect(groqBaseURL).toBe("https://api.groq.com");
	});
	it("non-groq providers do not duplicate path segments", () => {
		for (const provider of ALLOWED_PROVIDERS) {
			if (provider === "groq") continue;
			const url = PROVIDER_CONFIGS[provider].baseURL;
			// Should not contain /openai/v1/ (SDK adds it) and not end with /v1/ doubled
			expect(url.endsWith("/v1/v1/")).toBe(false);
		}
	});
});

describe("createProvider with proxy override", () => {
	it("uses proxy baseURL when provided instead of provider default", () => {
		const result = createProvider({
			provider: "groq",
			apiKey: "test",
			baseURLOverride: "https://custom-proxy.example.com",
		});
		expect(result.client).toBeDefined();
		// Verify the client was constructed with the override, not the default
		expect(result.client.baseURL).toBe("https://custom-proxy.example.com");
	});
	it("uses provider default baseURL when no override given", () => {
		const result = createProvider({ provider: "groq", apiKey: "test" });
		expect(result.client.baseURL).toBe(PROVIDER_CONFIGS.groq.baseURL);
	});
});
