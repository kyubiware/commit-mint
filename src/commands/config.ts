import * as p from "@clack/prompts";
import { bold, dim, green } from "kolorist";
import { getModelForProvider, readConfig, writeConfig } from "../services/config.js";
import {
	formatProviderName,
	isValidProvider,
	PROVIDER_CONFIGS,
	PROVIDER_ENV_KEYS,
	type ProviderName,
} from "../services/provider.js";
import { debug } from "../utils/debug.js";

function maskKey(key: string | undefined): string {
	if (!key) return dim("not set");
	if (key.length <= 8) return "****";
	return `${key.slice(0, 4)}${"*".repeat(Math.min(key.length - 8, 20))}${key.slice(-4)}`;
}

function buildConfigDisplay(config: Record<string, string | undefined>): string {
	const provider: ProviderName = isValidProvider(config.provider ?? "groq")
		? (config.provider as ProviderName)
		: "groq";
	const keyName = PROVIDER_ENV_KEYS[provider];
	const apiKey = config[keyName];
	const effectiveModel = getModelForProvider(
		config as import("../services/config.js").Config,
		provider,
		PROVIDER_CONFIGS[provider].defaultModel,
	);

	const lines = [
		`Provider:     ${bold(formatProviderName(provider))}`,
		`API Key:      ${maskKey(apiKey)}`,
		`Model:        ${effectiveModel}`,
		`Locale:       ${config.locale ?? "en"}`,
		`Max Length:   ${config["max-length"] ?? "100"}`,
		`Commit Type:  ${config.type || dim("(none)")}`,
		`Timeout:      ${config.timeout ?? "10000"}ms`,
		`Proxy:        ${config.proxy || dim("(none)")}`,
	];

	return lines.join("\n");
}

function getProvider(config: Record<string, string | undefined>): ProviderName {
	return isValidProvider(config.provider ?? "groq") ? (config.provider as ProviderName) : "groq";
}

async function promptProvider(): Promise<string | symbol> {
	return p.select({
		message: "Select LLM provider:",
		options: [
			{ label: "Groq", value: "groq", hint: PROVIDER_CONFIGS.groq.defaultModel },
			{ label: "Cerebras", value: "cerebras", hint: PROVIDER_CONFIGS.cerebras.defaultModel },
			{ label: "Mistral", value: "mistral", hint: PROVIDER_CONFIGS.mistral.defaultModel },
		],
	});
}

async function promptApiKey(provider: ProviderName): Promise<string | symbol> {
	const keyName = PROVIDER_ENV_KEYS[provider];
	const result = await p.text({
		message: `${formatProviderName(provider)} API key:`,
		placeholder: "Paste your API key",
		validate: (v) => (!v?.trim() ? "API key cannot be empty" : undefined),
	});
	if (p.isCancel(result)) return result;
	await writeConfig({ [keyName]: result.toString().trim() });
	debug("config: %s set", keyName);
	return result;
}

async function promptTextSetting(
	label: string,
	configKey: string,
	currentValue: string | undefined,
	validate?: (v: string | undefined) => string | undefined,
): Promise<string | symbol> {
	const result = await p.text({
		message: label,
		placeholder: currentValue ?? "",
		initialValue: currentValue ?? "",
		validate,
	});
	if (p.isCancel(result)) return result;
	await writeConfig({ [configKey]: result.toString().trim() });
	debug("config: %s set to %s", configKey, result);
	return result;
}

const requireNumber = (v: string | undefined) => {
	if (!v?.trim()) return "Value cannot be empty";
	return Number.isNaN(Number(v)) ? "Must be a number" : undefined;
};

type SettingHandler = () => Promise<string | symbol | undefined>;

