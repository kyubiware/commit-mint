import { isCancel } from "@clack/prompts";
import { bold } from "kolorist";
import { debug } from "../utils/debug.js";

export async function reviewCommitMessage(message: string): Promise<string | null> {
	const { select, text } = await import("@clack/prompts");
	while (true) {
		const review = await select({
			message: `Review commit message:\n\n   ${bold(message)}\n`,
			options: [
				{ label: "Use as-is", value: "use" },
				{ label: "Edit", value: "edit" },
				{ label: "Cancel", value: "cancel" },
			],
		});

		if (isCancel(review) || review === "cancel") {
			debug("User cancelled at review step");
			return null;
		}

		if (review === "use") {
			debug("User accepted message");
			return message;
		}

		if (review === "edit") {
			debug("User chose to edit message");
			const edited = await text({
				message: "Edit commit message:",
				initialValue: message,
				validate: (v) => (v?.trim() ? undefined : "Message cannot be empty"),
			});
			if (isCancel(edited)) {
				continue;
			}
			message = String(edited).trim();
			debug("Edited message:", message);
		}
	}
}
