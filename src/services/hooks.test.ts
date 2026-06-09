import { describe, expect, it } from "vitest";
import { extractToolName, parseCheckErrors, parseHookErrors, parseToolChecks } from "./hooks.js";

describe("extractToolName", () => {
	describe("direct invocations (existing behavior)", () => {
		it("extracts biome from direct invocation", () => {
			expect(extractToolName("biome check --write")).toBe("biome");
		});

		it("extracts eslint from direct invocation", () => {
			expect(extractToolName("eslint --fix src/foo.ts")).toBe("eslint");
		});

		it("extracts tsc from direct invocation", () => {
			expect(extractToolName("tsc --noEmit")).toBe("tsc");
		});

		it("extracts vitest from direct invocation", () => {
			expect(extractToolName("vitest run")).toBe("vitest");
		});

		it("extracts prettier from direct invocation", () => {
			expect(extractToolName("prettier --write src/foo.ts")).toBe("prettier");
		});
	});

	describe("package manager run scripts (existing behavior)", () => {
		it("maps npm run typecheck to tsc", () => {
			expect(extractToolName("npm run typecheck")).toBe("tsc");
		});

		it("maps pnpm run lint to eslint", () => {
			expect(extractToolName("pnpm run lint")).toBe("eslint");
		});

		it("maps yarn run format to prettier", () => {
			expect(extractToolName("yarn run format")).toBe("prettier");
		});

		it("maps bun typecheck to tsc (no run keyword)", () => {
			expect(extractToolName("bun typecheck")).toBe("tsc");
		});

		it("returns unknown script name as-is", () => {
			expect(extractToolName("npm run custom-script")).toBe("custom-script");
		});

		it("returns null for bare package manager with no script", () => {
			expect(extractToolName("npm run")).toBeNull();
		});
	});

	describe("npx (existing behavior)", () => {
		it("extracts tool from npx invocation", () => {
			expect(extractToolName("npx vitest")).toBe("vitest");
		});
	});

	describe("sh -c wrapper unwrapping", () => {
		it("unwraps sh -c with single quotes and cd && chain", () => {
			expect(
				extractToolName(
					"sh -c 'cd packages/web && pnpm exec prettier --write src/foo.ts src/bar.ts'",
				),
			).toBe("prettier");
		});

		it("unwraps sh -c with double quotes", () => {
			expect(
				extractToolName(
					'sh -c "cd packages/web && pnpm exec eslint --fix --cache --max-warnings 0 src/foo.ts"',
				),
			).toBe("eslint");
		});

		it("unwraps sh -c with pnpm script (no exec)", () => {
			expect(extractToolName("sh -c 'cd packages/web && pnpm typecheck'")).toBe("tsc");
		});

		it("unwraps sh -c with pnpm exec vitest", () => {
			expect(
				extractToolName(
					"sh -c 'cd packages/web && pnpm exec vitest related --run --passWithNoTests src/foo.test.ts'",
				),
			).toBe("vitest");
		});

		it("unwraps bash -c wrapper", () => {
			expect(extractToolName("bash -c 'pnpm exec prettier --write src/foo.ts'")).toBe("prettier");
		});

		it("handles sh -c without cd prefix", () => {
			expect(extractToolName("sh -c 'pnpm exec eslint --fix src/foo.ts'")).toBe("eslint");
		});

		it("handles bare sh -c without quotes", () => {
			expect(extractToolName("sh -c biome")).toBe("biome");
		});

		it("returns null for bare sh without -c", () => {
			expect(extractToolName("sh some-script.sh")).toBeNull();
		});
	});

	describe("pnpm exec", () => {
		it("extracts tool from pnpm exec prettier", () => {
			expect(extractToolName("pnpm exec prettier --write src/foo.ts")).toBe("prettier");
		});

		it("extracts tool from pnpm exec eslint", () => {
			expect(extractToolName("pnpm exec eslint --fix src/foo.ts")).toBe("eslint");
		});

		it("extracts tool from pnpm exec vitest", () => {
			expect(extractToolName("pnpm exec vitest run")).toBe("vitest");
		});

		it("returns null for bare pnpm exec", () => {
			expect(extractToolName("pnpm exec")).toBeNull();
		});
	});

	describe("uv run", () => {
		it("extracts tool from uv run ruff", () => {
			expect(extractToolName("uv run ruff check --fix src/foo.py")).toBe("ruff");
		});

		it("extracts tool from uv run ruff format", () => {
			expect(extractToolName("uv run ruff format src/foo.py")).toBe("ruff");
		});

		it("extracts tool from uv run ty", () => {
			expect(extractToolName("uv run ty check")).toBe("ty");
		});

		it("extracts tool from uv tool run", () => {
			expect(extractToolName("uv tool run ruff")).toBe("ruff");
		});

		it("returns null for bare uv run", () => {
			expect(extractToolName("uv run")).toBeNull();
		});

		it("returns null for bare uv", () => {
			expect(extractToolName("uv")).toBeNull();
		});
	});

	describe("combined: sh -c + uv run", () => {
		it("unwraps sh -c with uv run ruff", () => {
			expect(
				extractToolName("sh -c 'cd packages/youtube-helper && uv run ruff check --fix src/foo.py'"),
			).toBe("ruff");
		});

		it("unwraps sh -c with uv run ruff format", () => {
			expect(
				extractToolName("sh -c 'cd packages/youtube-helper && uv run ruff format src/foo.py'"),
			).toBe("ruff");
		});

		it("unwraps sh -c with uv run ty check", () => {
			expect(extractToolName("sh -c 'cd packages/youtube-helper && uv run ty check'")).toBe("ty");
		});
	});

	describe("safety guards", () => {
		it("returns null for bare sh", () => {
			expect(extractToolName("sh")).toBeNull();
		});

		it("returns null for bare bash", () => {
			expect(extractToolName("bash")).toBeNull();
		});

		it("returns null for bare zsh", () => {
			expect(extractToolName("zsh")).toBeNull();
		});
	});
});

