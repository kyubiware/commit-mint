import { debug } from "../utils/debug.js"
import { mapGroqError } from "./ai.js"
import type { ChangedFile } from "./git.js"
import { getDefaultExcludes } from "./git.js"
import { type CommitGroup, parseGroupingResponse } from "./grouping-parser.js"
import { reuniteTestsWithSources } from "./grouping-reunite.js"
import {
	type ChatClient,
	createProvider,
	formatProviderName,
	type ProviderName,
} from "./provider.js"

export type { CommitGroup } from "./grouping-parser.js"
export { reuniteTestsWithSources } from "./grouping-reunite.js"

export interface GroupingResult {
	groups: CommitGroup[]
	excluded: string[]
}

function matchesExcludePattern(filePath: string, pattern: string): boolean {
	if (pattern === filePath) return true
	if (pattern.endsWith("/**")) {
		const prefix = pattern.slice(0, -3)
		return filePath === prefix || filePath.startsWith(`${prefix}/`)
	}
	if (pattern.startsWith("*.")) {
		const suffix = pattern.slice(1)
		return filePath.endsWith(suffix)
	}
	return false
}

/** Lockfiles that should be kept when their companion manifest is present */
const LOCKFILE_COMPANIONS: Record<string, string> = {
	"package-lock.json": "package.json",
	"pnpm-lock.yaml": "package.json",
	"yarn.lock": "package.json",
	"bun.lock": "package.json",
	"bun.lockb": "package.json",
}

export function filterExcludedFiles(files: ChangedFile[]): {
	included: ChangedFile[]
	excluded: string[]
} {
	const patterns = getDefaultExcludes()
	const included: ChangedFile[] = []
	const excluded: ChangedFile[] = []
	const filePaths = new Set(files.map((f) => f.path))

	for (const file of files) {
		const isExcluded = patterns.some((pattern) => matchesExcludePattern(file.path, pattern))
		if (isExcluded) {
			excluded.push(file)
		} else {
			included.push(file)
		}
	}

	// Promote lockfiles whose companion manifest is present
	const stillExcluded: string[] = []
	for (const file of excluded) {
		const companion = LOCKFILE_COMPANIONS[file.path]
		if (companion && filePaths.has(companion)) {
			included.push(file)
		} else {
			stillExcluded.push(file.path)
		}
	}

	debug("filterExcludedFiles: %d included, %d excluded", included.length, stillExcluded.length)
	return { included, excluded: stillExcluded }
}

function statusIndicator(status: string): string {
	switch (status) {
		case "M":
			return "modified"
		case "A":
			return "added"
		case "D":
			return "deleted"
		case "R":
			return "renamed"
		case "C":
			return "copied"
		case "?":
		case "??":
			return "untracked"
		default:
			return "changed"
	}
}

export function buildFileSummary(files: ChangedFile[]): string {
	return files.map((f) => `${f.path} (${statusIndicator(f.status)})`).join("\n")
}

export function buildGroupingSystemPrompt(groupCount?: number): string {
	const lines = [
		"You are analyzing changed files in a git repository. Group them into logical commits based on what changed and why. Each group should be a coherent unit of work.",
		"",
		"Rules:",
		"- ALWAYS keep a test file in the same group as the source file it tests. Examples: `foo.test.ts` stays with `foo.ts`; `__tests__/foo.test.ts` stays with `foo.ts` in the parent directory; `tests/foo.test.ts` stays with `src/foo.ts`. Never put source and its tests in separate groups.",
		"- Group by feature, fix, or concern (e.g., 'Frontend refactor', 'API changes')",
		"- Keep related files together (e.g., a component + its test, a model + its migration)",
		"- Separate documentation changes (*.md files, docs/) from code changes — put docs in their own group",
		"- Do not split a single logical change across multiple groups",
		"- If a file does not clearly belong to any group, include it anyway — do not omit files",
		"",
		"Output format: JSON array of objects with keys 'name', 'description', 'files'.",
		"name: short label (3-5 words)",
		"description: 1-2 sentences explaining what this group changes",
		"files: array of exact file paths from the input",
		"",
		"Output ONLY valid JSON. No markdown fences, no explanation.",
	]

	if (groupCount && groupCount > 0) {
		lines.unshift(`Create exactly ${groupCount} groups.`)
	}

	return lines.join("\n")
}

