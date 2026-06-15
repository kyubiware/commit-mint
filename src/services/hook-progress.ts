import type { SpinnerResult } from "@clack/prompts"
import { extractToolName, isLintStagedMeta } from "./hooks.js"

export interface HookStep {
	status: "started" | "completed" | "failed"
	command: string
	tool: string
}

export type ProgressHandler = (step: HookStep) => void

const ansiRe = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g")

export function createStderrParser(): (chunk: string) => HookStep[] {
	let buffer = ""
	return (chunk: string): HookStep[] => {
		buffer += chunk
		const steps: HookStep[] = []
		const lines = buffer.split("\n")
		buffer = lines.pop() ?? ""
		for (const line of lines) {
			// Strip ANSI escape codes before matching (lint-staged wraps markers in color codes)
			const clean = line.replace(ansiRe, "")
			const match = clean.match(/\[(STARTED|COMPLETED|FAILED)\]\s+(.+)/)
			if (!match) continue
			const status = match[1].toLowerCase() as HookStep["status"]
			const command = match[2].trim()
			if (isLintStagedMeta(command)) continue
			const tool = extractToolName(command) ?? command
			steps.push({ status, command, tool })
		}
		return steps
	}
}

export function createProgressHandler(s: SpinnerResult): ProgressHandler {
	return (step: HookStep) => {
		if (step.status === "started") {
			s.message(step.command)
		} else if (step.status === "failed") {
			s.message(step.command)
		}
		// completed: no action — post-commit parseToolChecks summary handles display
	}
}