function getSettingHandlers(
	config: Record<string, string | undefined>,
): Record<string, SettingHandler> {
	const provider = getProvider(config);
	return {
		provider: async () => {
			const result = await promptProvider();
			if (p.isCancel(result)) return result;
			const newProvider = result as ProviderName;
			const newDefaultModel = PROVIDER_CONFIGS[newProvider].defaultModel;
			await writeConfig({ provider: newProvider, model: newDefaultModel });
			debug("config: provider set to %s, model set to %s", newProvider, newDefaultModel);

			// Prompt for API key if not set for the new provider
			const keyName = PROVIDER_ENV_KEYS[newProvider];
			const updatedConfig = (await readConfig()) as Record<string, string | undefined>;
			if (!updatedConfig[keyName]) {
				const keyResult = await promptApiKey(newProvider);
				if (p.isCancel(keyResult)) return keyResult;
			}
		},
		apikey: async () => promptApiKey(provider),
		model: async () => {
			const effectiveModel = getModelForProvider(
				config as import("../services/config.js").Config,
				provider,
				PROVIDER_CONFIGS[provider].defaultModel,
			);
			return promptTextSetting("Model ID:", "model", effectiveModel);
		},
		locale: async () => promptTextSetting("Locale (e.g. en, ja, ko):", "locale", config.locale),
		maxlen: async () =>
			promptTextSetting(
				"Max commit message length:",
				"max-length",
				config["max-length"],
				requireNumber,
			),
		type: async () =>
			promptTextSetting("Commit type prefix (e.g. conventional):", "type", config.type),
		timeout: async () =>
			promptTextSetting("Timeout (ms):", "timeout", config.timeout, requireNumber),
		proxy: async () => promptTextSetting("Proxy URL:", "proxy", config.proxy),
	};
}

async function handleEditSetting(
	setting: string,
	config: Record<string, string | undefined>,
): Promise<boolean> {
	const handlers = getSettingHandlers(config);
	const handler = handlers[setting];
	if (!handler) return false;
	const result = await handler();
	return !p.isCancel(result);
}

async function editSettingsLoop(initialConfig: Record<string, string | undefined>): Promise<void> {
	let config = initialConfig;

	while (true) {
		// Re-read config to reflect changes from previous edits
		config = (await readConfig()) as Record<string, string | undefined>;
		const provider = getProvider(config);
		const effectiveModel = getModelForProvider(
			config as import("../services/config.js").Config,
			provider,
			PROVIDER_CONFIGS[provider].defaultModel,
		);

		const setting = await p.select({
			message: "Select a setting to edit:",
			options: [
				{
					label: `LLM Provider  ${dim(`(${formatProviderName(provider)})`)}`,
					value: "provider",
				},
				{
					label: `API Key  ${dim(`(for ${formatProviderName(provider)})`)}`,
					value: "apikey",
				},
				{
					label: `Model  ${dim(`(${effectiveModel})`)}`,
					value: "model",
				},
				{
					label: `Locale  ${dim(`(${config.locale ?? "en"})`)}`,
					value: "locale",
				},
				{
					label: `Max commit length  ${dim(`(${config["max-length"] ?? "100"})`)}`,
					value: "maxlen",
				},
				{
					label: `Commit type prefix  ${dim(`(${config.type || "(none)"})`)}`,
					value: "type",
				},
				{
					label: `Timeout (ms)  ${dim(`(${config.timeout ?? "10000"})`)}`,
					value: "timeout",
				},
				{
					label: `Proxy URL  ${dim(`(${config.proxy || "(none)"})`)}`,
					value: "proxy",
				},
				{ label: "Done editing", value: "done" },
			],
		});

		if (p.isCancel(setting) || setting === "done") break;

		const updated = await handleEditSetting(setting as string, config);
		if (updated) {
			p.log.success(green("Updated."));
		}
	}
}

export async function configCommand(): Promise<void> {
	debug("configCommand: starting");
	p.intro(bold("🌿 commit-mint config"));

	while (true) {
		const config = (await readConfig()) as Record<string, string | undefined>;

		p.note(buildConfigDisplay(config), "commit-mint config");

		const action = await p.select({
			message: "What would you like to do?",
			options: [
				{ label: "Edit settings", value: "edit" },
				{ label: "Done", value: "done" },
			],
		});

		if (p.isCancel(action)) {
			debug("configCommand: cancelled at main menu");
			p.outro(dim("Cancelled."));
			return;
		}

		if (action === "done") {
			debug("configCommand: done");
			p.outro("Config saved.");
			return;
		}

		await editSettingsLoop(config);
	}
}
