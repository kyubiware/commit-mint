import * as p from "@clack/prompts";
import { bold, cyan, dim, green, red, yellow } from "kolorist";
import { copyToClipboard } from "../services/clipboard.js";
import type { ChangedFile } from "../services/git.js";
import type { HookError } from "../services/hooks.js";
import { debug } from "../utils/debug.js";

export type RecoveryResult = "committed" | "cancelled" | "failed";

export interface StagingChoice {
	files: string[]; // selected file paths to stage
	all: boolean; // whether user chose "Stage all"
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Staging menu with file list display + multiselect fallback
export async function showStagingMenu(
	files: ChangedFile[],
	hasLintStaged: boolean,
): Promise<StagingChoice | "autogroup" | "lint-staged" | null> {
	debug("showStagingMenu: %d files", files.length);

	// Build status labels with kolorist colors
	const statusLabel = (status: string): string => {
		switch (status) {
			case "M":
				return yellow("M");
			case "A":
				return green("A");
			case "D":
				return red("D");
			case "?":
			case "??":
				return cyan("?");
			default:
				return dim(status);
		}
	};

	// Sort: staged files first, then unstaged
	const sorted = [...files].sort((a, b) => {
		if (a.staged !== b.staged) return a.staged ? -1 : 1;
		return a.path.localeCompare(b.path);
	});

	// Show file list grouped by staged status
	const stagedFiles = sorted.filter((f) => f.staged);
	const unstagedFiles = sorted.filter((f) => !f.staged);
	const lines: string[] = [];
	if (stagedFiles.length > 0) {
		lines.push(
			green(bold("Staged:")),
			...stagedFiles.map((f) => `  ${statusLabel(f.status)}  ${f.path}`),
		);
	}
	if (unstagedFiles.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push(
			yellow(bold("Changed:")),
			...unstagedFiles.map((f) => `  ${statusLabel(f.status)}  ${f.path}`),
		);
	}
	p.note(lines.join("\n"), `${files.length} file${files.length !== 1 ? "s" : ""}`);

	const choice = await p.select({
		message: "Stage files for commit:",
		options: [
			{
				label: "Auto-group into commits",
				value: "autogroup",
				hint: "LLM groups files into logical commits",
			},
			{
				label: "Stage all files",
				value: "all",
				hint: `${files.length} file${files.length !== 1 ? "s" : ""}`,
			},
			...(hasLintStaged
				? [
						{
							label: "Run lint-staged checks",
							value: "lint-staged" as const,
							hint: "Pre-flight checks on all changed files",
						},
					]
				: []),
			{ label: "Select files...", value: "select" },
			{ label: "Cancel", value: "cancel" },
		],
	});

	if (p.isCancel(choice) || choice === "cancel") {
		return null;
	}

	if (choice === "autogroup") {
		return "autogroup";
	}

	if (choice === "lint-staged") {
		return "lint-staged";
	}

	if (choice === "all") {
		return { files: files.map((f) => f.path), all: true };
	}

	// Multi-select
	const selected = await p.multiselect({
		message: "Select files to stage:",
		options: sorted.map((f) => ({
			label: `${statusLabel(f.status)}  ${f.path}`,
			value: f.path,
		})),
		required: true,
	});

	if (p.isCancel(selected)) {
		return null;
	}

	return { files: selected as string[], all: false };
}

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
	debug("showRecoveryMenu: %d errors", errors.length);

	let clipboardCopied = false;
	let showNote = true;

	while (true) {
		if (showNote) {
			p.note(
				errors.map((e) => `  ${red("•")} [${e.tool}] ${e.message}`).join("\n"),
				red(bold("Pre-commit hook failed")),
			);
			showNote = false;
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
		});

		if (p.isCancel(choice)) {
			debug("showRecoveryMenu: user cancelled");
			p.outro(yellow("Cancelled. Message cached for --retry."));
			return "cancelled";
		}

		debug("showRecoveryMenu: user chose %s", choice);

		switch (choice) {
			case "clipboard": {
				const ok = await copyToClipboard(rawStderr);
				if (ok) {
					clipboardCopied = true;
					p.log.step(green("Copied to clipboard."));
				} else {
					p.log.warn(red("No clipboard tool found. Install xclip, wl-copy, or xsel."));
				}
				continue;
			}
			case "view": {
				p.note(rawStderr.trim() || "(no raw output)", "Full error output");
				showNote = true;
				continue;
			}
			case "skip": {
				p.log.info(yellow("Committing with --no-verify..."));
				const ok = await onSkipHooks(message);
				if (ok) {
					p.outro(green("Committed (hooks skipped)."));
					return "committed";
				} else {
					p.outro(red("Commit failed even with --no-verify."));
					return "failed";
				}
			}
			case "restage": {
				p.log.info(cyan("Re-staging and retrying..."));
				const ok = await onRestage();
				if (ok) {
					p.outro(green("Committed successfully."));
					return "committed";
				}
				// Re-show errors after failed restage for context
				showNote = true;
				continue;
			}
			case "edit": {
				const edited = await p.text({
					message: "Edit commit message:",
					initialValue: message,
					validate: (v) => (v?.trim() ? undefined : "Message cannot be empty"),
				});
				if (p.isCancel(edited)) {
					p.outro(yellow("Cancelled. Message cached for --retry."));
					return "cancelled";
				}
				const ok = await onRetry();
				if (ok) {
					p.outro(green("Committed successfully."));
					return "committed";
				} else {
					p.outro(red("Commit failed again."));
					return "failed";
				}
			}
			case "cancel": {
				p.outro(dim("Message cached for --retry."));
				return "cancelled";
			}
		}
	}
}
