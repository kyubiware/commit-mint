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

/**
 * A toggle rendered inline in the select prompt header.
 *
 * Each toggle is keyed by a stable identifier (`key`) so callers can read
 * the final state out of the result map. The `hotkey` is the lowercase
 * letter that flips the state while the prompt is open.
 */
export interface ToggleOption {
	/** Stable identifier used in the result map (e.g. "autoAccept", "skipChecks"). */
	key: string
	/** Letter that flips the state while the prompt is open (e.g. "a", "c"). */
	hotkey: string
	/** Display label (e.g. "Auto-accept", "Skip checks"). */
	label: string
	/** Icon/symbol prefix shown before the label (e.g. "⚡", "🛡"). */
	icon: string
	/** State when the prompt opens. */
	initial: boolean
	/** Fired whenever the user toggles via the hotkey. */
	onToggle?: (next: boolean) => void | Promise<void>
}

export interface ToggleSelectOption<T> {
	value: T
	label?: string
	hint?: string
	disabled?: boolean
}

export interface ToggleSelectOptions<T> {
	message: string
	options: Array<ToggleSelectOption<T>>
	toggles: ToggleOption[]
	input?: Readable
	output?: Writable
}

export interface ToggleSelectResult<T> {
	value: T
	/** Final toggle states, keyed by `ToggleOption.key`. */
	toggles: Record<string, boolean>
}

const ON_LABEL = styleText("green", "ON")
const OFF_LABEL = styleText("dim", "OFF")

function renderToggleState(t: ToggleOption, state: boolean): string {
	const label = state ? ON_LABEL : OFF_LABEL
	const hint = dim(`(press \`${t.hotkey}\` to toggle)`)
	return `${dim(`${t.icon} ${t.label}:`)} ${label} ${hint}`
}

/** Render a single select option line. */
function renderOption<T>(opt: ToggleSelectOption<T>, active: boolean): string {
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
 * Select prompt with inline hotkey toggles.
 *
 * Renders a normal select list plus one status line per toggle. Pressing a
 * toggle's hotkey flips its state in-place (the prompt re-renders) and fires
 * its `onToggle` callback so callers can persist the change.
 *
 * Returns `{ value, toggles }` on submit, or the clack cancel symbol on
 * cancel. `toggles` is a map of `ToggleOption.key -> final boolean state`.
 */
export async function selectWithToggles<T>(
	opts: ToggleSelectOptions<T>,
): Promise<ToggleSelectResult<T> | symbol> {
	// Track each toggle's state, keyed by hotkey for O(1) lookup on keypress.
	const state: Record<string, boolean> = {}
	for (const t of opts.toggles) {
		state[t.hotkey] = t.initial
	}

	const prompt = new SelectPrompt({
		options: opts.options,
		input: opts.input,
		output: opts.output,
		render: buildPromptRenderer(opts, state),
	})

	prompt.on("key", async (char: string | undefined) => {
		const toggle = opts.toggles.find((t) => t.hotkey === char)
		if (!toggle) return
		state[toggle.hotkey] = !state[toggle.hotkey]
		debug("%s toggled to %s", toggle.label, state[toggle.hotkey])
		try {
			await toggle.onToggle?.(state[toggle.hotkey])
		} catch (err) {
			debug("onToggle threw (ignored): %s", err instanceof Error ? err.message : String(err))
		}
	})

	const result = await prompt.prompt()

	if (isClackCancel(result)) {
		return result
	}

	return { value: result as T, toggles: buildTogglesMap(opts, state) }
}

/**
 * Build a render callback for the SelectPrompt.
 *
 * Closed over `opts` (the toggle-select options) and `state` (the mutable
 * hotkey → boolean map) so the inline render function can access toggle
 * state without encoding it in `this`.
 */
function buildPromptRenderer<T>(
	opts: ToggleSelectOptions<T>,
	state: Record<string, boolean>,
): (this: SelectPrompt<{ value: T }>) => string {
	const optionList = opts.options
	const toggleList = opts.toggles
	return function (this: SelectPrompt<{ value: T }>) {
		const sym = symbol(this.state)
		const statusLines = toggleList
			.map((t) => `${dim(S_BAR)}  ${renderToggleState(t, state[t.hotkey])}`)
			.join("\n")
		const header = `${sym}  ${opts.message}\n${statusLines}`

		switch (this.state) {
			case "submit": {
				const selected = optionList[this.cursor]
				const text = selected.label ?? String(selected.value)
				return `${header}\n${dim(S_BAR)}  ${dim(text)}`
			}
			case "cancel": {
				const selected = optionList[this.cursor]
				const text = selected.label ?? String(selected.value)
				return `${header}\n${dim(S_BAR)}  ${styleText(["strikethrough", "dim"], text)}\n${dim(S_BAR_END)}`
			}
			default: {
				const stdio = opts.output ?? process.stdout
				const termRows = ("rows" in stdio ? (stdio as { rows?: number }).rows : undefined) ?? 24
				// Reserve ~5 lines for header + 2 toggle status lines + hint
				// footer + padding. limitOptions also clamps via its own
				// rowPadding, so this just removes the artificial ceiling.
				const dynamicMax = Math.min(optionList.length, Math.max(5, termRows - 5))
				const visible = limitOptions({
					cursor: this.cursor,
					options: optionList,
					style: (opt: ToggleSelectOption<T>, active: boolean) => renderOption(opt, active),
					maxItems: dynamicMax,
					output: opts.output ?? process.stdout,
				})
				const lines = visible.map((line: string) => `${dim(S_BAR)}  ${line}`)
				const hotkeysHint = toggleList
					.map((t) => `\`${t.hotkey}\` toggle ${t.label.toLowerCase()}`)
					.join(" • ")
				return [
					header,
					...lines,
					`${dim(S_BAR_END)}  ${dim(`↑/↓ navigate • Enter confirm • ${hotkeysHint}`)}`,
				].join("\n")
			}
		}
	}
}

/** Collate the final toggle states keyed by `ToggleOption.key`. */
function buildTogglesMap<T>(
	opts: ToggleSelectOptions<T>,
	state: Record<string, boolean>,
): Record<string, boolean> {
	const togglesByKey: Record<string, boolean> = {}
	for (const t of opts.toggles) {
		togglesByKey[t.key] = state[t.hotkey]
	}
	return togglesByKey
}

/** Convenience guard for callers. */
export function isToggleSelectCancel<_T>(value: unknown): value is symbol {
	return isClackCancel(value)
}
