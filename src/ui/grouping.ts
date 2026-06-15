import * as p from "@clack/prompts"
import { bold, cyan, dim, green, red, yellow } from "kolorist"
import type { ChangedFile } from "../services/git.js"
import type { CommitGroup } from "../services/grouping.js"
import { debug } from "../utils/debug.js"

export async function showGroupingConfirmation(
	groups: CommitGroup[],
	excluded: string[],
): Promise<boolean> {
	debug("showGroupingConfirmation: %d groups, %d excluded", groups.length, excluded.length)

	const lines: string[] = []

	for (const group of groups) {
		lines.push(bold(group.name))
		lines.push(`  ${dim(group.description)}`)
		lines.push(`  ${green(String(group.files.length))} file${group.files.length !== 1 ? "s" : ""}`)
		for (const file of group.files) {
			lines.push(`    ${dim("•")} ${file}`)
		}
		lines.push("")
	}

	if (excluded.length > 0) {
		lines.push(dim(`Excluded: ${excluded.length} file${excluded.length !== 1 ? "s" : ""}`))
		for (const file of excluded) {
			lines.push(`  ${dim("•")} ${dim(file)}`)
		}
	}

	p.note(lines.join("\n"), "Proposed commit groups")

	const choice = await p.select({
		message: "Proceed with these groupings?",
		options: [
			{ label: "Yes, commit all groups", value: "yes" },
			{ label: "No, cancel", value: "no" },
		],
	})

	if (p.isCancel(choice) || choice === "no") {
		debug("showGroupingConfirmation: user cancelled")
		return false
	}

	debug("showGroupingConfirmation: user confirmed")
	return true
}

export function showGroupProgress(current: number, total: number, groupName: string): void {
	p.log.info(`Commit group ${current} of ${total}: ${cyan(`"${groupName}"`)}`)
}

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

/** Display a table of changed files with status indicators */
export function showChangedFilesTable(files: ChangedFile[]): void {
	if (files.length === 0) return

	const lines = files.map((f) => `  ${statusLabel(f.status)}  ${f.path}`)
	p.note(lines.join("\n"), `${files.length} file${files.length !== 1 ? "s" : ""} changed`)
}

/** Display a compact grouping summary (only shown when >1 group) */
export function showGroupingSummary(groups: CommitGroup[]): void {
	if (groups.length <= 1) return

	const lines = groups.map(
		(g) => `${bold(g.name)} ${dim("—")} ${g.files.length} file${g.files.length !== 1 ? "s" : ""}`,
	)
	p.note(lines.join("\n"), "Commit groups")
}

/** Display combined view: files with status indicators grouped by commit group */
export function showGroupedFiles(groups: CommitGroup[], changedFiles: ChangedFile[]): void {
	const statusMap = new Map(changedFiles.map((f) => [f.path, f.status]))

	const lines: string[] = []

	for (let i = 0; i < groups.length; i++) {
		const group = groups[i]
		lines.push(
			`${bold(group.name)} ${dim("—")} ${group.files.length} file${group.files.length !== 1 ? "s" : ""}`,
		)
		for (const file of group.files) {
			const status = statusMap.get(file) ?? "M"
			lines.push(`  ${statusLabel(status)}  ${file}`)
		}
		if (i < groups.length - 1) {
			lines.push("")
		}
	}

	p.note(lines.join("\n"), "Commit groups")
}
