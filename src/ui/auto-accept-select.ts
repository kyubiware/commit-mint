import type { Readable, Writable } from "node:stream"
import { styleText } from "node:util"
import { isCancel as isClackCancel, SelectPrompt } from "@clack/core"
import {
	limitOptions,
	S_BAR,
	S_BAR_END,
	S_RADIO_ACTIVE,
	S_RADIO_INACTIVE,
	symbol,
} from "@clack/prompts"
import { dim, green } from "kolorist"
import { debug } from "../utils/debug.js"

export interface AutoAcceptOption<T> {
	value: T
	label?: string
	hint?: string
	disabled?: boolean
}

export interface AutoAcceptSelectOptions<T> {
	message: string
	options: Array<AutoAcceptOption<T>>
	initialAutoAccept: boolean
	/** Fired whenever the user toggles auto-accept via the `a` hotkey. */
	onToggle?: (next: boolean) => void | Promise<void>
	input?: Readable
	output?: Writable
}

export interface AutoAcceptResult<T> {
	value: T
	autoAccept: boolean
}

const ON_LABEL = styleText("green", "ON")
const OFF_LABEL = styleText("dim", "OFF")
const HOTKEY_HINT = dim("(press `a` to toggle)")

function renderStatus(autoAccept: boolean): string {
	const label = autoAccept ? ON_LABEL : OFF_LABEL
	return `${dim("⚡ Auto-accept:")} ${label} ${HOTKEY_HINT}`
}

/** Render a single select option line. */
function renderOption<T>(opt: AutoAcceptOption<T>, active: boolean): string {
	const text = opt.label ?? String(opt.value)
	if (opt.disabled) {
		return `${dim(S_RADIO_INACTIVE)} ${styleText(["strikethrough", "dim"], text)}`
	}
	if (active) {
		const hint = opt.hint ? ` ${dim(`(${opt.hint})`)}` : ""
		return `${green(S_RADIO_ACTIVE)} ${text}${hint}`
	}
	return `${dim(S_RADIO_INACTIVE)} ${dim(text)}`
}

/**
 * Select prompt with an inline `a`-hotkey toggle for auto-accept mode.
 *
 * Renders a normal select list plus a status line showing the current
 * auto-accept state. Pressing `a` flips the state in-place (the menu
 * re-renders) and fires `onToggle` so callers can persist the change.
 *
 * Returns `{ value, autoAccept }` on submit, or the clack cancel symbol
 * on cancel.
 */
export async function selectWithAutoAccept<T>(
	opts: AutoAcceptSelectOptions<T>,
): Promise<AutoAcceptResult<T> | symbol> {
	let autoAccept = opts.initialAutoAccept

	const prompt = new SelectPrompt({
		options: opts.options,
		input: opts.input,
		output: opts.output,
		render() {
			const sym = symbol(this.state)
			const statusLine = renderStatus(autoAccept)
			const header = `${sym}  ${opts.message}\n${dim(S_BAR)}  ${statusLine}`

			switch (this.state) {
				case "submit": {
					const selected = this.options[this.cursor]
					const text = selected.label ?? String(selected.value)
					return `${header}\n${dim(S_BAR)}  ${dim(text)}`
				}
				case "cancel": {
					const selected = this.options[this.cursor]
					const text = selected.label ?? String(selected.value)
					return `${header}\n${dim(S_BAR)}  ${styleText(["strikethrough", "dim"], text)}\n${dim(S_BAR_END)}`
				}
				default: {
					const visible = limitOptions({
						cursor: this.cursor,
						options: this.options,
						style: (opt: AutoAcceptOption<T>, active: boolean) => renderOption(opt, active),
						maxItems: 7,
						output: opts.output ?? process.stdout,
					})
					const lines = visible.map((line: string) => `${dim(S_BAR)}  ${line}`)
					return [
						header,
						...lines,
						`${dim(S_BAR_END)}  ${dim("↑/↓ navigate • Enter confirm • `a` toggle auto-accept")}`,
					].join("\n")
				}
			}
		},
	})

	prompt.on("key", async (char: string | undefined) => {
		if (char === "a") {
			autoAccept = !autoAccept
			debug("auto-accept toggled to %s", autoAccept)
			try {
				await opts.onToggle?.(autoAccept)
			} catch (err) {
				debug("onToggle threw (ignored): %s", err instanceof Error ? err.message : String(err))
			}
		}
	})

	const result = await prompt.prompt()

	if (isClackCancel(result)) {
		return result
	}

	return { value: result as T, autoAccept }
}

/** Convenience guard for callers. */
export function isAutoAcceptCancel<_T>(value: unknown): value is symbol {
	return isClackCancel(value)
}
