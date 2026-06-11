import { beforeEach, describe, expect, it, vi } from "vitest";
import { showRecoveryMenu } from "./recovery-menu.js";

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

import { isCancel, log, select, text } from "@clack/prompts";
import { copyToClipboard } from "../services/clipboard.js";

const mockErrors = [
	{
		tool: "biome",
		message: "src/foo.ts:1:1 — unused variable",
		raw: "src/foo.ts:1:1 — unused variable",
	},
];

const mockRawStderr = "raw stderr output from hooks";

describe("showRecoveryMenu", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(isCancel).mockReturnValue(false);
	});

	it("should NOT call process.exit after clipboard copy — should return to menu", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		vi.mocked(copyToClipboard).mockResolvedValue(true);

		// User picks "clipboard" first, then "cancel"
		vi.mocked(select).mockResolvedValueOnce("clipboard").mockResolvedValueOnce("cancel");

		const result = await showRecoveryMenu(
			mockErrors,
			async () => false,
			async () => false,
			async () => false,
			"test message",
			mockRawStderr,
		);

		// Should show the menu at least twice (clipboard + cancel)
		expect(select).toHaveBeenCalledTimes(2);

		// Should have called copyToClipboard with raw stderr
		expect(copyToClipboard).toHaveBeenCalledWith(mockRawStderr);

		// process.exit should NEVER be called
		expect(exitSpy).not.toHaveBeenCalled();

		// Should resolve to "cancelled" after user picks cancel
		expect(result).toBe("cancelled");

		exitSpy.mockRestore();
	});

	it("should show success message after clipboard copy succeeds", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		vi.mocked(copyToClipboard).mockResolvedValue(true);
		vi.mocked(select).mockResolvedValueOnce("clipboard").mockResolvedValueOnce("cancel");

		const result = await showRecoveryMenu(
			mockErrors,
			async () => false,
			async () => false,
			async () => false,
			"test message",
			mockRawStderr,
		);

		// log.step should be called with a success message for clipboard
		expect(log.step).toHaveBeenCalledWith(expect.stringContaining("Copied"));

		// process.exit should NEVER be called
		expect(exitSpy).not.toHaveBeenCalled();

		// Should resolve to "cancelled" after user picks cancel
		expect(result).toBe("cancelled");

		exitSpy.mockRestore();
	});

	it("should show error message when clipboard is unavailable", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		vi.mocked(copyToClipboard).mockResolvedValue(false);
		vi.mocked(select).mockResolvedValueOnce("clipboard").mockResolvedValueOnce("cancel");

		const result = await showRecoveryMenu(
			mockErrors,
			async () => false,
			async () => false,
			async () => false,
			"test message",
			mockRawStderr,
		);

		// Should show error about missing clipboard tool
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("clipboard tool"));

		// process.exit should NEVER be called
		expect(exitSpy).not.toHaveBeenCalled();

		// Should resolve to "cancelled" after user picks cancel
		expect(result).toBe("cancelled");

		exitSpy.mockRestore();
	});

	it("should allow user to take another action after copying to clipboard", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		vi.mocked(copyToClipboard).mockResolvedValue(true);

		const onSkipHooks = vi.fn().mockResolvedValue(true);

		// User picks clipboard, then skip hooks
		vi.mocked(select).mockResolvedValueOnce("clipboard").mockResolvedValueOnce("skip");

		const result = await showRecoveryMenu(
			mockErrors,
			async () => false,
			onSkipHooks,
			async () => false,
			"test message",
			mockRawStderr,
		);

		// Should have called both clipboard and skip hooks
		expect(copyToClipboard).toHaveBeenCalled();
		expect(onSkipHooks).toHaveBeenCalledWith("test message");

		// process.exit should NEVER be called
		expect(exitSpy).not.toHaveBeenCalled();

		// Should resolve to "committed" after skip hooks succeed
		expect(result).toBe("committed");

		exitSpy.mockRestore();
	});

	it('"skip" with onSkipHooks returning true resolves to "committed"', async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		const onSkipHooks = vi.fn().mockResolvedValue(true);
		vi.mocked(select).mockResolvedValueOnce("skip");

		const result = await showRecoveryMenu(
			mockErrors,
			async () => false,
			onSkipHooks,
			async () => false,
			"test message",
			mockRawStderr,
		);

		expect(onSkipHooks).toHaveBeenCalledWith("test message");
		expect(exitSpy).not.toHaveBeenCalled();
		expect(result).toBe("committed");

		exitSpy.mockRestore();
	});

	it('"skip" with onSkipHooks returning false resolves to "failed"', async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		const onSkipHooks = vi.fn().mockResolvedValue(false);
		vi.mocked(select).mockResolvedValueOnce("skip");

		const result = await showRecoveryMenu(
			mockErrors,
			async () => false,
			onSkipHooks,
			async () => false,
			"test message",
			mockRawStderr,
		);

		expect(onSkipHooks).toHaveBeenCalledWith("test message");
		expect(exitSpy).not.toHaveBeenCalled();
		expect(result).toBe("failed");

		exitSpy.mockRestore();
	});

	it('"restage" with onRestage returning true resolves to "committed"', async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		const onRestage = vi.fn().mockResolvedValue(true);
		vi.mocked(select).mockResolvedValueOnce("restage");

		const result = await showRecoveryMenu(
			mockErrors,
			async () => false,
			async () => false,
			onRestage,
			"test message",
			mockRawStderr,
		);

		expect(onRestage).toHaveBeenCalled();
		expect(exitSpy).not.toHaveBeenCalled();
		expect(result).toBe("committed");

		exitSpy.mockRestore();
	});

	it('"restage" with onRestage returning false loops back to menu', async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		const onRestage = vi.fn().mockResolvedValue(false);
		vi.mocked(select).mockResolvedValueOnce("restage").mockResolvedValueOnce("cancel");

		const result = await showRecoveryMenu(
			mockErrors,
			async () => false,
			async () => false,
			onRestage,
			"test message",
			mockRawStderr,
		);

		// Menu should loop: restage fails, then cancel is selected
		expect(select).toHaveBeenCalledTimes(2);
		expect(onRestage).toHaveBeenCalledTimes(1);
		expect(exitSpy).not.toHaveBeenCalled();
		expect(result).toBe("cancelled");

		exitSpy.mockRestore();
	});

	it('"edit" with text confirmed and onRetry returning true resolves to "committed"', async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		const onRetry = vi.fn().mockResolvedValue(true);
		vi.mocked(select).mockResolvedValueOnce("edit");
		vi.mocked(text).mockResolvedValue("edited message");

		const result = await showRecoveryMenu(
			mockErrors,
			onRetry,
			async () => false,
			async () => false,
			"test message",
			mockRawStderr,
		);

		expect(text).toHaveBeenCalled();
		expect(onRetry).toHaveBeenCalled();
		expect(exitSpy).not.toHaveBeenCalled();
		expect(result).toBe("committed");

		exitSpy.mockRestore();
	});

	it('"edit" with text confirmed and onRetry returning false resolves to "failed"', async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		const onRetry = vi.fn().mockResolvedValue(false);
		vi.mocked(select).mockResolvedValueOnce("edit");
		vi.mocked(text).mockResolvedValue("edited message");

		const result = await showRecoveryMenu(
			mockErrors,
			onRetry,
			async () => false,
			async () => false,
			"test message",
			mockRawStderr,
		);

		expect(text).toHaveBeenCalled();
		expect(onRetry).toHaveBeenCalled();
		expect(exitSpy).not.toHaveBeenCalled();
		expect(result).toBe("failed");

		exitSpy.mockRestore();
	});

	it('"cancel" selected resolves to "cancelled"', async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		vi.mocked(select).mockResolvedValueOnce("cancel");

		const result = await showRecoveryMenu(
			mockErrors,
			async () => false,
			async () => false,
			async () => false,
			"test message",
			mockRawStderr,
		);

		expect(exitSpy).not.toHaveBeenCalled();
		expect(result).toBe("cancelled");

		exitSpy.mockRestore();
	});

	it("isCancel at select prompt resolves to cancelled", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

		vi.mocked(isCancel).mockReturnValue(true);
		vi.mocked(select).mockResolvedValue("cancel");

		const result = await showRecoveryMenu(
			mockErrors,
			async () => false,
			async () => false,
			async () => false,
			"test message",
			mockRawStderr,
		);

		expect(exitSpy).not.toHaveBeenCalled();
		expect(result).toBe("cancelled");

		exitSpy.mockRestore();
	});
});
