import type { SpinnerResult } from "@clack/prompts"
import { describe, expect, it, vi } from "vitest"
import { createProgressHandler, createStderrParser, type HookStep } from "./hook-progress.js"

// Mock @clack/prompts
vi.mock("@clack/prompts", () => ({}))

// Mock hooks with realistic but isolated implementations
vi.mock("../services/hooks.js", () => ({
	/**
	 * Returns true for lint-staged meta commands:
	 * - glob patterns containing *, {}, [, ]
	 * - file count labels like "src/ — 3 files"
	 * - lifecycle messages like "Running tasks..."
	 * - ellipsis endings like "Backing up original state..."
	 */
	isLintStagedMeta: vi.fn((cmd: string) => {
		if (/[*{}[\]]/.test(cmd)) return true
		if (/\s[-–—]\s(\d+\s)?files?$/.test(cmd)) return true
		if (/\s[-–—]\sno\s files$/.test(cmd)) return true
		if (
			/^(Running tasks|Applying modifications|Cleaning up|Backing up|Backed up|Updating Git)/.test(
				cmd,
			)
		)
			return true
		if (/\.{3}$/.test(cmd)) return true
		return false
	}),
	/**
	 * Extracts tool name from command:
	 * - npm run typecheck -> "tsc" (via scriptMap)
	 * - npm run lint -> "eslint"
	 * - npm run format -> "prettier"
	 * - npx <tool> -> second token
	 * - direct invocation -> first token
	 */
	extractToolName: vi.fn((cmd: string) => {
		// Unwrap sh -c '...'
		const quoted = cmd.match(/^(?:sh|bash|zsh)\s+-c\s+(['"])([\s\S]*)\1$/)
		if (quoted) cmd = quoted[2]
		else {
			const bare = cmd.match(/^(?:sh|bash|zsh)\s+-c\s+(\S+)$/)
			if (bare) cmd = bare[1]
		}
		// Find meaningful segment in && chain
		const segments = cmd
			.split(/\s*&&\s*/)
			.map((s: string) => s.trim())
			.filter(Boolean)
		let meaningful = segments[segments.length - 1] || cmd
		for (const seg of segments) {
			if (/^cd\s/.test(seg)) continue
			meaningful = seg
			break
		}
		const tokens = meaningful.split(/\s+/)
		const first = tokens[0]
		if (first === "sh" || first === "bash" || first === "zsh") return null
		if (["npm", "yarn", "pnpm", "bun"].includes(first)) {
			const sub = tokens[1]
			if (sub === "exec") return tokens[2] ?? null
			const scriptIdx = sub === "run" ? 2 : 1
			const script = tokens[scriptIdx]
			if (!script) return null
			const scriptMap: Record<string, string> = {
				typecheck: "tsc",
				lint: "eslint",
				format: "prettier",
			}
			return scriptMap[script] ?? script
		}
		if (first === "npx") return tokens[1] ?? null
		if (first === "uv") {
			if (tokens[1] === "run") return tokens[2] ?? null
			if (tokens[1] === "tool" && tokens[2] === "run") return tokens[3] ?? null
			return null
		}
		return first
	}),
}))

describe("createStderrParser", () => {
	it("parses a single complete line", () => {
		const parse = createStderrParser()
		const result = parse("[STARTED] biome check --write\n")
		expect(result).toEqual<HookStep[]>([
			{ status: "started", command: "biome check --write", tool: "biome" },
		])
	})

	it("parses multiple steps from a multi-line chunk", () => {
		const parse = createStderrParser()
		const result = parse("[STARTED] biome check\n[COMPLETED] biome check\n")
		expect(result).toEqual<HookStep[]>([
			{ status: "started", command: "biome check", tool: "biome" },
			{ status: "completed", command: "biome check", tool: "biome" },
		])
	})

	it("handles partial line across chunks (stateful buffer)", () => {
		const parse = createStderrParser()
		// First chunk: incomplete
		const first = parse("[STAR")
		expect(first).toEqual<HookStep[]>([])
		// Second chunk: completes the line
		const second = parse("TED] tsc --noEmit\n")
		expect(second).toEqual<HookStep[]>([
			{ status: "started", command: "tsc --noEmit", tool: "tsc" },
		])
	})

	it("strips ANSI escape codes before matching", () => {
		const parse = createStderrParser()
		const result = parse("\x1b[33m[STARTED]\x1b[0m biome check\n")
		expect(result).toEqual<HookStep[]>([
			{ status: "started", command: "biome check", tool: "biome" },
		])
	})

	it("filters meta task lines (ellipsis ending)", () => {
		const parse = createStderrParser()
		const result = parse("[COMPLETED] Backing up original state...\n")
		expect(result).toEqual<HookStep[]>([])
	})

	it("filters glob pattern lines", () => {
		const parse = createStderrParser()
		const result = parse("[STARTED] *.ts — 2 files\n")
		expect(result).toEqual<HookStep[]>([])
	})

	it("maps npm run typecheck to tsc tool name", () => {
		const parse = createStderrParser()
		const result = parse("[STARTED] npm run typecheck\n")
		expect(result).toEqual<HookStep[]>([
			{ status: "started", command: "npm run typecheck", tool: "tsc" },
		])
	})

	it("parses FAILED status", () => {
		const parse = createStderrParser()
		const result = parse("[FAILED] eslint --fix src/foo.ts\n")
		expect(result).toEqual<HookStep[]>([
			{ status: "failed", command: "eslint --fix src/foo.ts", tool: "eslint" },
		])
	})

	it("returns empty array for noise lines", () => {
		const parse = createStderrParser()
		const result = parse("some random output that isn't a marker\n")
		expect(result).toEqual<HookStep[]>([])
	})

	it("maintains buffer across multiple calls with no final newline", () => {
		const parse = createStderrParser()
		// Line without trailing newline stays in buffer
		const first = parse("[STARTED] biome check")
		expect(first).toEqual<HookStep[]>([])
		// Next chunk completes it
		const second = parse(" --write\n")
		expect(second).toEqual<HookStep[]>([
			{ status: "started", command: "biome check --write", tool: "biome" },
		])
	})
})

describe("createProgressHandler", () => {
	it("updates spinner message on started step", () => {
		const mockMessage = vi.fn()
		const s = { message: mockMessage } as unknown as SpinnerResult
		const handler = createProgressHandler(s)

		handler({ status: "started", command: "biome check", tool: "biome" })

		expect(mockMessage).toHaveBeenCalledWith("biome check")
	})

	it("updates spinner message on failed step", () => {
		const mockMessage = vi.fn()
		const s = { message: mockMessage } as unknown as SpinnerResult
		const handler = createProgressHandler(s)

		handler({ status: "failed", command: "eslint --fix", tool: "eslint" })

		expect(mockMessage).toHaveBeenCalledWith("eslint --fix")
	})
})
