import { PassThrough, Readable } from "node:stream"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}))

import { selectWithToggles, type ToggleOption } from "./toggle-select.js"

/** Build a fake TTY-capable input stream we can emit keypresses on. */
function makeInput() {
	const input = new Readable({ read() {} })
	;(input as unknown as { isTTY: boolean }).isTTY = true
	;(input as unknown as { setRawMode: (mode: number) => void }).setRawMode = () => {}
	return input
}

/** Emit a keypress on a stream (clack's Prompt subscribes to 'keypress' directly). */
function press(stream: Readable, char: string | undefined, name: string) {
	stream.emit("keypress", char, { name, sequence: char ?? "" })
}

describe("selectWithToggles", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	const singleToggle = (overrides: Partial<ToggleOption> = {}): ToggleOption[] => [
		{
			key: "autoAccept",
			hotkey: "a",
			label: "Auto-accept",
			icon: "⚡",
			initial: false,
			...overrides,
		},
	]

	it("returns the selected value with the initial toggle state when no hotkey is pressed", async () => {
		const input = makeInput()
		const output = new PassThrough()
		const onToggle = vi.fn()

		const promise = selectWithToggles({
			message: "Pick:",
			options: [
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			toggles: singleToggle({ onToggle }),
			input,
			output,
		})

		press(input, undefined, "return")
		const result = await promise

		expect(result).not.toBe(Symbol.for("clack:cancel"))
		expect(result).toEqual({ value: "a", toggles: { autoAccept: false } })
		expect(onToggle).not.toHaveBeenCalled()
	})

	it("toggles state to true when the hotkey is pressed once (starting from false)", async () => {
		const input = makeInput()
		const output = new PassThrough()
		const onToggle = vi.fn()

		const promise = selectWithToggles({
			message: "Pick:",
			options: [{ value: "x", label: "X" }],
			toggles: singleToggle({ initial: false, onToggle }),
			input,
			output,
		})

		await new Promise((r) => setTimeout(r, 10))
		press(input, "a", "a")
		await new Promise((r) => setTimeout(r, 10))
		press(input, undefined, "return")
		const result = await promise

		expect(result).toEqual({ value: "x", toggles: { autoAccept: true } })
		expect(onToggle).toHaveBeenCalledWith(true)
	})

	it("toggles back to false when the hotkey is pressed twice", async () => {
		const input = makeInput()
		const output = new PassThrough()

		const promise = selectWithToggles({
			message: "Pick:",
			options: [{ value: "x", label: "X" }],
			toggles: singleToggle({ initial: false }),
			input,
			output,
		})

		await new Promise((r) => setTimeout(r, 10))
		press(input, "a", "a")
		await new Promise((r) => setTimeout(r, 10))
		press(input, "a", "a")
		await new Promise((r) => setTimeout(r, 10))
		press(input, undefined, "return")
		const result = await promise

		expect(result).toEqual({ value: "x", toggles: { autoAccept: false } })
	})

	it("renders ON when the toggle initial state is true", async () => {
		const input = makeInput()
		const output = new PassThrough()
		output.setEncoding("utf8")
		const chunks: string[] = []
		output.on("data", (c) => chunks.push(c))

		const promise = selectWithToggles({
			message: "Pick:",
			options: [{ value: "x", label: "X" }],
			toggles: singleToggle({ initial: true }),
			input,
			output,
		})

		await new Promise((r) => setTimeout(r, 10))
		press(input, undefined, "return")
		await promise

		const rendered = chunks.join("")
		expect(rendered).toContain("Auto-accept")
		expect(rendered).toContain("ON")
	})

	it("renders OFF when the toggle initial state is false", async () => {
		const input = makeInput()
		const output = new PassThrough()
		output.setEncoding("utf8")
		const chunks: string[] = []
		output.on("data", (c) => chunks.push(c))

		const promise = selectWithToggles({
			message: "Pick:",
			options: [{ value: "x", label: "X" }],
			toggles: singleToggle({ initial: false }),
			input,
			output,
		})

		await new Promise((r) => setTimeout(r, 10))
		press(input, undefined, "return")
		await promise

		const rendered = chunks.join("")
		expect(rendered).toContain("Auto-accept")
		expect(rendered).toContain("OFF")
	})

	it("renders the hotkey hint mentioning 'a'", async () => {
		const input = makeInput()
		const output = new PassThrough()
		output.setEncoding("utf8")
		const chunks: string[] = []
		output.on("data", (c) => chunks.push(c))

		const promise = selectWithToggles({
			message: "Pick:",
			options: [{ value: "x", label: "X" }],
			toggles: singleToggle(),
			input,
			output,
		})

		await new Promise((r) => setTimeout(r, 10))
		press(input, undefined, "return")
		await promise

		const rendered = chunks.join("")
		expect(rendered.toLowerCase()).toContain("`a`")
	})

	it("navigates down then submits the second option", async () => {
		const input = makeInput()
		const output = new PassThrough()

		const promise = selectWithToggles({
			message: "Pick:",
			options: [
				{ value: "first", label: "First" },
				{ value: "second", label: "Second" },
			],
			toggles: singleToggle(),
			input,
			output,
		})

		await new Promise((r) => setTimeout(r, 10))
		press(input, undefined, "down")
		await new Promise((r) => setTimeout(r, 10))
		press(input, undefined, "return")
		const result = await promise

		expect(result).toEqual({ value: "second", toggles: { autoAccept: false } })
	})

	it("cancel via ctrl-c resolves to the clack cancel symbol", async () => {
		const input = makeInput()
		const output = new PassThrough()

		const promise = selectWithToggles({
			message: "Pick:",
			options: [{ value: "x", label: "X" }],
			toggles: singleToggle(),
			input,
			output,
		})

		await new Promise((r) => setTimeout(r, 10))
		// clack treats \x03 (ctrl-c) as cancel
		press(input, "\x03", "c")
		const result = await promise

		expect(typeof result).toBe("symbol")
	})

	describe("multiple toggles", () => {
		const twoToggles = (
			overrides: { autoAccept?: Partial<ToggleOption>; skipChecks?: Partial<ToggleOption> } = {},
		): ToggleOption[] => [
			{
				key: "autoAccept",
				hotkey: "a",
				label: "Auto-accept",
				icon: "⚡",
				initial: false,
				...overrides.autoAccept,
			},
			{
				key: "skipChecks",
				hotkey: "c",
				label: "Skip checks",
				icon: "🛡",
				initial: false,
				...overrides.skipChecks,
			},
		]

		it("returns the state of both toggles keyed by their `key`", async () => {
			const input = makeInput()
			const output = new PassThrough()

			const promise = selectWithToggles({
				message: "Pick:",
				options: [{ value: "x", label: "X" }],
				toggles: twoToggles({
					autoAccept: { initial: true },
					skipChecks: { initial: false },
				}),
				input,
				output,
			})

			await new Promise((r) => setTimeout(r, 10))
			press(input, undefined, "return")
			const result = await promise

			expect(result).toEqual({
				value: "x",
				toggles: { autoAccept: true, skipChecks: false },
			})
		})

		it("toggles each independently via its own hotkey", async () => {
			const input = makeInput()
			const output = new PassThrough()

			const promise = selectWithToggles({
				message: "Pick:",
				options: [{ value: "x", label: "X" }],
				toggles: twoToggles(),
				input,
				output,
			})

			await new Promise((r) => setTimeout(r, 10))
			press(input, "c", "c")
			await new Promise((r) => setTimeout(r, 10))
			press(input, "a", "a")
			await new Promise((r) => setTimeout(r, 10))
			press(input, "a", "a") // flip autoAccept back to false
			await new Promise((r) => setTimeout(r, 10))
			press(input, undefined, "return")
			const result = await promise

			expect(result).toEqual({
				value: "x",
				toggles: { autoAccept: false, skipChecks: true },
			})
		})

		it("fires onToggle only for the matching toggle", async () => {
			const input = makeInput()
			const output = new PassThrough()
			const autoAcceptToggle = vi.fn()
			const skipChecksToggle = vi.fn()

			const promise = selectWithToggles({
				message: "Pick:",
				options: [{ value: "x", label: "X" }],
				toggles: twoToggles({
					autoAccept: { onToggle: autoAcceptToggle },
					skipChecks: { onToggle: skipChecksToggle },
				}),
				input,
				output,
			})

			await new Promise((r) => setTimeout(r, 10))
			press(input, "c", "c")
			await new Promise((r) => setTimeout(r, 10))
			press(input, undefined, "return")
			await promise

			expect(skipChecksToggle).toHaveBeenCalledWith(true)
			expect(autoAcceptToggle).not.toHaveBeenCalled()
		})

		it("renders both toggle status lines", async () => {
			const input = makeInput()
			const output = new PassThrough()
			output.setEncoding("utf8")
			const chunks: string[] = []
			output.on("data", (c) => chunks.push(c))

			const promise = selectWithToggles({
				message: "Pick:",
				options: [{ value: "x", label: "X" }],
				toggles: twoToggles(),
				input,
				output,
			})

			await new Promise((r) => setTimeout(r, 10))
			press(input, undefined, "return")
			await promise

			const rendered = chunks.join("")
			expect(rendered).toContain("Auto-accept")
			expect(rendered).toContain("Skip checks")
			expect(rendered).toContain("`a`")
			expect(rendered).toContain("`c`")
		})

		it("ignores keypresses that don't match any registered hotkey", async () => {
			const input = makeInput()
			const output = new PassThrough()

			const promise = selectWithToggles({
				message: "Pick:",
				options: [{ value: "x", label: "X" }],
				toggles: twoToggles(),
				input,
				output,
			})

			await new Promise((r) => setTimeout(r, 10))
			press(input, "z", "z") // not a registered hotkey
			await new Promise((r) => setTimeout(r, 10))
			press(input, undefined, "return")
			const result = await promise

			expect(result).toEqual({
				value: "x",
				toggles: { autoAccept: false, skipChecks: false },
			})
		})
	})
})