function buildGroupingUserPrompt(summary: string): string {
	return ["Group the following changed files into logical commits:", "", summary].join("\n")
}

export function buildRetryGroupingPrompt(groupCount?: number): string {
	const lines = [
		"PREVIOUS ATTEMPT FAILED: You grouped all files into a single group.",
		"",
		"You MUST split the files into at least 2 groups based on what changed and why.",
		"",
		"Look for these natural split points:",
		"- Different features or modules (e.g., different directories)",
		"- New files vs modified files vs deleted files",
		"- Configuration changes vs code changes",
		"- Documentation vs implementation",
		"",
		"Do NOT split a source file from its tests — keep `foo.ts` and `foo.test.ts` in the same group.",
		"",
		"If unsure, err on the side of MORE groups, not fewer.",
		"",
		"Output format: JSON array of objects with keys 'name', 'description', 'files'.",
		"name: short label (3-5 words)",
		"description: 1-2 sentences explaining what this group changes",
		"files: array of exact file paths from the input",
		"",
		"Output ONLY valid JSON. No markdown fences, no explanation.",
	]

	if (groupCount && groupCount > 0) {
		lines[0] = "PREVIOUS ATTEMPT FAILED: You created the wrong number of groups."
		lines[2] = `You MUST create exactly ${groupCount} groups. Do not create more or fewer.`
	}

	return lines.join("\n")
}

/**
 * When a specific group count is requested but there are fewer included files
 * than groups, create one-file-per-group groups without calling the AI.
 * Returns null when the pre-condition is not met.
 */
function createPerFileGroups(
	files: ChangedFile[],
	groupCount: number | undefined,
	excluded: string[],
): GroupingResult | null {
	if (!(groupCount && groupCount > 0 && files.length < groupCount)) return null
	debug(
		"generateGroups: %d files < %d requested groups, creating per-file groups",
		files.length,
		groupCount,
	)
	return {
		groups: files.map((f) => ({
			name: f.path.split("/").pop() || f.path,
			description: `Changes to ${f.path}`,
			files: [f.path],
		})),
		excluded,
	}
}

export async function generateGroups(
	files: ChangedFile[],
	apiKey: string,
	model?: string,
	timeout?: number,
	provider?: ProviderName,
	proxy?: string,
	groupCount?: number,
): Promise<GroupingResult> {
	debug("generateGroups: %d files, model=%s", files.length, model ?? "default")

	const { included, excluded } = filterExcludedFiles(files)

	if (included.length === 0) {
		debug("generateGroups: no files to group after exclusion")
		return { groups: [], excluded }
	}

	const perFile = createPerFileGroups(included, groupCount, excluded)
	if (perFile) return perFile

	const summary = buildFileSummary(included)
	const systemPrompt = buildGroupingSystemPrompt(groupCount)
	const userPrompt = buildGroupingUserPrompt(summary)

	debug("File summary:\n%s", summary)
	debug("User prompt length: %d chars", userPrompt.length)

	const timeoutMs = timeout ?? 60000
	const { client, model: resolvedModel } = createProvider({
		provider: provider ?? "groq",
		apiKey,
		modelOverride: model,
		timeout: timeoutMs,
		baseURLOverride: proxy,
	})

	try {
		let rawGroups = await callGroupingAI(client, resolvedModel, systemPrompt, userPrompt)
		debug("generateGroups: parsed %d raw groups", rawGroups.length)
		let validated = validateGroups(rawGroups, included)
		debug("generateGroups: %d validated groups", validated.length)

		// Retry once if grouping quality is low. Evaluate against the raw AI result:
		// validateGroups() silently adds an "Other changes" group for any ungrouped
		// files, which would mask an empty model response (turning [] into a single
		// catch-all) and skip the retry the user needs.
		if (isLowQualityGrouping(rawGroups, included, groupCount)) {
			debug("generateGroups: low quality result, retrying with stricter prompt")
			const retryPrompt = buildRetryGroupingPrompt(groupCount)
			rawGroups = await callGroupingAI(client, resolvedModel, retryPrompt, userPrompt)
			debug("generateGroups retry: parsed %d raw groups", rawGroups.length)
			validated = validateGroups(rawGroups, included)
			debug("generateGroups retry: %d validated groups", validated.length)
		}

		return { groups: validated, excluded }
	} catch (error) {
		debug("generateGroups error: %s", error instanceof Error ? error.message : String(error))
		const providerLabel = provider ? formatProviderName(provider) : undefined
		throw mapGroqError(error, providerLabel)
	}
}

