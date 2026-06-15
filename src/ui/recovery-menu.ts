import * as p from "@clack/prompts"
import { bold, cyan, dim, green, red, yellow } from "kolorist"
import { copyToClipboard } from "../services/clipboard.js"
import type { HookError } from "../services/hooks.js"
import { debug } from "../utils/debug.js"

export type RecoveryResult = "committed" | "cancelled" | "failed"

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recovery menu with recursive retry path
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Interactive TUI — format errors, handle 5 menu actions, recursive retry
export async function showRecoveryMenu(
	errors: HookError[],
	onRetry: () => Promise<boolean>,
	onSkipHooks: (message: string) => Promise<boolean>,
	onRestage: () => Promise<boolean>,
	message: string,
	rawStderr: string,
): Promise<RecoveryResult> {
	debug("showRecoveryMenu: %d errors", errors.length)

	let clipboardCopied = false
	let showNote = true

	while (true) {
		if (showNote) {
			p.note(
				errors.map((e) => `  ${red("•")} [${e.tool}] ${e.message}`).join("\n"),
				red(bold("Pre-commit hook failed")),
			)
			showNote = false
		}

		const choice = await p.select({
			message: "What do you want to do?",
			options: [
				{
					label: clipboardCopied
						? `${green("✓")} Copy error report to clipboard`
						: "Copy error report to clipboard",
					value: "clipboard",
					hint: clipboardCopied ? "Copied!" : "Paste into another terminal for an AI agent",
				},
				{
					label: "View full error output",
					value: "view",
					hint: "Show the raw stderr from hooks",
				},
				{
					label: "Skip hooks and commit (--no-verify)",
					value: "skip",
					hint: "Commit anyway, fix later",
				},
				{
					label: "Re-stage files and retry",
					value: "restage",
					hint: "Pick up fixes from another terminal",
				},
				{
					label: "Edit commit message",
					value: "edit",
					hint: "Modify the message before retrying",
				},
				{ label: "Cancel", value: "cancel" },
			],
		})

		if (p.isCancel(choice)) {
			debug("showRecoveryMenu: user cancelled")
			p.outro(yellow("Cancelled. Message cached for --retry."))
			return "cancelled"
		}

		debug("showRecoveryMenu: user chose %s", choice)

		switch (choice) {
			case "clipboard": {
				const ok = await copyToClipboard(rawStderr)
				if (ok) {
					clipboardCopied = true
					p.log.step(green("Copied to clipboard."))
				} else {
					p.log.warn(red("No clipboard tool found. Install xclip, wl-copy, or xsel."))
				}
				continue
			}
			case "view": {
				p.note(rawStderr.trim() || "(no raw output)", "Full error output")
				showNote = true
				continue
			}
			case "skip": {
				p.log.info(yellow("Committing with --no-verify..."))
				const ok = await onSkipHooks(message)
				if (ok) {
					p.outro(green("Committed (hooks skipped)."))
					return "committed"
				} else {
					p.outro(red("Commit failed even with --no-verify."))
					return "failed"
				}
			}
			case "restage": {
				p.log.info(cyan("Re-staging and retrying..."))
				const ok = await onRestage()
				if (ok) {
					p.outro(green("Committed successfully."))
					return "committed"
				}
				// Re-show errors after failed restage for context
				showNote = true
				continue
			}
			case "edit": {
				const edited = await p.text({
					message: "Edit commit message:",
					initialValue: message,
					validate: (v) => (v?.trim() ? undefined : "Message cannot be empty"),
				})
				if (p.isCancel(edited)) {
					p.outro(yellow("Cancelled. Message cached for --retry."))
					return "cancelled"
				}
				const ok = await onRetry()
				if (ok) {
					p.outro(green("Committed successfully."))
					return "committed"
				} else {
					p.outro(red("Commit failed again."))
					return "failed"
				}
			}
			case "cancel": {
				p.outro(dim("Message cached for --retry."))
				return "cancelled"
			}
		}
	}
}
