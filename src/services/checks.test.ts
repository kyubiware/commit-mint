import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { CheckConfig, CheckResult, CheckResults } from "./checks.js";
import {
	buildCommand,
	detectConfig,
	loadConfig,
	matchFiles,
	runAllChecks,
	runCommand,
} from "./checks.js";

// Re-declare NodeJS.ErrnoException for Node 18 compat
interface ErrnoLike extends Error {
	code?: string;
}

// --- Mock node:fs/promises for detectConfig tests ---
const { mockAccess } = vi.hoisted(() => ({
	mockAccess: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...(actual as object),
		access: mockAccess,
		constants: { R_OK: 4, F_OK: 0, W_OK: 2, X_OK: 1 },
	};
});

// --- Mock execa for runCommand tests ---
const { mockExeca } = vi.hoisted(() => ({
	mockExeca: vi.fn(),
}));

vi.mock("execa", () => ({
	execa: mockExeca,
}));

describe("CheckConfig", () => {
	it("accepts a glob-to-command mapping", () => {
		const config: CheckConfig = {
			"*.ts": ["biome check"],
			"*.test.ts": "vitest run",
		};
		expect(config["*.ts"]).toEqual(["biome check"]);
		expect(config["*.test.ts"]).toEqual("vitest run");
	});

	it("index signature maps string to string | string[]", () => {
		const config: CheckConfig = {
			"src/**/*.ts": "biome check --write",
			"*.json": ["biome format --write"],
		};
		expectTypeOf(Object.keys(config)).items.toBeString();
	});
});

describe("CheckResult", () => {
	const result: CheckResult = {
		ok: true,
		tool: "biome",
		command: "biome check src/foo.ts",
		stdout: "",
		stderr: "",
		files: ["src/foo.ts"],
	};

	it("has ok as boolean", () => {
		expectTypeOf(result.ok).toBeBoolean();
	});

	it("has tool as string", () => {
		expectTypeOf(result.tool).toBeString();
	});

	it("has command as string", () => {
		expectTypeOf(result.command).toBeString();
	});

	it("has stdout as string", () => {
		expectTypeOf(result.stdout).toBeString();
	});

	it("has stderr as string", () => {
		expectTypeOf(result.stderr).toBeString();
	});

	it("has files as string array", () => {
		expectTypeOf(result.files).toBeArray();
		expectTypeOf(result.files).items.toBeString();
	});
});

describe("CheckResults", () => {
	it("aggregates check results — all passing", () => {
		const allPass: CheckResults = {
			ok: true,
			results: [
				{
					ok: true,
					tool: "biome",
					command: "biome check",
					stdout: "",
					stderr: "",
					files: ["src/foo.ts"],
				},
				{
					ok: true,
					tool: "vitest",
					command: "vitest run",
					stdout: "",
					stderr: "",
					files: ["src/bar.test.ts"],
				},
			],
		};
		expect(allPass.ok).toBe(true);
		expect(allPass.results).toHaveLength(2);
		expect(allPass.results.every((r) => r.ok)).toBe(true);
		expectTypeOf(allPass.ok).toBeBoolean();
		expectTypeOf(allPass.results).items.toEqualTypeOf<CheckResult>();
	});

	it("reflects failure when any result fails", () => {
		const hasFailure: CheckResults = {
			ok: false,
			results: [
				{
					ok: true,
					tool: "biome",
					command: "biome check",
					stdout: "",
					stderr: "",
					files: ["src/foo.ts"],
				},
				{
					ok: false,
					tool: "vitest",
					command: "vitest run",
					stdout: "",
					stderr: "FAIL: 1 test failed",
					files: ["src/bar.test.ts"],
				},
			],
		};
		expect(hasFailure.ok).toBe(false);
		expect(hasFailure.results.some((r) => !r.ok)).toBe(true);
	});
});

