import Groq from "groq-sdk"
import { debug } from "../utils/debug.js"
import { createProvider, formatProviderName, type ProviderName } from "./provider.js"

const MAX_DIFF_CHARS = 20000

export function mapGroqError(error: unknown, providerLabel?: string): Error {
	const label = providerLabel ?? "Groq"
	if (error instanceof Groq.AuthenticationError) {
		return new Error(
			`Invalid API key for ${label}. Run: cmint config set ${label.toUpperCase()}_API_KEY=<key>`,
		)
	}
	if (error instanceof Groq.RateLimitError) {
		return new Error(`Rate limited by ${label}. Please wait and try again.`)
	}
	if (error instanceof Groq.APIConnectionTimeoutError) {
		return new Error("Request timed out. Check your network or try a smaller diff.")
	}
	if (error instanceof Groq.APIError) {
		return new Error(`${label} API error: ${error.message}`)
	}
	// Handle errors from the generic fetch client (non-Groq providers)
	if (error instanceof Error && /^4\d{2}\s/.test(error.message)) {
		return new Error(`${label} API error: ${error.message}`)
	}
	return new Error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`)
}

const CONVENTIONAL_COMMIT_REGEX =
	/^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\(.+\))?!?: .+$/

export function stripThinkTags(text: string): string {
	return text.replace(/<think[\s\S]*?<\/think>/gi, "").trim()
}

export function deriveMessageFromReasoning(reasoning: string): string | null {
	const match = reasoning.match(
		/(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\(.+\))?!?: .+/i,
	)
	if (match) return match[0].trim()

	const sentences = reasoning.split(/[.!?]/)
	const first = sentences.find((s) => s.trim().length >= 10)
	return first ? first.trim() : null
}

function stripContextLines(diff: string): string {
	return diff
		.split("\n")
		.filter((line) => !line.startsWith(" "))
		.join("\n")
}

export function compressDiff(diff: string): string {
	// Tier 0 — Full diff
	if (diff.length <= MAX_DIFF_CHARS) {
		return diff
	}

	// Tier 1 — Strip context lines
	let result = stripContextLines(diff)
	if (result.length <= MAX_DIFF_CHARS) {
		return result
	}

	// Tier 2 — Per-hunk line cap
	const fileDiffs = result.split(/(?=diff --git)/).filter(Boolean)
	const cappedFiles = fileDiffs.map((fd) => {
		const parts = fd.split(/(?=\n@@)/)
		const cappedParts = parts.map((part, idx) => {
			if (idx === 0) return part // Keep file header
			const lines = part.split("\n")
			const header = lines[0] // @@ line
			const changedLines = lines.slice(1).filter((l) => l.startsWith("+") || l.startsWith("-"))
			const keptLines = changedLines.slice(0, 10)
			return [header, ...keptLines].join("\n")
		})
		return cappedParts.join("")
	})
	result = cappedFiles.join("")
	if (result.length <= MAX_DIFF_CHARS) {
		return result
	}

	// Tier 3 — File summary
	const fileMatches = diff.match(/^diff --git a\/(.+) b\/(.+)$/gm) || []
	const summary = fileMatches
		.map((f) => {
			const match = f.match(/^diff --git a\/(.+) b\/(.+)$/)
			return match && match[1] === match[2] ? `${match[1]} | changed` : ""
		})
		.filter(Boolean)
	return `Summary of changes:\n${summary.join("\n")}`
}

export function buildStatSummary(diff: string): string {
	const files: { name: string; adds: number; dels: number }[] = []
	let currentFile = ""
	let adds = 0
	let dels = 0

	for (const line of diff.split("\n")) {
		const match = line.match(/^diff --git a\/.+ b\/(.+)$/)
		if (match) {
			if (currentFile) files.push({ name: currentFile, adds, dels })
			currentFile = match[1]
			adds = 0
			dels = 0
		} else if (line.startsWith("+") && !line.startsWith("+++")) {
			adds++
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			dels++
		}
	}
	if (currentFile) files.push({ name: currentFile, adds, dels })

	const totalAdds = files.reduce((s, f) => s + f.adds, 0)
	const totalDels = files.reduce((s, f) => s + f.dels, 0)

	const lines = files.map((f) => ` ${f.name}  | +${f.adds} -${f.dels}`)
	lines.push(
		` ${files.length} files changed, ${totalAdds} insertions(+), ${totalDels} deletions(-)`,
	)

	return lines.join("\n")
}

function buildSystemPrompt(type?: string): string {
	let prompt =
		"You are a commit message generator. Follow the Conventional Commits specification.\n" +
		"Valid types: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test.\n" +
		"Format: type(scope): description\n" +
		"Use imperative mood, lowercase, no trailing period.\n" +
		"Output a SINGLE commit message, one line only. No markdown fences, no explanation."

	if (type && type.trim().length > 0) {
		prompt += `\nYou MUST use type: ${type}`
	}

	return prompt
}

function buildUserPrompt(diff: string, hint?: string, statSummary?: string): string {
	const parts: string[] = []
	if (hint) parts.push(`Context: ${hint}`)
	if (statSummary) parts.push(`Change summary:\n${statSummary}`)
	parts.push(`Generate a conventional commit for:\n\n${diff}`)
	return parts.join("\n\n")
}

function isValidConventionalCommit(message: string): boolean {
	return CONVENTIONAL_COMMIT_REGEX.test(message)
}

export function extractContentText(
	content: string | Array<{ type: string; text?: string }> | null | undefined,
): string {
	if (content == null) return ""
	if (typeof content === "string") return content.trim()
	if (Array.isArray(content)) {
		return content
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => stripThinkTags(part.text as string))
			.join("")
			.trim()
	}
	return ""
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: AI pipeline — prompt build, call, validate, retry, error mapping
export async function generateCommitMessage(
	diff: string,
	options: {
		apiKey: string
		model?: string
		type?: string
		timeout?: number
		hint?: string
		provider?: ProviderName
		proxy?: string
	},
): Promise<string> {
	const timeoutMs = options.timeout ?? 60000
	debug("Timeout: %d ms", timeoutMs)

	const { client, model } = createProvider({
		provider: options.provider ?? "groq",
		apiKey: options.apiKey,
		modelOverride: options.model,
		timeout: timeoutMs,
		baseURLOverride: options.proxy,
	})

	debug(
		"generateCommitMessage: model=%s, type=%s, hint=%s",
		model,
		options.type ?? "none",
		options.hint ?? "none",
	)

	const compressedDiff = compressDiff(diff)
	const statSummary = buildStatSummary(diff)
	const systemPrompt = buildSystemPrompt(options.type)
	const userPrompt = buildUserPrompt(compressedDiff, options.hint, statSummary)

	debug("Diff: %d chars → compressed to %d chars", diff.length, compressedDiff.length)
	debug("Stat summary:\n%s", statSummary)
	debug("User prompt length: %d chars", userPrompt.length)

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Error class instanceof chain for API error mapping
	// biome-ignore lint/complexity/noExcessiveLinesPerFunction: API call with streaming, error handling, and retry
	async function callAI(strictSystemPrompt?: string): Promise<string> {
		const callStart = Date.now()
		const isRetry = !!strictSystemPrompt
		debug(
			"callAI: %s — model=%s, promptLen=%d, systemLen=%d",
			isRetry ? "RETRY (strict)" : "INITIAL",
			model,
			userPrompt.length,
			(strictSystemPrompt ?? systemPrompt).length,
		)
		try {
			const isReasoningModel = /^(o[1-9]|.*gpt-oss.*|.*gpt-5.*)/i.test(model)
			const isGroq = (options.provider ?? "groq") === "groq"
			const completion = await client.chat.completions.create({
				messages: [
					{ role: "system", content: strictSystemPrompt ?? systemPrompt },
					{ role: "user", content: userPrompt },
				],
				model,
				temperature: 0.3,
				...(isReasoningModel ? { max_completion_tokens: 1024 } : { max_tokens: 1024 }),
				...(isGroq && isReasoningModel ? { reasoning_format: "parsed" } : {}),
			})

			const elapsed = Date.now() - callStart
			const rawContent = completion.choices[0]?.message?.content
			const processedContent =
				typeof rawContent === "string" ? stripThinkTags(rawContent) : rawContent
			const content = extractContentText(processedContent)
			debug(
				"callAI response (%d ms): choices=%d, finishReason=%s, contentLen=%d, rawType=%s",
				elapsed,
				completion.choices.length,
				completion.choices[0]?.finish_reason ?? "(none)",
				content.length,
				typeof rawContent,
			)
			debug("callAI raw content: %s", content.slice(0, 300) || "(empty)")
			if (!content) {
				const reasoning = completion.choices[0]?.message?.reasoning
				debug(
					"callAI: content empty, attempting reasoning fallback (reasoningLen=%d)",
					reasoning?.length ?? 0,
				)
				if (reasoning) {
					const derived = deriveMessageFromReasoning(reasoning)
					if (derived) {
						debug("callAI: derived message from reasoning: %s", derived.slice(0, 100))
						return stripThinkTags(derived)
					}
					debug("callAI: could not derive message from reasoning")
				}
				throw new Error("AI returned an empty commit message")
			}
			return content
		} catch (error) {
			const elapsed = Date.now() - callStart
			debug(
				"callAI FAILED after %d ms: %s",
				elapsed,
				error instanceof Error ? `${error.name}: ${error.message}` : String(error),
			)
			throw error
		}
	}

	try {
		const totalStart = Date.now()
		let message = await callAI()
		debug(
			"Validation: message=%s, isValid=%s",
			message.slice(0, 100),
			isValidConventionalCommit(message),
		)

		if (!isValidConventionalCommit(message)) {
			debug(
				"Initial message failed conventional commit validation, retrying with strict prompt (elapsed: %d ms)",
				Date.now() - totalStart,
			)
			const retryMessage = await callAI(
				"You MUST output ONLY a valid conventional commit message. " +
					"Format: type(scope): description. " +
					"If you output anything else your response will be rejected.\n" +
					"Output a SINGLE commit message, one line only.\n" +
					"Valid types: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test.",
			)
			debug(
				"Retry validation: message=%s, isValid=%s",
				retryMessage.slice(0, 100),
				isValidConventionalCommit(retryMessage),
			)
			if (isValidConventionalCommit(retryMessage)) {
				debug("Retry produced valid conventional commit")
				message = retryMessage
			} else {
				debug("Retry also failed validation, using original message")
			}
		}

		debug("Final message (%d ms total): %s", Date.now() - totalStart, message)
		return message
	} catch (error) {
		debug("AI error: %s", error instanceof Error ? error.message : String(error))
		const providerLabel = options.provider ? formatProviderName(options.provider) : undefined
		throw mapGroqError(error, providerLabel)
	}
}
