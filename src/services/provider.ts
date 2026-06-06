import Groq from "groq-sdk";

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
		baseURL: "https://api.cerebras.ai",
		defaultModel: "gpt-oss-120b",
	},
	mistral: {
		baseURL: "https://api.mistral.ai",
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

export function createProvider(options: {
	provider: ProviderName;
	apiKey: string;
	modelOverride?: string;
	timeout?: number;
	baseURLOverride?: string;
}): { client: Groq; model: string } {
	if (!isValidProvider(options.provider)) {
		throw new Error(
			`Invalid provider "${options.provider}". Allowed values: ${ALLOWED_PROVIDERS.join(", ")}`,
		);
	}

	const providerConfig = PROVIDER_CONFIGS[options.provider];
	const model = options.modelOverride ?? providerConfig.defaultModel;
	const baseURL = options.baseURLOverride ?? providerConfig.baseURL;

	const client = new Groq({
		apiKey: options.apiKey,
		baseURL,
		timeout: options.timeout,
	});

	return { client, model };
}
