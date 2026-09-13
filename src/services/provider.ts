import Groq from "groq-sdk"
import { debug } from "../utils/debug.js"

export type ProviderName =
	| "groq"
	| "cerebras"
	| "mistral"
	| "commandcode"
	| "omniroute"
	| "openrouter"
	| "gemini"

export interface ProviderConfig {
	baseURL: string
	defaultModel: string
	/**
	 * When false, the provider works without an API key (e.g. local gateways).
	 * Defaults to true — only keyless providers set this explicitly.
	 */
	requiresApiKey?: boolean
	/**
	 * When true, the provider exposes GET {baseURL}/models for live model selection.
	 */
	supportsModelList?: boolean
	/**
	 * Ids matching this RegExp are hidden from the live model picker (requires
	 * supportsModelList). Providers list models the /chat/completions endpoint
	 * can't serve — non-chat entries (embeddings, TTS, image) or models only
	 * served on a different API format.
	 */
	modelListExclude?: RegExp
	/**
	 * Human-readable name shown in prompts and menus. Falls back to the
	 * capitalized provider id when unset.
	 */
	displayName?: string
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
	commandcode: {
		baseURL: "https://api.commandcode.ai/provider/v1",
		defaultModel: "deepseek/deepseek-v4-flash",
		supportsModelList: true,
		displayName: "Command Code",
		// claude-* ids are Anthropic-format on /v1/messages; /chat/completions
		// returns HTTP 400 for them.
		modelListExclude: /^claude/,
	},
	omniroute: {
		baseURL: "http://localhost:20128/v1",
		defaultModel: "auto/fast",
		requiresApiKey: false,
	},
	openrouter: {
		baseURL: "https://openrouter.ai/api/v1",
		// Stable virtual router pooling all currently active free models —
		// individual `:free` ids rotate off; the router slug does not.
		defaultModel: "openrouter/free",
		supportsModelList: true,
		displayName: "OpenRouter",
	},
	gemini: {
		// No trailing slash — createFetchClient() string-concatenates
		// `${baseURL}/chat/completions`.
		baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
		defaultModel: "gemini-3.8-flash",
		supportsModelList: true,
		displayName: "Gemini",
		// The list also contains embeddings, TTS, image, video (veo/imagen)
		// models that /chat/completions can't serve.
		modelListExclude: /embedding|image|tts|veo|imagen|nano-banana|audio/i,
	},
}

export const ALLOWED_PROVIDERS = Object.keys(PROVIDER_CONFIGS) as ProviderName[]
export const DEFAULT_PROVIDER: ProviderName = "groq"

export const PROVIDER_ENV_KEYS: Record<ProviderName, string> = {
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	mistral: "MISTRAL_API_KEY",
	commandcode: "COMMANDCODE_API_KEY",
	omniroute: "OMNIROUTE_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	gemini: "GEMINI_API_KEY",
}

export function formatProviderName(provider: string): string {
	const displayName = PROVIDER_CONFIGS[provider as ProviderName]?.displayName
	if (displayName) return displayName
	return provider.charAt(0).toUpperCase() + provider.slice(1)
}

export function isValidProvider(name: string): name is ProviderName {
	return ALLOWED_PROVIDERS.includes(name as ProviderName)
}

/**
 * Generic OpenAI-compatible chat completions client using fetch.
 * Used for non-Groq providers where the Groq SDK's hardcoded `/openai/v1/` path
 * prefix doesn't match the provider's actual API path.
 */
interface CompletionChoice {
	message?: {
		content?: string | Array<{ type: string; text?: string }>
		reasoning?: string
		reasoning_content?: string
	}
	finish_reason?: string
}

/**
 * Parse a chat-completions JSON response and normalize gateway quirks:
 * non-2xx → thrown Error, DeepSeek-style `reasoning_content` → OpenAI-style
 * `reasoning` so downstream fallbacks see one field name.
 */
async function readCompletion(response: Response): Promise<{ choices: CompletionChoice[] }> {
	if (!response.ok) {
		const text = await response.text().catch(() => "")
		throw new Error(`${response.status} ${text}`)
	}
	const data = (await response.json()) as { choices: CompletionChoice[] }
	for (const choice of data.choices ?? []) {
		if (!choice.message?.reasoning && choice.message?.reasoning_content) {
			choice.message.reasoning = choice.message.reasoning_content
		}
	}
	return data
}

