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

	it("returns config path when .cmintrc exists (first priority)", async () => {
		mockAccess.mockResolvedValue(undefined);
		await expect(detectConfig("/fake/repo")).resolves.toBe("/fake/repo/.cmintrc");
	});

	it("falls back to .cmintrc.js when .cmintrc through .cmintrc.mts don't exist", async () => {
		// Reject: .cmintrc, .cmintrc.json, .cmintrc.mjs, .cmintrc.mts
		mockAccess
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockResolvedValueOnce(undefined);
		await expect(detectConfig("/fake/repo")).resolves.toBe("/fake/repo/.cmintrc.js");
	});

	it("prefers .cmintrc over later entries when it exists", async () => {
		mockAccess.mockResolvedValue(undefined);
		await expect(detectConfig("/fake/repo")).resolves.toBe("/fake/repo/.cmintrc");
		expect(mockAccess).toHaveBeenCalledTimes(1);
	});

	it("returns path for .cmintrc.json when .cmintrc doesn't exist", async () => {
		mockAccess.mockRejectedValueOnce(new Error("ENOENT")).mockResolvedValueOnce(undefined);
		await expect(detectConfig("/fake/repo")).resolves.toBe("/fake/repo/.cmintrc.json");
	});

	it("returns path for cmint.config.js when no .cmintrc* files exist", async () => {
		// Reject all 8 .cmintrc* entries + cmint.config.mjs + cmint.config.mts = 10
		for (let i = 0; i < 10; i++) {
			mockAccess.mockRejectedValueOnce(new Error("ENOENT"));
		}
		mockAccess.mockResolvedValueOnce(undefined);
		await expect(detectConfig("/fake/repo")).resolves.toBe("/fake/repo/cmint.config.js");
	});

	it("returns null when no config file exists", async () => {
		mockAccess.mockRejectedValue(new Error("ENOENT"));
		await expect(detectConfig("/fake/repo")).resolves.toBe(null);
	});

	it("returns null on fs.access errors", async () => {
		mockAccess.mockRejectedValue(new Error("permission denied"));
		await expect(detectConfig("/fake/repo")).resolves.toBe(null);
	});
});

