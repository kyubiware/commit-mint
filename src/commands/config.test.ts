import { describe, expect, it, vi } from "vitest"

vi.mock("@clack/prompts", () => ({
	log: { warn: vi.fn(), success: vi.fn() },
	select: vi.fn(),
	intro: vi.fn(),
	outro: vi.fn(),
	note: vi.fn(),
	text: vi.fn(),
	isCancel: vi.fn(),
}))
vi.mock("../services/config.js", () => ({
	getModelForProvider: vi.fn(),
	getProviderApiKey: vi.fn(),
	readConfig: vi.fn(),
	writeConfig: vi.fn(),
}))
vi.mock("../utils/debug.js", () => ({ debug: vi.fn() }))
vi.mock("./setup.js", () => ({ setupCmintrcCommand: vi.fn() }))

import { PROVIDER_CONFIGS, type ProviderModelInfo } from "../services/provider.js"
import { buildModelOptions } from "./config.js"

const model = (id: string, name?: string, contextLength?: number): ProviderModelInfo => ({
	id,
	name,
	contextLength,
})

describe("buildModelOptions", () => {
	it("sorts free models first, preserving curated order within each band", () => {
		const options = buildModelOptions([
			model("paid/a", "Paid A", 100000),
			model("vendor/m-free", "Free M", 256000),
			model("paid/b", "Paid B"),
			model("other/n:free", "Free N", 1000000),
		])
		expect(options.map((o) => o.value)).toEqual([
			"vendor/m-free",
			"other/n:free",
			"paid/a",
			"paid/b",
		])
	})

	it("marks free models in the label and keeps plain context hints", () => {
		const options = buildModelOptions([
			model("paid/a", "Paid A", 100000),
			model("vendor/m-free", "Free M", 256000),
			model("vendor/tiny-free", "Free Tiny"),
		])
		expect(options).toEqual([
			{ label: "Free M (free)", value: "vendor/m-free", hint: "256k ctx" },
			{ label: "Free Tiny (free)", value: "vendor/tiny-free", hint: undefined },
			{ label: "Paid A", value: "paid/a", hint: "100k ctx" },
		])
	})

	it("falls back to the id as the label when the model has no display name", () => {
		const options = buildModelOptions([model("paid/bare")])
		expect(options[0].label).toBe("paid/bare")
		expect(options[0].hint).toBeUndefined()
	})

	it("hides ids matching the exclude regex and passes the rest through", () => {
		const options = buildModelOptions(
			[model("vendor/embed-1", "Embed 1"), model("paid/a", "Paid A", 100000)],
			/embed/i,
		)
		expect(options.map((o) => o.value)).toEqual(["paid/a"])
	})

	it("applies the commandcode registry exclude to hide claude-* models", () => {
		expect(PROVIDER_CONFIGS.commandcode.modelListExclude).toEqual(/^claude/)
		const options = buildModelOptions(
			[
				model("claude-sonnet-5", "Claude Sonnet 5", 1000000),
				model("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"),
			],
			PROVIDER_CONFIGS.commandcode.modelListExclude,
		)
		expect(options.map((o) => o.value)).toEqual(["deepseek/deepseek-v4-flash"])
	})

	it("applies the gemini registry exclude to hide non-chat models", () => {
		const options = buildModelOptions(
			[
				model("gemini-embedding-001", "Gemini Embedding 001"),
				model("gemini-3.8-flash", "Gemini 3.8 Flash", 1000000),
			],
			PROVIDER_CONFIGS.gemini.modelListExclude,
		)
		expect(options.map((o) => o.value)).toEqual(["gemini-3.8-flash"])
	})
})
