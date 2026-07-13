import type { Readable, Writable } from "node:stream"
import { styleText } from "node:util"
import { isCancel, MultiSelectPrompt } from "@clack/core"
import {
	limitOptions,
	S_BAR,
	S_BAR_END,
	S_CHECKBOX_ACTIVE,
	S_CHECKBOX_INACTIVE,
	S_CHECKBOX_SELECTED,
	symbol,
} from "@clack/prompts"
import { dim, green } from "kolorist"

/**
 * Render a checkbox-style option line with 4 visual states:
 *   active-selected, selected, active, inactive
 */
function renderCheckboxOption(label: string, selected: boolean, active: boolean): string {
	if (selected && active) return `${green(S_CHECKBOX_SELECTED)} ${label}`
	if (selected) return `${dim(S_CHECKBOX_SELECTED)} ${dim(label)}`
	if (active) return `${green(S_CHECKBOX_ACTIVE)} ${label}`
	return `${dim(S_CHECKBOX_INACTIVE)} ${dim(label)}`
}

/**
 * Build the render function for a MultiSelectPrompt with file-multiselect
 * styling and a hotkey hint line at the bottom.
 */
function buildMultiSelectRender<T>(
	message: string,
	options: Array<{ label: string; value: T }>,
	output?: Writable,
) {
	return function (this: MultiSelectPrompt<{ label: string; value: T }>) {
		const sym = symbol(this.state)
		const header = `${sym}  ${message}`
		const value: T[] = this.value ?? []
		const cursor: number = this.cursor

		switch (this.state) {
			case "submit": {
				const labels = value
					.map((v: T) => {
						const opt = options.find((o) => o.value === v)
						return opt?.label ?? String(v)
					})
					.join(dim(", "))
				return `${header}\n${dim(S_BAR)}  ${dim(labels)}`
			}
			case "cancel": {
				const cancelled = styleText(["strikethrough", "dim"], "Cancelled")
				return `${header}\n${dim(S_BAR_END)}  ${cancelled}`
			}
			default: {
				const stdio = output ?? process.stdout
				const termRows = ("rows" in stdio ? (stdio as { rows?: number }).rows : undefined) ?? 24
				// Reserve ~3 lines for header + hint footer + some padding.
				// limitOptions also clamps via its own rowPadding, so this just
				// removes the artificial 7-item ceiling.
				const dynamicMax = Math.min(options.length, Math.max(5, termRows - 3))
				const visible = limitOptions({
					cursor,
					options,
					style: (opt, active) =>
						renderCheckboxOption(
							(opt as { label: string }).label,
							value.includes((opt as { value: T }).value),
							active,
						),
					maxItems: dynamicMax,
					output: output ?? process.stdout,
				})
				const lines = visible.map((line: string) => `${dim(S_BAR)}  ${line}`)
				const hintLine =
					"↑/↓ navigate · space select · enter confirm · A select all · N select none"
				return [header, ...lines, `${dim(S_BAR_END)}  ${dim(hintLine)}`].join("\n")
			}
		}
	}
}

/**
 * Multi-select prompt with extended hotkeys for file selection.
 *
 * Built-in (from `@clack/core`'s `MultiSelectPrompt`):
 *   `a` — toggle all (select all / deselect all)
 *   `i` — invert selection
 *
 * Extended hotkeys:
 *   `A` (shift+A) — select all unconditionally
 *   `N` — select none (deselect all)
 */
export async function fileMultiSelect<T>(
	message: string,
	options: Array<{ label: string; value: T }>,
	opts?: {
		required?: boolean
		initialValues?: T[]
		input?: Readable
		output?: Writable
	},
): Promise<T[] | symbol> {
	const required = opts?.required ?? true

	const prompt = new MultiSelectPrompt({
		options,
		required,
		initialValues: opts?.initialValues,
		input: opts?.input,
		output: opts?.output,
		validate: (values: T[] | undefined) => {
			if (required && (!values || values.length === 0)) {
				return "Please select at least one option."
			}
		},
		render: buildMultiSelectRender(message, options, opts?.output),
	})

	prompt.on("key", (char: string | undefined, key: { shift?: boolean }) => {
		if (!char) return
		if (char === "a" && key?.shift) {
			// A (shift+A) — select all unconditionally
			prompt.value = options.map((o) => o.value)
		}
		if (char === "n") {
			// N (any case) — select none / deselect all
			prompt.value = []
		}
	})

	return (await prompt.prompt()) as T[] | symbol
}

export { isCancel }
