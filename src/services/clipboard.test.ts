import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyToClipboard } from "./clipboard.js";

vi.mock("../utils/debug.js", () => ({
	debug: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}));

import { spawn } from "node:child_process";

function mockSuccessfulChild() {
	return {
		on: vi.fn(),
		stdin: {
			write: vi.fn((_content: string, cb: (err?: null) => void) => cb(null)),
			end: vi.fn((cb: () => void) => cb()),
		},
		stderr: { on: vi.fn() },
		unref: vi.fn(),
	};
}

function mockFailedChild() {
	return {
		on: vi.fn(),
		stdin: {
			write: vi.fn((_content: string, cb: (err: Error) => void) => cb(new Error("not found"))),
			end: vi.fn(),
		},
		stderr: { on: vi.fn() },
		unref: vi.fn(),
	};
}

describe("copyToClipboard", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("should copy content using wl-copy when available", async () => {
		vi.mocked(spawn).mockReturnValue(mockSuccessfulChild() as never);

		const promise = copyToClipboard("test content");
		await vi.advanceTimersByTimeAsync(200);
		const result = await promise;

		expect(result).toBe(true);
		expect(spawn).toHaveBeenCalledWith("wl-copy", [], {
			stdio: ["pipe", "ignore", "pipe"],
		});
	});

	it("should fallback to xclip when wl-copy is not available", async () => {
		vi.mocked(spawn)
			.mockReturnValueOnce(mockFailedChild() as never) // wl-copy fails
			.mockReturnValueOnce(mockSuccessfulChild() as never); // xclip succeeds

		const promise = copyToClipboard("test content");
		await vi.advanceTimersByTimeAsync(200);
		const result = await promise;

		expect(result).toBe(true);
		expect(spawn).toHaveBeenCalledWith("xclip", ["-selection", "clipboard"], {
			stdio: ["pipe", "ignore", "pipe"],
		});
	});

	it("should try all tools and return false when none are available", async () => {
		vi.mocked(spawn).mockReturnValue(mockFailedChild() as never);

		const result = await copyToClipboard("test content");

		expect(result).toBe(false);
		expect(spawn).toHaveBeenCalledTimes(4); // all 4 tools tried
	});

	it("should detect quick exit with non-zero code during grace period", async () => {
		const child = mockSuccessfulChild();
		// Simulate exit with code 1 — stored as exitCode, detected after grace period
		child.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			if (event === "exit") {
				handler(1);
			}
		});

		const fallback = mockSuccessfulChild();

		vi.mocked(spawn)
			.mockReturnValueOnce(child as never)
			.mockReturnValueOnce(fallback as never);

		const promise = copyToClipboard("test content");
		// Advance past grace period for wl-copy (fails with exit 1)
		await vi.advanceTimersByTimeAsync(200);
		// Advance past grace period for xclip fallback (succeeds)
		await vi.advanceTimersByTimeAsync(200);
		const result = await promise;

		expect(result).toBe(true);
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	it("should report success when child exits with 0 during grace period", async () => {
		const child = mockSuccessfulChild();
		child.on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
			if (event === "exit") {
				handler(0);
			}
		});

		vi.mocked(spawn).mockReturnValue(child as never);

		const promise = copyToClipboard("test content");
		await vi.advanceTimersByTimeAsync(200);
		const result = await promise;

		expect(result).toBe(true);
	});
});
