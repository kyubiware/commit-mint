import { readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import ini from "ini"
import { debug } from "../utils/debug.js"
import {
	formatProviderName,
	PROVIDER_CONFIGS,
	PROVIDER_ENV_KEYS,
	type ProviderName,
} from "./provider.js"

const CONFIG_PATH = join(os.homedir(), ".commit-mint")

export interface Config {
	GROQ_API_KEY?: string
	CEREBRAS_API_KEY?: string
	MISTRAL_API_KEY?: string
	OMNIROUTE_API_KEY?: string
	provider?: string
	model?: string
	model_groq?: string
	model_cerebras?: string
	model_mistral?: string
	model_omniroute?: string
	locale?: string
	"max-length"?: string
	type?: string
	proxy?: string
	timeout?: string
	"auto-accept"?: string
	"run-checks"?: string
}

const defaults: Config = {
	provider: "groq",
	model: "openai/gpt-oss-20b",
	locale: "en",
	"max-length": "100",
	type: "",
	timeout: "10000",
}

export async function readConfig(): Promise<Config> {
	debug("readConfig: loading from %s", CONFIG_PATH)
	try {
		const raw = await readFile(CONFIG_PATH, "utf8")
		const parsed = ini.parse(raw)
		const merged = { ...defaults, ...parsed }
		debug("readConfig: loaded keys: %s", Object.keys(merged).join(", "))
		return merged
	} catch {
		debug("readConfig: no config file, using defaults")
		return { ...defaults }
	}
}

export async function writeConfig(updates: Record<string, string>) {
	const existing = await readConfig()
	Object.assign(existing, updates)
	await writeFile(CONFIG_PATH, ini.stringify(existing), "utf8")
}

export async function getConfigValue(key: string): Promise<string | undefined> {
	const config = await readConfig()
	return config[key as keyof Config]
}

export async function setConfigValue(key: string, value: string) {
	await writeConfig({ [key]: value })
}

export async function getApiKey(): Promise<string> {
	const envKey = process.env.GROQ_API_KEY
	if (envKey) {
		debug("getApiKey: found in env")
		return envKey
	}

	const config = await readConfig()
	if (config.GROQ_API_KEY) {
		debug("getApiKey: found in config")
		return config.GROQ_API_KEY
	}

	debug("getApiKey: not found")
	throw new Error(
		"Please set your Groq API key via `cmint config set GROQ_API_KEY=<your token>`. " +
			"Multi-provider: set `cmint config set provider=cerebras` for Cerebras, or `cmint config set provider=mistral` for Mistral.",
	)
}

export async function getProviderApiKey(provider: string): Promise<string> {
	const envVar = PROVIDER_ENV_KEYS[provider as ProviderName]
	if (envVar) {
		const envValue = process.env[envVar]
		if (envValue) {
			debug("getProviderApiKey(%s): found in env", provider)
			return envValue
		}
	}

	const config = await readConfig()
	const configKey = PROVIDER_ENV_KEYS[provider as ProviderName]
	if (configKey && (config as Record<string, string | undefined>)[configKey]) {
		debug("getProviderApiKey(%s): found in config", provider)
		const val = (config as Record<string, string | undefined>)[configKey]
		return val as string
	}

	debug("getProviderApiKey(%s): not found", provider)
	const providerConfig = PROVIDER_CONFIGS[provider as ProviderName]
	if (providerConfig?.requiresApiKey === false) {
		debug("getProviderApiKey(%s): optional key not set, continuing without auth", provider)
		return ""
	}
	throw new Error(
		`Please set your ${formatProviderName(provider)} API key via \`cmint config set ${envVar}=<your token>\``,
	)
}

/** Check if a model name is the default for a provider OTHER than the given one. */
function isOtherProviderDefault(model: string, provider: string): boolean {
	for (const [name, config] of Object.entries(PROVIDER_CONFIGS)) {
		if (name !== provider && config.defaultModel === model) return true
	}
	return false
}

export function getModelForProvider(
	config: Config,
	provider: string,
	defaultModel: string,
): string {
	const modelKey = `model_${provider}` as keyof Config
	const providerModel = config[modelKey]
	if (providerModel) return providerModel

	const globalModel = config.model
	// Skip global model if it's another provider's default (cross-provider leak)
	if (globalModel && !isOtherProviderDefault(globalModel, provider)) return globalModel

	return defaultModel
}