describe("detectConfig", () => {
	beforeEach(() => {
		mockAccess.mockReset();
	});

	it("returns true when .cmintrc.js exists and is readable", async () => {
		mockAccess.mockResolvedValue(undefined);
		await expect(detectConfig("/fake/repo")).resolves.toBe(true);
	});

	it("returns false when .cmintrc.js does not exist", async () => {
		const err = new Error("ENOENT") as ErrnoLike;
		err.code = "ENOENT";
		mockAccess.mockRejectedValue(err);
		await expect(detectConfig("/fake/repo")).resolves.toBe(false);
	});

	it("returns false on fs.access errors", async () => {
		mockAccess.mockRejectedValue(new Error("permission denied"));
		await expect(detectConfig("/fake/repo")).resolves.toBe(false);
	});
});

describe("loadConfig", () => {
	let tmpDir: string;

	afterEach(async () => {
		if (tmpDir) {
			await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("loads valid config with string values", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(join(tmpDir, ".cmintrc.js"), `export default { "*.ts": "biome check" };`);
		const config = await loadConfig(tmpDir);
		expect(config["*.ts"]).toBe("biome check");
	});

	it("loads valid config with string[] values", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(
			join(tmpDir, ".cmintrc.js"),
			`export default { "*.ts": ["biome check", "vitest run"] };`,
		);
		const config = await loadConfig(tmpDir);
		expect(config["*.ts"]).toEqual(["biome check", "vitest run"]);
	});

	it("throws on null export", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(join(tmpDir, ".cmintrc.js"), `export default null;`);
		await expect(loadConfig(tmpDir)).rejects.toThrow(/must export/);
	});

	it("throws on array export", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(join(tmpDir, ".cmintrc.js"), `export default [];`);
		await expect(loadConfig(tmpDir)).rejects.toThrow(/must export/);
	});

	it("throws on string export", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(join(tmpDir, ".cmintrc.js"), `export default "oops";`);
		await expect(loadConfig(tmpDir)).rejects.toThrow(/must export/);
	});
});

describe("matchFiles", () => {
	it('"*.ts" matches .ts files at any depth (matchBase)', () => {
		const result = matchFiles("*.ts", ["src/foo.ts", "src/bar.ts"]);
		expect(result).toEqual(["src/foo.ts", "src/bar.ts"]);
	});

	it('"*.ts" excludes non-matching extensions', () => {
		const result = matchFiles("*.ts", ["src/foo.js"]);
		expect(result).toEqual([]);
	});

	it('"src/**/*.ts" matches nested paths', () => {
		const result = matchFiles("src/**/*.ts", ["src/x/y/z.ts"]);
		expect(result).toEqual(["src/x/y/z.ts"]);
	});

	it("empty pattern matches nothing", () => {
		const result = matchFiles("", ["a.ts"]);
		expect(result).toEqual([]);
	});

	it('"*.ts" matches dotfiles (dot: true)', () => {
		const result = matchFiles("*.ts", [".hidden.ts"]);
		expect(result).toEqual([".hidden.ts"]);
	});
});

describe("buildCommand", () => {
	it('builds "eslint a.ts b.ts" from ["a.ts", "b.ts"]', () => {
		const result = buildCommand("eslint", ["a.ts", "b.ts"]);
		expect(result).toBe("eslint a.ts b.ts");
	});

	it('quotes paths with spaces: "biome check \\"my file.ts\\""', () => {
		const result = buildCommand("biome check", ["my file.ts"]);
		expect(result).toBe('biome check "my file.ts"');
	});

	it('builds "prettier --write a.ts"', () => {
		const result = buildCommand("prettier --write", ["a.ts"]);
		expect(result).toBe("prettier --write a.ts");
	});

	it("returns command as-is when files array is empty", () => {
		const result = buildCommand("echo", []);
		expect(result).toBe("echo");
	});
});

