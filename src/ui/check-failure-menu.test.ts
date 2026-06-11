import { beforeEach, describe, expect, it, vi } from "vitest";
import { showCheckFailureMenu } from "./check-failure-menu.js";

// Mock all external dependencies
vi.mock("@clack/prompts", () => ({
	note: vi.fn(),
	select: vi.fn(),
	outro: vi.fn(),
	log: { info: vi.fn(), step: vi.fn(), warn: vi.fn() },
	isCancel: vi.fn(() => false),
	text: vi.fn(),
}));

vi.mock("../services/clipboard.js", () => ({
	copyToClipboard: vi.fn(),
}));

vi.mock("../services/hooks.js", () => ({}));

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}));

import { isCancel, note, select } from "@clack/prompts";
import { copyToClipboard } from "../services/clipboard.js";

const mockErrors = [
	{
		tool: "biome",
		message: "src/foo.ts:1:1 — unused variable",
		raw: "src/foo.ts:1:1 — unused variable",
	},
];

const mockRawStderr = "raw stderr output from hooks";

describe("showCheckFailureMenu", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(isCancel).mockReturnValue(false);
	});

	it("summarizes verbose tsc check failures in the initial note", async () => {
		const raw = [
			"> @vocab-platform/web@1.0.0 typecheck",
			"/home/quaidbartolomei/repos/polyglot/packages/web",
			"> tsc --noEmit",
			"",
			"src/pages/text-study/useParagraphReader.test.tsx(100,30): error TS2345: Argument of type '{ create: Mock<Procedure>; setErrorMessage: Mock<Procedure>; }' is not assignable to parameter of type '{ pageState: PageState; create: (variables: CreateTextSessionRequest) => void; }'.",
			"  Property 'pageState' is missing in type '{ create: Mock<Procedure>; }' but required in type '{ pageState: PageState; create: (variables: CreateTextSessionRequest) => void; }'.",
			"src/pages/text-study/useParagraphReader.test.tsx(141,30): error TS2345: Argument of type '{ create: Mock<Procedure>; setErrorMessage: Mock<Procedure>; }' is not assignable to parameter of type '{ pageState: PageState; create: (variables: CreateTextSessionRequest) => void; }'.",
			"  Property 'pageState' is missing in type '{ create: Mock<Procedure>; }' but required in type '{ pageState: PageState; create: (variables: CreateTextSessionRequest) => void; }'.",
			"src/pages/text-study/useParagraphReader.test.tsx(172,30): error TS2345: Argument of type '{ create: Mock<Procedure>; setErrorMessage: Mock<Procedure>; }' is not assignable to parameter of type '{ pageState: PageState; create: (variables: CreateTextSessionRequest) => void; }'.",
			"  Property 'pageState' is missing in type '{ create: Mock<Procedure>; }' but required in type '{ pageState: PageState; create: (variables: CreateTextSessionRequest) => void; }'.",
			"src/pages/text-study/useParagraphReader.test.tsx(242,30): error TS2345: Argument of type '{ create: Mock<Procedure>; setErrorMessage: Mock<Procedure>; }' is not assignable to parameter of type '{ pageState: PageState; create: (variables: CreateTextSessionRequest) => void; }'.",
			"  Property 'pageState' is missing in type '{ create: Mock<Procedure>; }' but required in type '{ pageState: PageState; create: (variables: CreateTextSessionRequest) => void; }'.",
			"src/pages/text-study/useParagraphReader.test.tsx(293,30): error TS2345: Argument of type '{ create: Mock<Procedure>; setErrorMessage: Mock<Procedure>; }' is not assignable to parameter of type '{ pageState: PageState; create: (variables: CreateTextSessionRequest) => void; }'.",
			"  Property 'pageState' is missing in type '{ create: Mock<Procedure>; }' but required in type '{ pageState: PageState; create: (variables: CreateTextSessionRequest) => void; }'.",
			" ELIFECYCLE  Command failed with exit code 2.",
		].join("\n");
		const errors = [{ tool: "tsc", message: raw, raw }];

		vi.mocked(select).mockResolvedValueOnce("retry");

		await showCheckFailureMenu(errors, raw, async () => true);

		expect(note).toHaveBeenCalledWith(
			expect.stringContaining("[tsc] 5 TypeScript errors"),
			expect.stringContaining("Pre-commit check failed"),
		);
		const summary = vi.mocked(note).mock.calls[0]?.[0];
		expect(summary).toContain(
			"src/pages/text-study/useParagraphReader.test.tsx:100:30 — error TS2345: Argument of type",
		);
		expect(summary).toContain("+2 more TypeScript errors. View full output for details.");
		expect(summary).not.toContain("ELIFECYCLE");
		expect(summary).not.toContain("Property 'pageState'");
		expect(summary).not.toContain("pageState: PageState");
	});

	it("summarizes single tsc error without '+more' suffix", async () => {
		const raw = "src/app.ts(5,10): error TS2304: Cannot find name 'foo'.";
		const errors = [{ tool: "tsc", message: raw, raw }];
		vi.mocked(select).mockResolvedValueOnce("retry");

		await showCheckFailureMenu(errors, raw, async () => true);

		const summary = vi.mocked(note).mock.calls[0]?.[0] as string;
		expect(summary).toContain("[tsc] 1 TypeScript error");
		expect(summary).toContain("src/app.ts:5:10 — error TS2304:");
		expect(summary).not.toContain("+");
		expect(summary).not.toContain("more TypeScript");
	});

	it("summarizes non-tsc errors with truncated message", async () => {
		const longMessage = "a".repeat(200);
		const errors = [{ tool: "biome", message: longMessage, raw: longMessage }];
		vi.mocked(select).mockResolvedValueOnce("retry");

		await showCheckFailureMenu(errors, longMessage, async () => true);

		const summary = vi.mocked(note).mock.calls[0]?.[0] as string;
		expect(summary).toContain("[biome]");
		expect(summary).toContain("a".repeat(119));
		expect(summary).toContain("…");
	});

	it("handles empty errors array gracefully", async () => {
		vi.mocked(select).mockResolvedValueOnce("retry");

		await showCheckFailureMenu([], "some output", async () => true);

		const summary = vi.mocked(note).mock.calls[0]?.[0] as string;
		expect(summary).toContain("No check error details");
	});

	it("should return 'retried' when retry is selected", async () => {
		vi.mocked(select).mockResolvedValueOnce("retry");

		const result = await showCheckFailureMenu(mockErrors, mockRawStderr, async () => true);

		expect(result).toBe("retried");
	});

	it("should return 'retried' even without onRetry callback", async () => {
		vi.mocked(select).mockResolvedValueOnce("retry");

		const result = await showCheckFailureMenu(mockErrors, mockRawStderr);

		expect(result).toBe("retried");
	});

	it("should loop back to menu after copy then retry", async () => {
		vi.mocked(copyToClipboard).mockResolvedValue(true);
		vi.mocked(select).mockResolvedValueOnce("copy").mockResolvedValueOnce("retry");

		const result = await showCheckFailureMenu(mockErrors, mockRawStderr, async () => true);

		expect(copyToClipboard).toHaveBeenCalledWith(mockRawStderr);
		expect(select).toHaveBeenCalledTimes(2);
		expect(result).toBe("retried");
	});

	it("should loop back to menu after view then retry", async () => {
		vi.mocked(select).mockResolvedValueOnce("view").mockResolvedValueOnce("retry");

		const result = await showCheckFailureMenu(mockErrors, mockRawStderr, async () => true);

		expect(select).toHaveBeenCalledTimes(2);
		expect(result).toBe("retried");
	});

	it("should return 'skipped' when skip is selected", async () => {
		vi.mocked(select).mockResolvedValueOnce("skip");

		const result = await showCheckFailureMenu(mockErrors, mockRawStderr);

		expect(result).toBe("skipped");
	});

	it("should return 'cancelled' when cancel is selected", async () => {
		vi.mocked(select).mockResolvedValueOnce("cancel");

		const result = await showCheckFailureMenu(mockErrors, mockRawStderr);

		expect(result).toBe("cancelled");
	});

	it("should return 'cancelled' on isCancel", async () => {
		vi.mocked(isCancel).mockReturnValue(true);
		vi.mocked(select).mockResolvedValue("cancel");

		const result = await showCheckFailureMenu(mockErrors, mockRawStderr);

		expect(result).toBe("cancelled");
	});
});