describe("parseHookErrors", () => {
	describe("eslint errors", () => {
		// Realistic ESLint output always includes a summary footer — these match that
		const eslintFooter =
			"\n✖ 1 problem (0 errors, 1 warning)\nESLint found too many warnings (maximum: 0).";

		it("includes file path from preceding line in ESLint errors", () => {
			const stderr =
				[
					"/home/user/repos/project/src/components/Modal.tsx",
					"  278:1  warning  File has too many lines (292). Maximum allowed is 277  max-lines",
				].join("\n") + eslintFooter;

			const errors = parseHookErrors(stderr);
			const eslintError = errors.find((e) => e.tool === "eslint");
			expect(eslintError).toBeDefined();
			if (!eslintError) return;
			expect(eslintError.message).toContain("Modal.tsx:278:1");
			expect(eslintError.message).toContain("warning");
			expect(eslintError.message).toContain(
				"File has too many lines (292). Maximum allowed is 277",
			);
			expect(eslintError.message).toContain("(max-lines)");
		});

		it("handles ESLint error severity", () => {
			const stderr = [
				"/home/user/repos/project/src/utils/helpers.ts",
				"  10:5  error  Unexpected var, use let or const instead  no-var",
				"",
				"✖ 1 problem (1 error, 0 warnings)",
				"ESLint found errors.",
			].join("\n");

			const errors = parseHookErrors(stderr);
			const eslintError = errors.find((e) => e.tool === "eslint");
			expect(eslintError).toBeDefined();
			if (!eslintError) return;
			expect(eslintError.message).toContain("helpers.ts:10:5");
			expect(eslintError.message).toContain("error");
			expect(eslintError.message).toContain("Unexpected var, use let or const instead");
			expect(eslintError.message).toContain("(no-var)");
		});

		it("handles multiple ESLint errors for the same file", () => {
			const stderr = [
				"/home/user/repos/project/src/index.ts",
				"  5:1   error    Unexpected console statement      no-console",
				"  12:8  warning  'x' is defined but never used      no-unused-vars",
				"",
				"✖ 2 problems (1 error, 1 warning)",
				"ESLint found too many warnings (maximum: 0).",
			].join("\n");

			const errors = parseHookErrors(stderr);
			const eslintErrors = errors.filter((e) => e.tool === "eslint");
			expect(eslintErrors).toHaveLength(2);
			expect(eslintErrors[0].message).toContain("index.ts:5:1");
			expect(eslintErrors[0].message).toContain("no-console");
			expect(eslintErrors[1].message).toContain("index.ts:12:8");
			expect(eslintErrors[1].message).toContain("no-unused-vars");
		});

		it("handles ESLint errors across multiple files", () => {
			const stderr = [
				"/home/user/repos/project/src/foo.ts",
				"  1:1  error  Missing semicolon  semi",
				"/home/user/repos/project/src/bar.ts",
				"  5:10  warning  Unexpected any  no-explicit-any",
				"",
				"✖ 2 problems (1 error, 1 warning)",
				"ESLint found too many warnings (maximum: 0).",
			].join("\n");

			const errors = parseHookErrors(stderr);
			const eslintErrors = errors.filter((e) => e.tool === "eslint");
			expect(eslintErrors).toHaveLength(2);
			expect(eslintErrors[0].message).toContain("foo.ts:1:1");
			expect(eslintErrors[1].message).toContain("bar.ts:5:10");
		});

		it("shows 'unknown' file when no preceding path line", () => {
			const stderr = "  5:1  error  Missing semicolon  semi\nESLint found errors.";

			const errors = parseHookErrors(stderr);
			const eslintError = errors.find((e) => e.tool === "eslint");
			expect(eslintError).toBeDefined();
			if (!eslintError) return;
			expect(eslintError.message).toContain("unknown:5:1");
		});

		it("extracts full message text with double-space rule separator", () => {
			const stderr =
				["/project/src/app.ts", "  42:3  error  Strings must use singlequote  quotes"].join("\n") +
				eslintFooter;

			const errors = parseHookErrors(stderr);
			const eslintError = errors.find((e) => e.tool === "eslint");
			expect(eslintError).toBeDefined();
			if (!eslintError) return;
			expect(eslintError.message).toContain("Strings must use singlequote");
			expect(eslintError.message).toContain("(quotes)");
		});
	});

	describe("realistic lint-staged + eslint output", () => {
		it("parses the full lint-staged + eslint combined output", () => {
			const stderr = [
				"[STARTED] Running tasks for staged files...",
				"[FAILED] sh -c 'cd packages/web && pnpm exec eslint --fix src/foo.ts' [FAILED]",
				"[COMPLETED] Running tasks for staged files...",
				"",
				"✖ sh -c 'cd packages/web && pnpm exec eslint --fix src/foo.ts':",
				"",
				"/home/user/repos/project/packages/web/src/components/Modal.tsx",
				"  278:1  warning  File has too many lines (292). Maximum allowed is 277  max-lines",
				"",
				"✖ 1 problem (0 errors, 1 warning)",
				"",
				"ESLint found too many warnings (maximum: 0).",
				"husky - pre-commit script failed (code 1)",
			].join("\n");

			const errors = parseHookErrors(stderr);

			const lintStagedErrors = errors.filter((e) => e.tool === "lint-staged");
			expect(lintStagedErrors.length).toBeGreaterThanOrEqual(1);

			const eslintError = errors.find((e) => e.tool === "eslint");
			expect(eslintError).toBeDefined();
			if (!eslintError) return;
			expect(eslintError.message).toContain("Modal.tsx:278:1");
			expect(eslintError.message).toContain(
				"warning: File has too many lines (292). Maximum allowed is 277",
			);
			expect(eslintError.message).toContain("(max-lines)");
		});
	});

	describe("other parsers", () => {
		it("returns empty array for empty input", () => {
			expect(parseHookErrors("")).toEqual([]);
		});

		it("returns raw fallback when no patterns match", () => {
			const errors = parseHookErrors("something completely unexpected happened");
			expect(errors).toHaveLength(1);
			expect(errors[0].tool).toBe("git hooks");
			expect(errors[0].message).toContain("something completely unexpected happened");
		});
	});
});

