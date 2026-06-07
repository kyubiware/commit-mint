import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import picomatch from "picomatch";
import { debug } from "../utils/debug.js";

/** Config shape from .cmintrc.js — glob keys map to command strings, string arrays, or functions */
export interface CheckConfig {
	[glob: string]: string | string[] | ((filenames: string[]) => string | string[]);
}

/** Result of a single check command execution */
export interface CheckResult {
	ok: boolean;
	tool: string;
	command: string;
	stdout: string;
	stderr: string;
	files: string[];
}

/** Aggregate result from running all checks */
export interface CheckResults {
	ok: boolean;
	results: CheckResult[];
}

/**
 * Detect whether the repo has a .cmintrc.js config file.
 * Returns true if the file exists and is readable.
 */
export async function detectConfig(repoRoot: string): Promise<boolean> {
	debug("detectConfig: checking for .cmintrc.js in %s", repoRoot);
	try {
		await access(join(repoRoot, ".cmintrc.js"), constants.R_OK);
		debug("detectConfig: found .cmintrc.js");
		return true;
	} catch {
		debug("detectConfig: no .cmintrc.js found");
		return false;
	}
}

/**
 * Load and validate the .cmintrc.js config from a repo root.
 * Throws if the default export is missing or not a non-null object.
 */
export async function loadConfig(repoRoot: string): Promise<CheckConfig> {
	debug("loadConfig: loading .cmintrc.js from %s", repoRoot);
	const configPath = join(repoRoot, ".cmintrc.js");
	const imported = (await import(configPath)) as { default?: unknown };
	const config = imported.default;
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error(".cmintrc.js must export a non-null object with glob\u2192command mappings");
	}
	debug(
		"loadConfig: loaded %d glob patterns",
		Object.keys(config as Record<string, unknown>).length,
	);
	return config as CheckConfig;
}

/**
 * Run a shell command and capture its output.
 * Returns a CheckResult with ok=true on success (exit 0), ok=false on failure.
 * Handles ENOENT (command not found) and timeout errors gracefully.
 */
export async function runCommand(command: string, timeout: number): Promise<CheckResult> {
	debug("runCommand: %s (timeout: %dms)", command, timeout);
	const parts = command.split(" ");
	const bin = parts[0];
	const args = parts.slice(1);

	try {
		const result = await execa(bin, args, {
			reject: false,
			timeout,
			all: true,
		});
		const ok = !result.failed;
		debug("runCommand: %s \u2014 ok=%s", bin, ok);
		return {
			ok,
			tool: bin,
			command,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			files: [],
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const isTimedOut = msg.toLowerCase().includes("timed out");
		const isNotFound =
			msg.toLowerCase().includes("enoent") || msg.toLowerCase().includes("not found");

		debug("runCommand: %s \u2014 error: %s", bin, msg);
		return {
			ok: false,
			tool: bin,
			command,
			stdout: "",
			stderr: isTimedOut
				? `Check timed out after ${timeout}ms`
				: isNotFound
					? `Command not found: ${bin}`
					: msg,
			files: [],
		};
	}
}

/**
 * Filter a list of file paths by a picomatch glob pattern.
 * When the pattern contains no `/`, files are matched at any depth (matchBase).
 * Dotfiles are included (dot: true).
 */
export function matchFiles(pattern: string, files: string[]): string[] {
	if (!pattern) return [];
	const matchBase = !pattern.includes("/");
	const isMatch = picomatch(pattern, {
		dot: true,
		posixSlashes: true,
		strictBrackets: true,
	});
	return files.filter((f) => {
		const parts = f.split("/");
		const target = matchBase ? parts[parts.length - 1] : f;
		return isMatch(target);
	});
}

/**
 * Build a shell command string from a base command and a list of file paths.
 * File paths containing spaces are wrapped in double quotes.
 * If no files are provided, the base command is returned as-is.
 */
/**
 * Run all user-defined checks from .cmintrc.js against staged files.
 * Returns a no-op result when no config exists.
 * Fail-fast: stops on first error.
 */
export async function runAllChecks(
	repoRoot: string,
	stagedFiles: string[],
	timeout: number,
): Promise<CheckResults> {
	debug("runAllChecks: %d staged files, checking for config in %s", stagedFiles.length, repoRoot);

	// No-op when no config file exists
	const hasConfig = await detectConfig(repoRoot);
	if (!hasConfig) {
		debug("runAllChecks: no .cmintrc.js found, skipping checks");
		return { ok: true, results: [] };
	}

	// Load config
	const config = await loadConfig(repoRoot);
	debug("runAllChecks: loaded config with %d patterns", Object.keys(config).length);

	const results: CheckResult[] = [];

	// Process each glob → commands entry
	for (const [glob, commands] of Object.entries(config)) {
		const matchedFiles = matchFiles(glob, stagedFiles);
		const isFunction = typeof commands === "function";

		// Function commands always run (even with no matches); string commands skip when no matches
		if (matchedFiles.length === 0 && !isFunction) {
			debug("runAllChecks: no files matched pattern '%s'", glob);
			continue;
		}
		debug("runAllChecks: pattern '%s' matched %d files", glob, matchedFiles.length);

		// Resolve commands: function receives matched filenames, string used as-is
		let cmds: string[];
		if (isFunction) {
			const resolved = (commands as (files: string[]) => string | string[])(matchedFiles);
			cmds = Array.isArray(resolved) ? resolved : [resolved];
		} else {
			cmds = Array.isArray(commands) ? commands : [commands as string];
		}

		for (const cmd of cmds) {
			const fullCommand = isFunction ? cmd : buildCommand(cmd, matchedFiles);
			debug("runAllChecks: running '%s'", fullCommand);
			const result = await runCommand(fullCommand, timeout);
			// Attach matched files to result
			results.push({ ...result, files: matchedFiles });

			// Fail-fast: stop on first error
			if (!result.ok) {
				debug("runAllChecks: check failed, stopping (fail-fast)");
				return { ok: false, results };
			}
		}
	}

	const ok = results.every((r) => r.ok);
	debug("runAllChecks: complete \u2014 ok=%s, %d results", ok, results.length);
	return { ok, results };
}

export function buildCommand(command: string, files: string[]): string {
	if (files.length === 0) return command;
	const quotedFiles = files.map((f) => (f.includes(" ") ? `"${f}"` : f));
	return `${command} ${quotedFiles.join(" ")}`;
}
