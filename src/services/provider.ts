import Groq from "groq-sdk";
import { debug } from "../utils/debug.js";

export type ProviderName = "groq" | "cerebras" | "mistral";

export interface ProviderConfig {
	baseURL: string;
	defaultModel: string;
}

export const PROVIDER_CONFIGS: Record<ProviderName, ProviderConfig> = {
	groq: {
		baseURL: "https://api.groq.com",
		defaultModel: "openai/gpt-oss-20b",
	},
	cerebras: {
		baseURL: "https://api.cerebras.ai/v1",
		defaultModel: "gpt-oss-120b",
	},
	mistral: {
		baseURL: "https://api.mistral.ai/v1",
		defaultModel: "mistral-small",
	},
};

export const ALLOWED_PROVIDERS = Object.keys(PROVIDER_CONFIGS) as ProviderName[];
export const DEFAULT_PROVIDER: ProviderName = "groq";

export const PROVIDER_ENV_KEYS: Record<ProviderName, string> = {
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	mistral: "MISTRAL_API_KEY",
};

export function formatProviderName(provider: string): string {
	return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function isValidProvider(name: string): name is ProviderName {
	return ALLOWED_PROVIDERS.includes(name as ProviderName);
}

/**
 * Generic OpenAI-compatible chat completions client using fetch.
 * Used for non-Groq providers where the Groq SDK's hardcoded `/openai/v1/` path
 * prefix doesn't match the provider's actual API path.
 */
function createFetchClient(baseURL: string, apiKey: string, timeout: number) {
	return {
		chat: {
			completions: {
				async create(params: {
					messages: Array<{
						role: string;
						content: string | Array<{ type: string; text?: string }>;
					}>;
					model: string;
					temperature?: number;
					max_tokens?: number;
					max_completion_tokens?: number;
					reasoning_format?: string;
				}) {
					const url = `${baseURL}/chat/completions`;
					debug("fetchClient: POST %s, model=%s", url, params.model);
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), timeout);

					try {
						const response = await fetch(url, {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								Authorization: `Bearer ${apiKey}`,
							},
							body: JSON.stringify(params),
							signal: controller.signal,
						});

						if (!response.ok) {
							const text = await response.text().catch(() => "");
							throw new Error(`${response.status} ${text}`);
						}

						return (await response.json()) as {
							choices: Array<{
								message?: {
									content?: string | Array<{ type: string; text?: string }>;
									reasoning?: string;
								};
								finish_reason?: string;
							}>;
						};
					} finally {
						clearTimeout(timer);
					}
				},
			},
		},
	};
}

export type ChatClient = Pick<Groq, "chat">;

export function createProvider(options: {
	provider: ProviderName;
	apiKey: string;
	modelOverride?: string;
	timeout?: number;
	baseURLOverride?: string;
}): { client: ChatClient; model: string } {
	if (!isValidProvider(options.provider)) {
		throw new Error(
			`Invalid provider "${options.provider}". Allowed values: ${ALLOWED_PROVIDERS.join(", ")}`,
		);
	}

	const providerConfig = PROVIDER_CONFIGS[options.provider];
	const model = options.modelOverride ?? providerConfig.defaultModel;
	const baseURL = options.baseURLOverride ?? providerConfig.baseURL;
	const timeout = options.timeout ?? 60000;

	let client: ChatClient;
	if (options.provider === "groq") {
		client = new Groq({
			apiKey: options.apiKey,
			baseURL,
			timeout,
		});
	} else {
		client = createFetchClient(baseURL, options.apiKey, timeout) as unknown as ChatClient;
	}

	return { client, model };
}