function createFetchClient(baseURL: string, apiKey: string, timeout: number) {
	return {
		chat: {
			completions: {
				async create(params: {
					messages: Array<{
						role: string
						content: string | Array<{ type: string; text?: string }>
					}>
					model: string
					temperature?: number
					max_tokens?: number
					max_completion_tokens?: number
					reasoning_format?: string
				}) {
					const url = `${baseURL}/chat/completions`
					debug("fetchClient: POST %s, model=%s", url, params.model)
					const controller = new AbortController()
					const timer = setTimeout(() => controller.abort(), timeout)

					try {
						const response = await fetch(url, {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								// Keyless providers (requiresApiKey: false) may have no key —
								// omit the header entirely instead of sending a malformed
								// `Authorization: Bearer ` value.
								...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
							},
							// Some gateways (e.g. OmniRoute) default to streaming SSE when
							// the `stream` field is absent — request JSON explicitly.
							body: JSON.stringify({ ...params, stream: false }),
							signal: controller.signal,
						})
						return await readCompletion(response)
					} catch (error) {
						if (error instanceof Error && error.name === "AbortError") {
							throw new Error(`Request timed out after ${timeout}ms`)
						}
						throw error
					} finally {
						clearTimeout(timer)
					}
				},
			},
		},
	}
}

export type ChatClient = Pick<Groq, "chat">

export function createProvider(options: {
	provider: ProviderName
	apiKey: string
	modelOverride?: string
	timeout?: number
	baseURLOverride?: string
}): { client: ChatClient; model: string } {
	if (!isValidProvider(options.provider)) {
		throw new Error(
			`Invalid provider "${options.provider}". Allowed values: ${ALLOWED_PROVIDERS.join(", ")}`,
		)
	}

	const providerConfig = PROVIDER_CONFIGS[options.provider]
	const model = options.modelOverride ?? providerConfig.defaultModel
	const baseURL = options.baseURLOverride ?? providerConfig.baseURL
	const timeout = options.timeout ?? 60000

	let client: ChatClient
	if (options.provider === "groq") {
		client = new Groq({
			apiKey: options.apiKey,
			baseURL,
			timeout,
		})
	} else {
		client = createFetchClient(baseURL, options.apiKey, timeout) as unknown as ChatClient
	}

	return { client, model }
}

export interface ProviderModelInfo {
	id: string
	name?: string
	contextLength?: number
}

/**
 * Fetch a provider's live model list via GET {baseURL}/models (standard OpenAI
 * list shape). Sends `Authorization: Bearer <key>` only when a key is
 * provided; throws on non-2xx responses and malformed payloads. Server order
 * is preserved (curated, flagship models first).
 */
export async function fetchProviderModels(
	provider: ProviderName,
	apiKey = "",
	timeoutMs = 15000,
): Promise<ProviderModelInfo[]> {
	const url = `${PROVIDER_CONFIGS[provider].baseURL}/models`
	const response = await fetch(url, {
		headers: {
			// Keyless usage: omit the header entirely instead of sending a
			// malformed `Authorization: Bearer ` value.
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
		},
		signal: AbortSignal.timeout(timeoutMs),
	})
	if (!response.ok) {
		throw new Error(`Failed to fetch models from ${provider} (HTTP ${response.status})`)
	}
	const json = (await response.json()) as {
		data?: Array<{ id?: unknown; name?: unknown; context_length?: unknown }>
	}
	if (!Array.isArray(json.data)) {
		throw new Error(`Invalid model list response from ${provider}: expected { data: [...] }`)
	}
	const models: ProviderModelInfo[] = []
	for (const entry of json.data) {
		if (entry.id === undefined || entry.id === null) continue
		models.push({
			id: String(entry.id),
			name: typeof entry.name === "string" ? entry.name : undefined,
			contextLength: typeof entry.context_length === "number" ? entry.context_length : undefined,
		})
	}
	return models
}
/**
 * Free models are flagged in the id by the provider's own convention — a
 * `-free` / `:free` suffix (e.g. `poolside/laguna-s-2.1-free`,
 * `meituan/LongCat-2.0:free`), matching the models CommandCode's pricing docs
 * list as free. OpenRouter's `openrouter/free` router id counts as free by
 * exact match.
 */
export function isFreeModelId(id: string): boolean {
	return id === "openrouter/free" || /[:-]free$/i.test(id)
}