describe("parseCheckErrors", () => {
	it("parses [tool] prefixed check output", () => {
		const output = "[eslint] ESLint found too many warnings (maximum: 0).";
		const errors = parseCheckErrors(output);
		expect(errors).toHaveLength(1);
		expect(errors[0].tool).toBe("eslint");
		expect(errors[0].message).toBe("ESLint found too many warnings (maximum: 0).");
	});

	it("parses multiple [tool] prefixed lines", () => {
		const output = [
			"[eslint] ESLint found too many warnings (maximum: 0).",
			"[tsc] error TS2322: Type 'string' is not assignable to type 'number'.",
		].join("\n");
		const errors = parseCheckErrors(output);
		expect(errors).toHaveLength(2);
		expect(errors[0].tool).toBe("eslint");
		expect(errors[0].message).toContain("too many warnings");
		expect(errors[1].tool).toBe("tsc");
		expect(errors[1].message).toContain("TS2322");
	});

	it("handles multiline [tool] blocks where only first line has prefix", () => {
		const output = [
			"[eslint]",
			"/project/src/foo.ts",
			"  5:1  error  Missing semicolon  semi",
			"  10:3  warning  Unexpected any  no-explicit-any",
			"",
			"✖ 2 problems (1 error, 1 warning)",
			"ESLint found too many warnings (maximum: 0).",
		].join("\n");
		const errors = parseCheckErrors(output);
		expect(errors).toHaveLength(1);
		expect(errors[0].tool).toBe("eslint");
		// Should contain the full output including details
		expect(errors[0].message).toContain("foo.ts");
		expect(errors[0].message).toContain("Missing semicolon");
	});

	it("falls back to 'checks' tool for lines without [tool] prefix", () => {
		const output = "something went wrong with an unknown tool";
		const errors = parseCheckErrors(output);
		expect(errors).toHaveLength(1);
		expect(errors[0].tool).toBe("checks");
		expect(errors[0].message).toContain("something went wrong");
	});

	it("returns empty array for empty input", () => {
		expect(parseCheckErrors("")).toEqual([]);
	});

	it("returns empty array for whitespace-only input", () => {
		expect(parseCheckErrors("   \n  \n ")).toEqual([]);
	});
});