describe("runCommand", () => {
	beforeEach(() => {
		mockExeca.mockReset();
	});

	it("successful command returns ok: true with stdout", async () => {
		mockExeca.mockResolvedValue({
			failed: false,
			stdout: "hello\n",
			stderr: "",
			all: "hello\n",
		});
		const result = await runCommand("echo hello", 5000);
		expect(result.ok).toBe(true);
		expect(result.stdout).toBe("hello\n");
		expect(result.stderr).toBe("");
		expect(result.tool).toBe("echo");
		expect(result.command).toBe("echo hello");
	});

	it("failed command returns ok: false with stderr", async () => {
		mockExeca.mockResolvedValue({
			failed: true,
			stdout: "",
			stderr: "error output",
			all: "error output",
		});
		const result = await runCommand("eslint .", 5000);
		expect(result.ok).toBe(false);
		expect(result.stderr).toBe("error output");
	});

	it("command not found returns ok: false with not found message", async () => {
		const err = new Error("spawn nonexistent ENOENT");
		mockExeca.mockRejectedValue(err);
		const result = await runCommand("nonexistent", 5000);
		expect(result.ok).toBe(false);
		expect(result.stderr).toMatch(/not found/i);
	});

	it("timeout returns ok: false with timed out message", async () => {
		const err = new Error("execa timed out after 5000ms");
		mockExeca.mockRejectedValue(err);
		const result = await runCommand("sleep 10", 5000);
		expect(result.ok).toBe(false);
		expect(result.stderr).toMatch(/timed out/i);
	});
});

describe("runAllChecks", () => {
	let tmpDir: string;

	beforeEach(() => {
		mockAccess.mockReset();
		mockExeca.mockReset();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (tmpDir) {
			await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("returns no-op when no config file exists", async () => {
		mockAccess.mockRejectedValue(new Error("ENOENT"));
		const result = await runAllChecks("/fake/repo", ["src/foo.ts"], 5000);
		expect(result).toEqual({ ok: true, results: [] });
	});

	it("returns no-op when config exists but no files match", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(join(tmpDir, ".cmintrc.js"), `export default { "*.py": "flake8" };`);
		mockAccess.mockResolvedValue(undefined);

		const result = await runAllChecks(tmpDir, ["src/foo.ts"], 5000);
		expect(result).toEqual({ ok: true, results: [] });
	});

	it("runs commands for matched files", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(join(tmpDir, ".cmintrc.js"), `export default { "*.ts": "eslint" };`);
		mockAccess.mockResolvedValue(undefined);
		mockExeca.mockResolvedValue({
			failed: false,
			stdout: "",
			stderr: "",
			all: "",
		});

		const result = await runAllChecks(tmpDir, ["src/foo.ts"], 5000);
		expect(result.ok).toBe(true);
		expect(result.results).toHaveLength(1);
		expect(result.results[0]).toMatchObject({
			ok: true,
			tool: "eslint",
			files: ["src/foo.ts"],
		});
	});

	it("stops on first failure (fail-fast)", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(
			join(tmpDir, ".cmintrc.js"),
			`export default { "*.ts": "eslint", "*.json": "prettier --check" };`,
		);
		mockAccess.mockResolvedValue(undefined);
		// eslint fails first
		mockExeca.mockResolvedValueOnce({
			failed: true,
			stdout: "",
			stderr: "lint error",
			all: "lint error",
		});

		const result = await runAllChecks(tmpDir, ["src/foo.ts", "package.json"], 5000);
		expect(result.ok).toBe(false);
		expect(result.results).toHaveLength(1);
		expect(mockExeca).toHaveBeenCalledTimes(1);
	});

	it("runs all checks when all pass (multiple globs)", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(
			join(tmpDir, ".cmintrc.js"),
			`export default { "*.ts": "eslint", "*.json": "prettier --check" };`,
		);
		mockAccess.mockResolvedValue(undefined);
		mockExeca
			.mockResolvedValueOnce({
				failed: false,
				stdout: "",
				stderr: "",
				all: "",
			})
			.mockResolvedValueOnce({
				failed: false,
				stdout: "",
				stderr: "",
				all: "",
			});

		const result = await runAllChecks(tmpDir, ["src/foo.ts", "package.json"], 5000);
		expect(result.ok).toBe(true);
		expect(result.results).toHaveLength(2);
		expect(mockExeca).toHaveBeenCalledTimes(2);
	});
});
