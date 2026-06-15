import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = process.cwd()

const agentFiles = ["src/utils/agent.ts", "src/commands/agent.ts"]
	.filter((f) => existsSync(join(ROOT, f)))
	.map((f) => join(ROOT, f))

describe("agent file static checks", () => {
	it("should not import @clack/prompts in agent files", () => {
		for (const file of agentFiles) {
			const content = readFileSync(file, "utf-8")
			expect(content, `${file} should not import @clack/prompts`).not.toContain("@clack/prompts")
		}
	})

	it("should not import kolorist in agent files", () => {
		for (const file of agentFiles) {
			const content = readFileSync(file, "utf-8")
			expect(content, `${file} should not import kolorist`).not.toContain("kolorist")
		}
	})

	it("should not call process.exit() in agent files", () => {
		for (const file of agentFiles) {
			const content = readFileSync(file, "utf-8")
			expect(content, `${file} should not call process.exit()`).not.toMatch(/process\.exit\(/)
		}
	})

	it("should not use console.log in agent files", () => {
		for (const file of agentFiles) {
			const content = readFileSync(file, "utf-8")
			expect(content, `${file} should not use console.log`).not.toContain("console.log")
		}
	})
})
