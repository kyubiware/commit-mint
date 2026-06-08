import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import picomatch from "picomatch";
import { debug } from "../utils/debug.js";

/** Config file names, checked in priority order */
const CONFIG_FILES = [".cmintrc.ts", ".cmintrc.js"] as const;

/** Config shape from .cmintrc — glob keys map to command strings, string arrays, or functions */
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
 * Detect whether the repo has a .cmintrc config file (.ts or .js).
 * Returns the config file path, or null if none found.
 */
export async function detectConfig(repoRoot: string): Promise<string | null> {
	debug("detectConfig: checking for config in %s", repoRoot);
	for (const name of CONFIG_FILES) {
		try {
			await access(join(repoRoot, name), constants.R_OK);
			debug("detectConfig: found %s", name);
			return join(repoRoot, name);
		} catch {
			// try next config file name
		}
	}
	debug("detectConfig: no config file found");
	return null;
}

/**
 * Load and validate the .cmintrc config from a repo root.
 * Uses jiti for .ts files, native import() for .js files.
 * Throws if the default export is missing or not a non-null object.
 */
export async function loadConfig(repoRoot: string): Promise<CheckConfig> {
	const configPath = await detectConfig(repoRoot);
	if (!configPath) throw new Error("No .cmintrc config file found");

	debug("loadConfig: loading %s", configPath);
	const isTS = configPath.endsWith(".ts");
	let config: unknown;

	if (isTS) {
		const { createJiti } = await import("jiti");
		const jiti = createJiti(import.meta.url, {});
		const mod = await jiti.import(configPath);
		config = (mod as { default?: unknown }).default ?? mod;
	} else {
		const imported = (await import(configPath)) as { default?: unknown };
		config = imported.default;
	}

	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error(".cmintrc must export a non-null object with glob\u2192command mappings");
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
export async function runCommand(
	command: string,
	timeout: number,
	repoRoot?: string,
): Promise<CheckResult> {
	debug("runCommand: %s (timeout: %dms)", command, timeout);
	const parts = command.split(" ");
	const bin = parts[0];
	const args = parts.slice(1);

	try {
		const result = await execa(bin, args, {
			reject: false,
			timeout,
			all: true,
			preferLocal: true,
			...(repoRoot ? { localDir: repoRoot } : {}),
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
export function buildCommand(command: string, files: string[]): string {
	if (files.length === 0) return command;
	const quotedFiles = files.map((f) => (f.includes(" ") ? `"${f}"` : f));
	return `${command} ${quotedFiles.join(" ")}`;
}

/**
 * Resolve config commands for a glob entry into an array of command strings.
 * Function commands receive matched filenames; string commands are used as-is.
 */
function resolveCommands(
	commands: string | string[] | ((filenames: string[]) => string | string[]),
	matchedFiles: string[],
): string[] {
	const isFunction = typeof commands === "function";
	if (isFunction) {
		const resolved = (commands as (files: string[]) => string | string[])(matchedFiles);
		return Array.isArray(resolved) ? resolved : [resolved];
	}
	return Array.isArray(commands) ? commands : [commands as string];
}

/**
 * Run resolved commands for a single glob entry, appending results.
 * Returns false if any command fails (for fail-fast signaling).
 */
async function runCommandsForGlob(
	cmds: string[],
	isFunction: boolean,
	matchedFiles: string[],
	timeout: number,
	results: CheckResult[],
	repoRoot: string,
): Promise<boolean> {
	for (const cmd of cmds) {
		const fullCommand = isFunction ? cmd : buildCommand(cmd, matchedFiles);
		debug("runCommandsForGlob: running '%s'", fullCommand);
		const result = await runCommand(fullCommand, timeout, repoRoot);
		results.push({ ...result, files: matchedFiles });
		if (!result.ok) {
			debug("runCommandsForGlob: check failed, stopping (fail-fast)");
			return false;
		}
	}
	return true;
}

/**
 * Run all user-defined checks from .cmintrc against staged files.
 * Returns a no-op result when no config exists.
 * Fail-fast: stops on first error.
 */
export async function runAllChecks(
	repoRoot: string,
	stagedFiles: string[],
	timeout: number,
): Promise<CheckResults> {
	debug("runAllChecks: %d staged files, checking for config in %s", stagedFiles.length, repoRoot);

	const configPath = await detectConfig(repoRoot);
	if (!configPath) {
		debug("runAllChecks: no config found, skipping checks");
		return { ok: true, results: [] };
	}

	const config = await loadConfig(repoRoot);
	debug("runAllChecks: loaded config with %d patterns", Object.keys(config).length);

	const results: CheckResult[] = [];

	for (const [glob, commands] of Object.entries(config)) {
		const matchedFiles = matchFiles(glob, stagedFiles);
		const isFunction = typeof commands === "function";

		if (matchedFiles.length === 0 && !isFunction) {
			debug("runAllChecks: no files matched pattern '%s'", glob);
			continue;
		}
		debug("runAllChecks: pattern '%s' matched %d files", glob, matchedFiles.length);

		const cmds = resolveCommands(commands, matchedFiles);
		const ok = await runCommandsForGlob(cmds, isFunction, matchedFiles, timeout, results, repoRoot);
		if (!ok) return { ok: false, results };
	}

	const ok = results.every((r) => r.ok);
	debug("runAllChecks: complete \u2014 ok=%s, %d results", ok, results.length);
	return { ok, results };
}