async function callGroupingAI(
	client: ChatClient,
	model: string,
	systemPrompt: string,
	userPrompt: string,
): Promise<CommitGroup[]> {
	const completion = (await client.chat.completions.create({
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: userPrompt },
		],
		model,
		temperature: 0.3,
		max_tokens: 2048,
	})) as { choices: { message?: { content?: string }; finish_reason?: string }[] }

	const rawContent = completion.choices[0]?.message?.content
	const content = typeof rawContent === "string" ? rawContent.trim() : ""

	debug(
		"callGroupingAI response: choices=%d, finishReason=%s, contentLen=%d",
		completion.choices.length,
		completion.choices[0]?.finish_reason ?? "(none)",
		content.length,
	)
	debug("callGroupingAI raw content: %s", content.slice(0, 500) || "(empty)")

	if (!content) {
		throw new Error("AI returned an empty grouping response")
	}

	return parseGroupingResponse(content)
}

/** Minimum file count where a single-group result is considered low quality */
const MIN_FILES_FOR_QUALITY_CHECK = 5

export function isLowQualityGrouping(
	groups: CommitGroup[],
	allFiles: ChangedFile[],
	groupCount?: number,
): boolean {
	// No files to group → empty grouping is the correct result, not low quality.
	if (allFiles.length === 0) return false
	// Files were provided but the model returned no groups — retry once before
	// falling back to "Other changes" so the user still gets a sensible commit.
	if (groups.length === 0) return true
	// When the user requested a specific number of groups and the model produced
	// a different count, retry with a prompt that reinforces the target count.
	if (groupCount && groupCount > 0 && groups.length !== groupCount) return true
	if (allFiles.length < MIN_FILES_FOR_QUALITY_CHECK) return false
	return groups.length === 1
}

export function validateGroups(groups: CommitGroup[], allFiles: ChangedFile[]): CommitGroup[] {
	const validPaths = new Set(allFiles.map((f) => f.path))
	const seen = new Set<string>()
	const validated: CommitGroup[] = []

	for (const group of groups) {
		const uniqueFiles = group.files.filter((f) => {
			if (!validPaths.has(f)) return false // AI-hallucinated path
			if (seen.has(f)) return false // duplicate across groups
			seen.add(f)
			return true
		})

		if (uniqueFiles.length > 0) {
			validated.push({
				name: group.name,
				description: group.description,
				files: uniqueFiles,
			})
		}
	}

	// Move misplaced test files back into their source file's group. Done after
	// path filtering (so hallucinated tests don't trigger moves) and before
	// orphan bucketing (so a source-less test still gets caught by "Other
	// changes"). `seen` is unaffected by inter-group moves.
	const reunited = reuniteTestsWithSources(validated)
	if (reunited !== validated) {
		debug("validateGroups: reunited %d groups after test/source merge", reunited.length)
	}

	// Find files not in any group
	const ungrouped = allFiles.filter((f) => !seen.has(f.path))

	if (ungrouped.length > 0) {
		debug("validateGroups: %d ungrouped files added to 'Other changes'", ungrouped.length)
		reunited.push({
			name: "Other changes",
			description: "Miscellaneous changes that did not fit into other groups",
			files: ungrouped.map((f) => f.path),
		})
	}

	return reunited
}