describe("parseToolChecks", () => {
	it("deduplicates sh -c wrapped commands to actual tool names", () => {
		const stderr = [
			"[COMPLETED] sh -c 'cd packages/web && pnpm exec prettier --write src/foo.ts'",
			"[COMPLETED] sh -c 'cd packages/web && pnpm exec eslint --fix src/foo.ts'",
			"[COMPLETED] sh -c 'cd packages/web && pnpm typecheck'",
			"[COMPLETED] sh -c 'cd packages/web && pnpm exec vitest related --run src/foo.test.ts'",
		].join("\n");

		const checks = parseToolChecks(stderr);
		const toolNames = checks.map((c) => c.tool);

		expect(toolNames).toContain("prettier");
		expect(toolNames).toContain("eslint");
		expect(toolNames).toContain("tsc");
		expect(toolNames).toContain("vitest");
		expect(toolNames).not.toContain("sh");
		expect(checks).toHaveLength(4);
	});

	it("handles mixed direct and wrapped commands", () => {
		const stderr = [
			"[COMPLETED] biome check --write",
			"[COMPLETED] sh -c 'cd packages/web && pnpm typecheck'",
		].join("\n");

		const checks = parseToolChecks(stderr);
		const toolNames = checks.map((c) => c.tool);

		expect(toolNames).toContain("biome");
		expect(toolNames).toContain("tsc");
	});
});
