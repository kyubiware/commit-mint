import { isCancel, log, outro, spinner } from "@clack/prompts";
import { bold, dim, green, red } from "kolorist";
import { isOpenCodeAvailable, reviewWithGroq, reviewWithOpenCode } from "../commands/review.js";
import { copyToClipboard } from "../services/clipboard.js";
import { readConfig } from "../services/config.js";
import { getStagedDiff } from "../services/git.js";
import { formatProviderName, isValidProvider, type ProviderName } from "../services/provider.js";
import { debug } from "../utils/debug.js";

export async function runCodeReview(): Promise<void> {
	const diffResult = await getStagedDiff();
	if (!diffResult || "excludedFiles" in diffResult) {
		outro(dim("No staged changes to review."));
		return;
	}

	const opencodeAvailable = await isOpenCodeAvailable();
	const config = await readConfig();
	const provider: ProviderName = isValidProvider(config.provider ?? "groq")
		? (config.provider as ProviderName)
		: "groq";
	const s = spinner();
	s.start(
		opencodeAvailable
			? "Running OpenCode review..."
			: `Running ${formatProviderName(provider)} review...`,
	);

	try {
		const report = opencodeAvailable
			? await reviewWithOpenCode(diffResult.diff, diffResult.files)
			: await reviewWithGroq(diffResult.diff, diffResult.files);
		s.stop("Review complete");

		await showReviewResults(report);
	} catch (err) {
		s.stop(red("Review failed."));
		debug("Code review error:", err instanceof Error ? err.message : String(err));
		outro(red(err instanceof Error ? err.message : String(err)));
	}
}

export async function showReviewResults(report: string): Promise<void> {
	const { note: clackNote, select: clackSelect } = await import("@clack/prompts");
	const hasIssues = report !== "NO_ISSUES_FOUND" && report.trim().length > 0;
	if (!hasIssues) {
		log.info(green("No issues found."));
		return;
	}

	clackNote(report, red(bold("Review findings")));
	const shouldCopy = await clackSelect({
		message: "Copy review report to clipboard?",
		options: [
			{ label: "Yes, copy to clipboard", value: "yes" },
			{ label: "No", value: "no" },
		],
	});
	if (isCancel(shouldCopy) || shouldCopy !== "yes") return;

	const ok = await copyToClipboard(report);
	if (ok) {
		log.info(green("Report copied to clipboard."));
	} else {
		log.warn(red("Failed to copy to clipboard."));
	}
}

export async function reviewCommitMessage(message: string): Promise<string | null> {
	const { select, text } = await import("@clack/prompts");
	while (true) {
		const review = await select({
			message: `Review commit message:\n\n   ${bold(message)}\n`,
			options: [
				{ label: "Use as-is", value: "use" },
				{ label: "Edit", value: "edit" },
				{ label: "Review with OpenCode", value: "review" },
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
			continue;
		}

		if (review === "review") {
			debug("User chose to review code");
			await runCodeReview();
		}
	}
}