describe("loadConfig", () => {
	let tmpDir: string;

	beforeEach(() => {
		mockAccess.mockReset();
		// Default: reject all — tests override per case
		mockAccess.mockRejectedValue(new Error("ENOENT"));
	});

	afterEach(async () => {
		if (tmpDir) {
			await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("loads valid .cmintrc.js config with string values", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(join(tmpDir, ".cmintrc.js"), `export default { "*.ts": "biome check" };`);
		// Reject: .cmintrc, .cmintrc.json, .cmintrc.mjs, .cmintrc.mts
		mockAccess
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockResolvedValueOnce(undefined);
		const config = await loadConfig(tmpDir);
		expect(config["*.ts"]).toBe("biome check");
	});

	it("loads valid .cmintrc.ts config with string values", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(join(tmpDir, ".cmintrc.ts"), `export default { "*.ts": "biome check" };`);
		// Reject: .cmintrc, .cmintrc.json, .cmintrc.mjs, .cmintrc.mts, .cmintrc.js
		mockAccess
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockResolvedValueOnce(undefined);
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
		mockAccess
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockResolvedValueOnce(undefined);
		const config = await loadConfig(tmpDir);
		expect(config["*.ts"]).toEqual(["biome check", "vitest run"]);
	});

	it("throws on null export", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(join(tmpDir, ".cmintrc.js"), `export default null;`);
		mockAccess
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockResolvedValueOnce(undefined);
		await expect(loadConfig(tmpDir)).rejects.toThrow(/must export/);
	});

	it("throws on array export", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(join(tmpDir, ".cmintrc.js"), `export default [];`);
		mockAccess
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockResolvedValueOnce(undefined);
		await expect(loadConfig(tmpDir)).rejects.toThrow(/must export/);
	});

	it("throws on string export", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(join(tmpDir, ".cmintrc.js"), `export default "oops";`);
		mockAccess
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockResolvedValueOnce(undefined);
		await expect(loadConfig(tmpDir)).rejects.toThrow(/must export/);
	});

	it("throws when no config file exists", async () => {
		mockAccess.mockRejectedValue(new Error("ENOENT"));
		await expect(loadConfig("/fake/repo")).rejects.toThrow(/No cmint config/);
	});

	it("loads valid .cmintrc.json config", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(
			join(tmpDir, ".cmintrc.json"),
			JSON.stringify({ "*.ts": "biome check", "*.json": "prettier --check" }),
		);
		// Reject .cmintrc, resolve .cmintrc.json
		mockAccess.mockRejectedValueOnce(new Error("ENOENT")).mockResolvedValueOnce(undefined);
		const config = await loadConfig(tmpDir);
		expect(config["*.ts"]).toBe("biome check");
		expect(config["*.json"]).toBe("prettier --check");
	});

	it("loads valid cmint.config.js config", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(join(tmpDir, "cmint.config.js"), `export default { "*.ts": "biome check" };`);
		// Reject all 8 .cmintrc* entries + cmint.config.mjs + cmint.config.mts = 10
		for (let i = 0; i < 10; i++) {
			mockAccess.mockRejectedValueOnce(new Error("ENOENT"));
		}
		mockAccess.mockResolvedValueOnce(undefined);
		const config = await loadConfig(tmpDir);
		expect(config["*.ts"]).toBe("biome check");
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

	it('"*.ts" only matches .ts files in a mixed-extension list', () => {
		const result = matchFiles("*.ts", [
			"AGENTS.md",
			"package.json",
			"src/commands/commit.ts",
			"src/ui/menu.ts",
			".cmintrc.js",
		]);
		expect(result).toEqual(["src/commands/commit.ts", "src/ui/menu.ts"]);
	});

	it('"*.{js,ts,json}" only matches .js/.ts/.json files in a mixed list', () => {
		const result = matchFiles("*.{js,ts,json}", [
			"AGENTS.md",
			"package.json",
			"src/commands/commit.ts",
			"src/ui/menu.ts",
			".cmintrc.js",
			".lintstagedrc.mjs",
		]);
		expect(result).toEqual([
			"package.json",
			"src/commands/commit.ts",
			"src/ui/menu.ts",
			".cmintrc.js",
		]);
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
		const result = await runCommand("echo hello", 5000, "/repo");
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
		const result = await runCommand("eslint .", 5000, "/repo");
		expect(result.ok).toBe(false);
		expect(result.stderr).toBe("error output");
	});

	it("extracts tool name from npm run commands", async () => {
		mockExeca.mockResolvedValue({
			failed: false,
			stdout: "",
			stderr: "",
			all: "",
		});
		const result = await runCommand("npm run build", 5000, "/repo");
		expect(result.tool).toBe("build");
	});
	it("command not found returns ok: false with not found message", async () => {
		const err = new Error("spawn nonexistent ENOENT");
		mockExeca.mockRejectedValue(err);
		const result = await runCommand("nonexistent", 5000, "/repo");
		expect(result.ok).toBe(false);
		expect(result.stderr).toMatch(/not found/i);
	});

	it("timeout returns ok: false with timed out message", async () => {
		const err = new Error("execa timed out after 5000ms");
		mockExeca.mockRejectedValue(err);
		const result = await runCommand("sleep 10", 5000, "/repo");
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
		await writeFile(join(tmpDir, ".cmintrc.ts"), `export default { "*.py": "flake8" };`);
		// Reject: .cmintrc, .cmintrc.json, .cmintrc.mjs, .cmintrc.mts, .cmintrc.js
		mockAccess
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockResolvedValueOnce(undefined);

		const result = await runAllChecks(tmpDir, ["src/foo.ts"], 5000);
		expect(result).toEqual({ ok: true, results: [] });
	});

	it("runs commands for matched files", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(join(tmpDir, ".cmintrc.ts"), `export default { "*.ts": "eslint" };`);
		mockAccess
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockResolvedValueOnce(undefined);
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
		await writeFile(
			join(tmpDir, ".cmintrc.ts"),
			`export default { "*.ts": "eslint", "*.json": "prettier --check" };`,
		);
		mockAccess
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockResolvedValueOnce(undefined);
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
		await writeFile(
			join(tmpDir, ".cmintrc.ts"),
			`export default { "*.ts": "eslint", "*.json": "prettier --check" };`,
		);
		mockAccess
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockResolvedValueOnce(undefined);
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

	it("supports function commands that receive matched filenames", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(
			join(tmpDir, ".cmintrc.ts"),
			`export default { "*.ts": (files) => \`tsc --noEmit\` };`,
		);
		mockAccess
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockResolvedValueOnce(undefined);
		mockExeca.mockResolvedValue({
			failed: false,
			stdout: "",
			stderr: "",
			all: "",
		});

		const result = await runAllChecks(tmpDir, ["src/foo.ts"], 5000);
		expect(result.ok).toBe(true);
		expect(result.results).toHaveLength(1);
		// Function returned "tsc --noEmit" — run via shell
		expect(mockExeca).toHaveBeenCalledWith(
			"tsc --noEmit",
			expect.objectContaining({ shell: true }),
		);
	});

	it("function command returning array runs multiple commands", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
		await writeFile(
			join(tmpDir, ".cmintrc.ts"),
			`export default { "*.ts": (files) => ["tsc --noEmit", "vitest run"] };`,
		);
		mockAccess
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockResolvedValueOnce(undefined);
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

		const result = await runAllChecks(tmpDir, ["src/foo.ts"], 5000);
		expect(result.ok).toBe(true);
		expect(result.results).toHaveLength(2);
		expect(mockExeca).toHaveBeenCalledTimes(2);
	});

	it("function commands are skipped when no files match the glob", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-test-"));
		await writeFile(
			join(tmpDir, ".cmintrc.ts"),
			`export default { "*.ts": () => "tsc --noEmit" };`,
		);
		mockAccess
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockRejectedValueOnce(new Error("ENOENT"))
			.mockResolvedValueOnce(undefined);

		// No .ts files — function command should NOT run
		const result = await runAllChecks(tmpDir, ["README.md"], 5000);
		expect(result.ok).toBe(true);
		expect(result.results).toHaveLength(0);
		expect(mockExeca).not.toHaveBeenCalled();
	});
});
