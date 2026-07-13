import * as p from "@clack/prompts"
import { bold, cyan, dim, green, red, yellow } from "kolorist"
import { getAutoAccept, setAutoAccept } from "../services/auto-accept.js"
import type { ChangedFile } from "../services/git.js"
import { getRunChecks, setRunChecks } from "../services/run-checks.js"
import { debug } from "../utils/debug.js"
import { fileMultiSelect } from "./file-multiselect.js"
import { selectWithToggles, type ToggleOption } from "./toggle-select.js"

export interface StagingChoice {
	files: string[] // selected file paths to stage
	all: boolean // whether user chose "Stage all"
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Staging menu with conditional options + multiselect fallback
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: Staging menu with file list display + multiselect fallback
export async function showStagingMenu(
	files: ChangedFile[],
	hasChecks: boolean,
): Promise<StagingChoice | "autogroup" | "checks" | "staged" | null> {
	debug("showStagingMenu: %d files", files.length)

	// Build status labels with kolorist colors
	const statusLabel = (status: string): string => {
		switch (status) {
			case "M":
				return yellow("M")
			case "A":
				return green("A")
			case "D":
				return red("D")
			case "?":
			case "??":
				return cyan("?")
			default:
				return dim(status)
		}
	}

	// Sort: staged files first, then unstaged
	const sorted = [...files].sort((a, b) => {
		if (a.staged !== b.staged) return a.staged ? -1 : 1
		return a.path.localeCompare(b.path)
	})

	// Show file list grouped by staged status
	const stagedFiles = sorted.filter((f) => f.staged)
	const unstagedFiles = sorted.filter((f) => !f.staged)
	const lines: string[] = []
	if (stagedFiles.length > 0) {
		lines.push(
			green(bold("Staged:")),
			...stagedFiles.map((f) => `  ${statusLabel(f.status)}  ${f.path}`),
		)
	}
	if (unstagedFiles.length > 0) {
		if (lines.length > 0) lines.push("")
		lines.push(
			yellow(bold("Changed:")),
			...unstagedFiles.map((f) => `  ${statusLabel(f.status)}  ${f.path}`),
		)
	}
	p.note(lines.join("\n"), `${files.length} file${files.length !== 1 ? "s" : ""}`)

	const initialAutoAccept = await getAutoAccept()
	debug("showStagingMenu: initial auto-accept=%s", initialAutoAccept)

	// Only register the run-checks toggle when .cmintrc is present — without
	// a config, there's nothing to run, and showing the toggle would be
	// misleading.
	const initialRunChecks = hasChecks ? await getRunChecks() : true
	debug("showStagingMenu: initial run-checks=%s", initialRunChecks)

	const toggles: ToggleOption[] = [
		{
			key: "autoAccept",
			hotkey: "a",
			label: "Auto-accept",
			icon: "⚡",
			initial: initialAutoAccept,
			onToggle: (next) => setAutoAccept(next),
		},
		...(hasChecks
			? [
					{
						key: "runChecks",
						hotkey: "c",
						label: "Pre-commit checks",
						icon: "🛡",
						initial: initialRunChecks,
						onToggle: (next) => setRunChecks(next),
					} satisfies ToggleOption,
				]
			: []),
	]

	const selectResult = await selectWithToggles<
		"autogroup" | "all" | "checks" | "staged" | "select" | "cancel"
	>({
		message: "Stage files for commit:",
		toggles,
		options: [
			// "Auto-group into commits" only makes sense with multiple files —
			// one file is already its own group.
			...(files.length > 1
				? [
						{
							label: "Auto-group into commits",
							value: "autogroup" as const,
							hint: "LLM groups files into logical commits",
						},
					]
				: []),
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
			// "Select files..." is redundant when there's only one file — "Stage all" covers it.
			...(files.length > 1 ? [{ label: "Select files...", value: "select" as const }] : []),
			{ label: "Cancel", value: "cancel" },
		],
	})

	if (typeof selectResult === "symbol") {
		debug("showStagingMenu: user cancelled (clack cancel symbol)")
		return null
	}

	const choice = selectResult.value
	debug(
		"showStagingMenu: choice=%s autoAccept=%s runChecks=%s",
		choice,
		selectResult.toggles.autoAccept,
		selectResult.toggles.runChecks,
	)

	if (p.isCancel(choice) || choice === "cancel") {
		return null
	}

	if (choice === "autogroup") {
		return "autogroup"
	}

	if (choice === "checks") {
		return "checks"
	}

	if (choice === "staged") {
		return "staged"
	}

	if (choice === "all") {
		return { files: files.map((f) => f.path), all: true }
	}

	// Multi-select
	const selected = await fileMultiSelect(
		"Select files to stage:",
		sorted.map((f) => ({
			label: `${statusLabel(f.status)}  ${f.path}`,
			value: f.path,
		})),
		{
			required: true,
			initialValues: sorted.filter((f) => f.staged).map((f) => f.path),
		},
	)

	if (p.isCancel(selected)) {
		return null
	}

	return { files: selected as string[], all: false }
}
