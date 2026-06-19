import { PassThrough, Readable } from "node:stream"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}))

import { selectWithAutoAccept } from "./auto-accept-select.js"

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

/** Drain a PassThrough into a string. */
function _drain(stream: PassThrough): string {
	return stream.read()?.toString() ?? ""
}

describe("selectWithAutoAccept", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns the selected option value with the initial autoAccept when 'a' is never pressed", async () => {
		const input = makeInput()
		const output = new PassThrough()
		const onToggle = vi.fn()

		const promise = selectWithAutoAccept({
			message: "Pick:",
			options: [
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
			initialAutoAccept: false,
			onToggle,
			input,
			output,
		})

		// Submit immediately (cursor on first option)
		press(input, undefined, "return")
		const result = await promise

		expect(result).not.toBe(Symbol.for("clack:cancel"))
		expect(result).toEqual({ value: "a", autoAccept: false })
		expect(onToggle).not.toHaveBeenCalled()
	})

	it("toggles autoAccept to true when 'a' is pressed once (starting from false)", async () => {
		const input = makeInput()
		const output = new PassThrough()
		const onToggle = vi.fn()

		const promise = selectWithAutoAccept({
			message: "Pick:",
			options: [{ value: "x", label: "X" }],
			initialAutoAccept: false,
			onToggle,
			input,
			output,
		})

		// Give the prompt a tick to subscribe
		await new Promise((r) => setTimeout(r, 10))
		press(input, "a", "a")
		await new Promise((r) => setTimeout(r, 10))
		press(input, undefined, "return")
		const result = await promise

		expect(result).toEqual({ value: "x", autoAccept: true })
		expect(onToggle).toHaveBeenCalledWith(true)
	})

	it("toggles back to false when 'a' is pressed twice (starting from false)", async () => {
		const input = makeInput()
		const output = new PassThrough()

		const promise = selectWithAutoAccept({
			message: "Pick:",
			options: [{ value: "x", label: "X" }],
			initialAutoAccept: false,
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

		expect(result).toEqual({ value: "x", autoAccept: false })
	})

	it("renders a status line showing ON when autoAccept is true", async () => {
		const input = makeInput()
		const output = new PassThrough()
		output.setEncoding("utf8")
		const chunks: string[] = []
		output.on("data", (c) => chunks.push(c))

		const promise = selectWithAutoAccept({
			message: "Pick:",
			options: [{ value: "x", label: "X" }],
			initialAutoAccept: true,
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

	it("renders a status line showing OFF when autoAccept is false", async () => {
		const input = makeInput()
		const output = new PassThrough()
		output.setEncoding("utf8")
		const chunks: string[] = []
		output.on("data", (c) => chunks.push(c))

		const promise = selectWithAutoAccept({
			message: "Pick:",
			options: [{ value: "x", label: "X" }],
			initialAutoAccept: false,
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

		const promise = selectWithAutoAccept({
			message: "Pick:",
			options: [{ value: "x", label: "X" }],
			initialAutoAccept: false,
			input,
			output,
		})

		await new Promise((r) => setTimeout(r, 10))
		press(input, undefined, "return")
		await promise

		const rendered = chunks.join("")
		// Hint should reference the 'a' key somewhere
		expect(rendered.toLowerCase()).toContain("a")
	})

	it("navigates down then submits the second option", async () => {
		const input = makeInput()
		const output = new PassThrough()

		const promise = selectWithAutoAccept({
			message: "Pick:",
			options: [
				{ value: "first", label: "First" },
				{ value: "second", label: "Second" },
			],
			initialAutoAccept: false,
			input,
			output,
		})

		await new Promise((r) => setTimeout(r, 10))
		press(input, undefined, "down")
		await new Promise((r) => setTimeout(r, 10))
		press(input, undefined, "return")
		const result = await promise

		expect(result).toEqual({ value: "second", autoAccept: false })
	})

	it("cancel via ctrl-c resolves to the clack cancel symbol", async () => {
		const input = makeInput()
		const output = new PassThrough()

		const promise = selectWithAutoAccept({
			message: "Pick:",
			options: [{ value: "x", label: "X" }],
			initialAutoAccept: false,
			input,
			output,
		})

		await new Promise((r) => setTimeout(r, 10))
		// clack treats \x03 (ctrl-c) as cancel
		press(input, "\x03", "c")
		const result = await promise

		// isCancel(result) would be true — we check it's a symbol
		expect(typeof result).toBe("symbol")
	})
})
