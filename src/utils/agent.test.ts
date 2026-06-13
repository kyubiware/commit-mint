import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentResult } from "./agent.js";
import { EXIT_CODES, isAgentMode, setAgentMode, writeAgentResult } from "./agent.js";

describe("agent mode flag", () => {
	afterEach(() => {
		setAgentMode(false);
	});

	it("isAgentMode returns false by default", () => {
		expect(isAgentMode()).toBe(false);
	});

	it("setAgentMode(true) makes isAgentMode return true", () => {
		setAgentMode(true);
		expect(isAgentMode()).toBe(true);
	});

	it("setAgentMode toggles back to false", () => {
		setAgentMode(true);
		setAgentMode(false);
		expect(isAgentMode()).toBe(false);
	});
});

describe("writeAgentResult", () => {
	const writeSpy = vi.spyOn(process.stdout, "write");

	afterEach(() => {
		writeSpy.mockClear();
	});

	it("emits single-line valid JSON to stdout", () => {
		const result: AgentResult = {
			status: "success",
			commits: [],
		};
		writeAgentResult(result);
		expect(writeSpy).toHaveBeenCalledTimes(1);
		const output = writeSpy.mock.calls[0][0];
		expect(output).toContain("\n");
		const parsed = JSON.parse(output as string);
		expect(parsed.status).toBe("success");
		expect(parsed.commits).toEqual([]);
	});

	it("calls process.stdout.write exactly once", () => {
		const result: AgentResult = {
			status: "no_changes",
			commits: [],
		};
		writeAgentResult(result);
		expect(writeSpy).toHaveBeenCalledTimes(1);
	});

	it("handles errors array", () => {
		const result: AgentResult = {
			status: "failure",
			commits: [],
			errors: ["hook failed: biome check failed", "tsc error"],
		};
		writeAgentResult(result);
		expect(writeSpy).toHaveBeenCalledTimes(1);
		const output = writeSpy.mock.calls[0][0] as string;
		const parsed = JSON.parse(output);
		expect(parsed.errors).toEqual(["hook failed: biome check failed", "tsc error"]);
	});

	it("includes commit data in JSON output", () => {
		const result: AgentResult = {
			status: "success",
			commits: [
				{
					message: "feat: add agent mode",
					hash: "abc123",
					files: ["src/utils/agent.ts"],
					groupName: "agent-utils",
				},
			],
		};
		writeAgentResult(result);
		expect(writeSpy).toHaveBeenCalledTimes(1);
		const output = writeSpy.mock.calls[0][0] as string;
		const parsed = JSON.parse(output);
		expect(parsed.commits[0].message).toBe("feat: add agent mode");
		expect(parsed.commits[0].hash).toBe("abc123");
		expect(parsed.commits[0].files).toEqual(["src/utils/agent.ts"]);
		expect(parsed.commits[0].groupName).toBe("agent-utils");
	});
});

describe("EXIT_CODES", () => {
	it("has correct values", () => {
		expect(EXIT_CODES.SUCCESS).toBe(0);
		expect(EXIT_CODES.GENERIC).toBe(1);
		expect(EXIT_CODES.NO_CHANGES).toBe(2);
		expect(EXIT_CODES.GIT).toBe(3);
		expect(EXIT_CODES.AI).toBe(4);
		expect(EXIT_CODES.CHECK).toBe(5);
		expect(EXIT_CODES.HOOK).toBe(6);
	});

	it("values are literal types (const assertion narrows to literal)", () => {
		// Verify the const assertion produces literal types, not just `number`
		const success: 0 = EXIT_CODES.SUCCESS;
		const generic: 1 = EXIT_CODES.GENERIC;
		const noChanges: 2 = EXIT_CODES.NO_CHANGES;
		expect(success).toBe(0);
		expect(generic).toBe(1);
		expect(noChanges).toBe(2);
	});
});

describe("AgentResult type narrowing", () => {
	it("discriminates status field at runtime", () => {
		const successResult: AgentResult = {
			status: "success",
			commits: [{ message: "m", hash: "h", files: ["f.ts"] }],
		};
		const failureResult: AgentResult = {
			status: "failure",
			commits: [],
			errors: ["err"],
		};
		const cancelledResult: AgentResult = {
			status: "cancelled",
			commits: [],
		};
		const noChangesResult: AgentResult = {
			status: "no_changes",
			commits: [],
		};

		expect(successResult.status).toBe("success");
		expect(failureResult.status).toBe("failure");
		expect(cancelledResult.status).toBe("cancelled");
		expect(noChangesResult.status).toBe("no_changes");

		// Runtime-only check: canceled vs cancellled
		expect(successResult.commits).toHaveLength(1);
		expect(failureResult.errors).toBeDefined();
		expect(failureResult.errors).toHaveLength(1);
	});

	it("narrows correctly on status check (simulates discriminated union)", () => {
		function getSummary(result: AgentResult): string {
			if (result.status === "success") {
				return `${result.commits.length} commit(s)`;
			}
			if (result.status === "failure" && result.errors) {
				return `${result.errors.length} error(s)`;
			}
			return "no result";
		}

		expect(
			getSummary({ status: "success", commits: [{ message: "m", hash: "h", files: [] }] }),
		).toBe("1 commit(s)");
		expect(getSummary({ status: "failure", commits: [], errors: ["e1", "e2"] })).toBe("2 error(s)");
		expect(getSummary({ status: "no_changes", commits: [] })).toBe("no result");
		expect(getSummary({ status: "cancelled", commits: [] })).toBe("no result");
	});
});
