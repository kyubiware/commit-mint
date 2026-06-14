export interface CommitGroup {
	name: string;
	description: string;
	files: string[];
}

interface ScanState {
	objects: unknown[];
	depth: number;
	start: number;
}

/** Coerce a parsed value into a CommitGroup, or null if it doesn't match the shape. */
function coerceGroup(item: unknown): CommitGroup | null {
	if (
		typeof item === "object" &&
		item !== null &&
		"name" in item &&
		"description" in item &&
		"files" in item &&
		Array.isArray((item as Record<string, unknown>).files)
	) {
		const obj = item as Record<string, unknown>;
		return {
			name: String(obj.name),
			description: String(obj.description),
			files: (obj.files as unknown[]).filter((f) => typeof f === "string") as string[],
		};
	}
	return null;
}

/** Return the index of the closing quote of a string starting at text[start] === '"'. */
function skipString(text: string, start: number): number {
	let i = start + 1;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === '"') return i;
		i++;
	}
	return i;
}

function openBrace(state: ScanState, index: number): void {
	if (state.depth === 0) state.start = index;
	state.depth++;
}

function pushParsedObject(objects: unknown[], candidate: string): void {
	try {
		objects.push(JSON.parse(candidate));
	} catch {
		// Not valid JSON — skip this candidate.
	}
}

function closeBrace(state: ScanState, text: string, index: number): void {
	if (state.depth === 0) return;
	state.depth--;
	if (state.depth === 0 && state.start !== -1) {
		pushParsedObject(state.objects, text.slice(state.start, index + 1));
		state.start = -1;
	}
}

/**
 * Scan for top-level `{...}` objects, respecting string literals and escapes.
 * Used to recover groups when the model emits a single object or concatenated
 * objects instead of the requested JSON array.
 */
function extractTopLevelObjects(text: string): unknown[] {
	const state: ScanState = { objects: [], depth: 0, start: -1 };
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		// Skip string literals so braces/quotes inside them don't affect depth.
		if (ch === '"') {
			i = skipString(text, i);
			continue;
		}
		if (ch === "{") {
			openBrace(state, i);
			continue;
		}
		if (ch === "}") {
			closeBrace(state, text, i);
		}
	}
	return state.objects;
}

export function parseGroupingResponse(content: string): CommitGroup[] {
	// Strip think tags from reasoning models
	let cleaned = content.replace(/<think[\s\S]*?<\/think>/gi, "").trim();
	// Strip markdown code fences
	cleaned = cleaned
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();

	// Path 1: extract the outermost JSON array — handles text before/after the array,
	// markdown fences, and trailing explanation prose.
	const start = cleaned.indexOf("[");
	const end = cleaned.lastIndexOf("]");
	if (start !== -1 && end !== -1 && end > start) {
		try {
			const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
			if (Array.isArray(parsed)) {
				const groups = parsed.map(coerceGroup).filter((g): g is CommitGroup => g !== null);
				if (groups.length > 0) {
					return groups;
				}
			}
		} catch {
			// Array span didn't parse (e.g. concatenated objects confuse the [ ] slice).
			// Fall through to the object scan.
		}
	}

	// Path 2: model emitted a single object or concatenated objects instead of an
	// array. Scan for top-level {...} objects and collect those that look like groups.
	const groups = extractTopLevelObjects(cleaned)
		.map(coerceGroup)
		.filter((g): g is CommitGroup => g !== null);
	if (groups.length > 0) {
		return groups;
	}

	throw new Error("AI response did not contain a JSON array");
}
