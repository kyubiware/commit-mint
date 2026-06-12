import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCmintrcContent, type DetectedTools, detectTools, pickFileName } from "./setup.js";

// --- Mock node:fs/promises for fs access checks ---
const { mockAccess, mockWriteFile } = vi.hoisted(() => ({
	mockAccess: vi.fn(),
	mockWriteFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...(actual as object),
		access: mockAccess,
		constants: { R_OK: 4, F_OK: 0, W_OK: 2, X_OK: 1 },
		writeFile: mockWriteFile,
	};
});

const NONE: DetectedTools = { biome: false, eslint: false, typescript: false, vitest: false };

describe("pickFileName", () => {
	it("returns .cmintrc.ts when TypeScript is detected", () => {
		expect(pickFileName({ ...NONE, typescript: true })).toBe(".cmintrc.ts");
	});

	it("returns .cmintrc (no extension) when TypeScript is absent", () => {
		expect(pickFileName({ ...NONE, biome: true })).toBe(".cmintrc");
		expect(pickFileName(NONE)).toBe(".cmintrc");
	});
});

describe("buildCmintrcContent", () => {
	it("emits an empty object literal when no tools are detected", () => {
		const out = buildCmintrcContent(NONE);
		expect(out).toBe("export default {\n};\n");
	});

	it("emits biome entry with js/ts/json glob when only biome is detected", () => {
		const out = buildCmintrcContent({ ...NONE, biome: true });
		expect(out).toContain('"*.{js,ts,json}": "biome check --write');
		expect(out).not.toContain("eslint");
	});

	it("emits eslint entry with js/ts glob when only eslint is detected", () => {
		const out = buildCmintrcContent({ ...NONE, eslint: true });
		expect(out).toContain('"*.{js,ts}": "eslint --fix"');
		expect(out).not.toContain("biome");
	});

	it("prefers biome over eslint when both are detected", () => {
		const out = buildCmintrcContent({ ...NONE, biome: true, eslint: true });
		expect(out).toContain("biome check");
		expect(out).not.toContain("eslint");
	});

	it("wraps a single ts check in a function returning a bare string", () => {
		const out = buildCmintrcContent({ ...NONE, typescript: true });
		expect(out).toContain('"*.ts": () => "tsc --noEmit",');
	});

	it("wraps multiple ts checks in a function returning an array", () => {
		const out = buildCmintrcContent({ ...NONE, typescript: true, vitest: true });
		expect(out).toContain('"*.ts": () => ["tsc --noEmit", "vitest run --passWithNoTests"],');
	});

	it("indents with tabs and ends with a trailing comma on each entry", () => {
		const out = buildCmintrcContent({ ...NONE, biome: true, typescript: true });
		const lines = out.split("\n");
		expect(lines[1].startsWith("\t")).toBe(true);
		expect(lines[1].endsWith(",")).toBe(true);
	});

	it("matches the project's reference .cmintrc.ts shape for a full toolchain", () => {
		const out = buildCmintrcContent({
			biome: true,
			eslint: false,
			typescript: true,
			vitest: true,
		});
		expect(out).toBe(
			`export default {\n\t"*.{js,ts,json}": "biome check --write --no-errors-on-unmatched --error-on-warnings",\n\t"*.ts": () => ["tsc --noEmit", "vitest run --passWithNoTests"],\n};\n`,
		);
	});
});

describe("detectTools", () => {
	let tmpDir: string;

	beforeEach(() => {
		mockAccess.mockReset();
	});

	afterEach(async () => {
		if (tmpDir) {
			await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	});

	it("returns all-false when no marker files are present", async () => {
		mockAccess.mockRejectedValue(new Error("ENOENT"));
		await expect(detectTools("/fake/repo")).resolves.toEqual(NONE);
	});

	it("detects biome via biome.json", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-setup-"));
		await writeFile(join(tmpDir, "biome.json"), "{}");
		// biome has 2 marker files, typescript 1, vitest 4, eslint 10 — total 17
		// biome.json resolves; rest all reject
		mockAccess.mockResolvedValueOnce(undefined);
		for (let i = 0; i < 16; i++) mockAccess.mockRejectedValueOnce(new Error("ENOENT"));
		const result = await detectTools(tmpDir);
		expect(result.biome).toBe(true);
		expect(result.eslint).toBe(false);
		expect(result.typescript).toBe(false);
		expect(result.vitest).toBe(false);
	});

	it("detects biome.jsonc as a fallback when biome.json is absent", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-setup-"));
		await writeFile(join(tmpDir, "biome.jsonc"), "{}");
		mockAccess
			.mockRejectedValueOnce(new Error("ENOENT")) // biome.json
			.mockResolvedValueOnce(undefined) // biome.jsonc
			.mockRejectedValue(new Error("ENOENT"));
		const result = await detectTools(tmpDir);
		expect(result.biome).toBe(true);
	});

	it("detects typescript via tsconfig.json", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-setup-"));
		await writeFile(join(tmpDir, "tsconfig.json"), "{}");
		// biome (2) + eslint (10) reject, then tsconfig resolves
		for (let i = 0; i < 12; i++) mockAccess.mockRejectedValueOnce(new Error("ENOENT"));
		mockAccess.mockResolvedValueOnce(undefined);
		const result = await detectTools(tmpDir);
		expect(result.typescript).toBe(true);
		expect(result.biome).toBe(false);
	});

	it("detects vitest via vitest.config.ts", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-setup-"));
		await writeFile(join(tmpDir, "vitest.config.ts"), "export default {}");
		// biome (2) + eslint (10) + tsconfig (1) + vitest.config.js (1) + vitest.config.mts (1) reject
		for (let i = 0; i < 15; i++) mockAccess.mockRejectedValueOnce(new Error("ENOENT"));
		mockAccess.mockResolvedValueOnce(undefined); // vitest.config.ts
		const result = await detectTools(tmpDir);
		expect(result.vitest).toBe(true);
	});

	it("detects modern eslint flat config (eslint.config.js)", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-setup-"));
		await writeFile(join(tmpDir, "eslint.config.js"), "export default []");
		// biome (2) reject, then eslint.config.js resolves
		mockAccess.mockRejectedValueOnce(new Error("ENOENT"));
		mockAccess.mockRejectedValueOnce(new Error("ENOENT"));
		mockAccess.mockResolvedValueOnce(undefined);
		mockAccess.mockRejectedValue(new Error("ENOENT"));
		const result = await detectTools(tmpDir);
		expect(result.eslint).toBe(true);
	});

	it("detects legacy eslint via .eslintrc", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-setup-"));
		await writeFile(join(tmpDir, ".eslintrc"), "{}");
		// biome (2) + flat eslint configs (4) reject, then .eslintrc resolves
		for (let i = 0; i < 6; i++) mockAccess.mockRejectedValueOnce(new Error("ENOENT"));
		mockAccess.mockResolvedValueOnce(undefined);
		const result = await detectTools(tmpDir);
		expect(result.eslint).toBe(true);
	});

	it("detects all four tools when their markers are all present", async () => {
		tmpDir = await mkdtemp(join(tmpdir(), "cmint-setup-"));
		await writeFile(join(tmpDir, "biome.json"), "{}");
		await writeFile(join(tmpDir, "eslint.config.js"), "");
		await writeFile(join(tmpDir, "tsconfig.json"), "{}");
		await writeFile(join(tmpDir, "vitest.config.ts"), "");
		mockAccess.mockResolvedValue(undefined);
		const result = await detectTools(tmpDir);
		expect(result).toEqual({ biome: true, eslint: true, typescript: true, vitest: true });
	});
});
