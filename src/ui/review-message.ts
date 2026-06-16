import { isCancel } from "@clack/prompts"
import { bold, red } from "kolorist"
import { debug } from "../utils/debug.js"

export interface ReviewCommitMessageOptions {
	/**
	 * If provided, adds a "Regenerate with hint" option to the menu.
	 * Called with the user-entered hint; should return a new commit message.
	 * Thrown errors are caught and surfaced inline so the user can retry.
	 */
	regenerate?: (hint: string) => Promise<string>
}

async function handleEdit(message: string): Promise<string | null> {
	const { text } = await import("@clack/prompts")
	const edited = await text({
		message: "Edit commit message:",
		initialValue: message,
		validate: (v) => (v?.trim() ? undefined : "Message cannot be empty"),
	})
	if (isCancel(edited)) {
		debug("User cancelled edit, returning to review menu")
		return null
	}
	const newMessage = String(edited).trim()
	debug("Edited message:", newMessage)
	return newMessage
}

async function handleRegenerate(
	regenerate: (hint: string) => Promise<string>,
): Promise<string | null> {
	const { log, text } = await import("@clack/prompts")
	const hint = await text({
		message: "Describe what this commit is about to guide regeneration:",
		validate: (v) => (v?.trim() ? undefined : "Hint cannot be empty"),
	})
	if (isCancel(hint)) {
		debug("User cancelled hint entry, returning to review menu")
		return null
	}
	const hintValue = String(hint).trim()
	debug("Regenerating with hint:", hintValue)
	try {
		const newMessage = await regenerate(hintValue)
		debug("Regenerated message:", newMessage)
		return newMessage
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err)
		debug("Regeneration failed:", errMsg)
		log.warn(red(`Regeneration failed: ${errMsg}`))
		return null
	}
}

export async function reviewCommitMessage(
	message: string,
	options?: ReviewCommitMessageOptions,
): Promise<string | null> {
	const { select } = await import("@clack/prompts")
	while (true) {
		const reviewOptions: { label: string; value: string }[] = [
			{ label: "Use as-is", value: "use" },
			{ label: "Edit", value: "edit" },
		]
		if (options?.regenerate) {
			reviewOptions.push({ label: "Regenerate with hint", value: "regenerate" })
		}
		reviewOptions.push({ label: "Cancel", value: "cancel" })

		const review = await select({
			message: `Review commit message:\n\n   ${bold(message)}\n`,
			options: reviewOptions,
		})

		if (isCancel(review) || review === "cancel") {
			debug("User cancelled at review step")
			return null
		}

		if (review === "use") {
			debug("User accepted message")
			return message
		}

		if (review === "edit") {
			message = (await handleEdit(message)) ?? message
		}

		if (review === "regenerate" && options?.regenerate) {
			message = (await handleRegenerate(options.regenerate)) ?? message
		}
	}
}
