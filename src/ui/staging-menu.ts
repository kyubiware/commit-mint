import * as p from "@clack/prompts";
import { bold, cyan, dim, green, red, yellow } from "kolorist";
import type { ChangedFile } from "../services/git.js";
import { debug } from "../utils/debug.js";

export interface StagingChoice {
	files: string[]; // selected file paths to stage
	all: boolean; // whether user chose "Stage all"
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Staging menu with conditional options + multiselect fallback
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Staging menu with file list display + multiselect fallback
export async function showStagingMenu(
	files: ChangedFile[],
	hasChecks: boolean,
): Promise<StagingChoice | "autogroup" | "checks" | "staged" | null> {
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
			...(stagedFiles.length > 0
				? [
						{
							label: "Commit staged files only",
							value: "staged" as const,
							hint: `${stagedFiles.length} file${stagedFiles.length !== 1 ? "s" : ""} already staged`,
						},
					]
				: []),
			{
				label: "Stage all files",
				value: "all",
				hint: `${files.length} file${files.length !== 1 ? "s" : ""}`,
			},
			...(hasChecks
				? [
						{
							label: "Run checks",
							value: "checks" as const,
							hint: "Pre-flight checks from cmint config",
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

	if (choice === "checks") {
		return "checks";
	}

	if (choice === "staged") {
		return "staged";
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
