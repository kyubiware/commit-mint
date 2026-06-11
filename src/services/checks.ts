import { readFileSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { extname, join } from "node:path";
import { execa } from "execa";
import picomatch from "picomatch";
import { debug } from "../utils/debug.js";
import { extractToolName } from "./hooks.js";

/** Config file names, checked in priority order (matches lint-staged naming conventions) */
const CONFIG_FILES = [
	".cmintrc",
	".cmintrc.json",
	".cmintrc.mjs",
	".cmintrc.mts",
	".cmintrc.js",
	".cmintrc.ts",
	".cmintrc.cjs",
	".cmintrc.cts",
	"cmint.config.mjs",
	"cmint.config.mts",
	"cmint.config.js",
	"cmint.config.ts",
	"cmint.config.cjs",
	"cmint.config.cts",
] as const;

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
 * Detect whether the repo has a cmint config file.
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
 * Load and validate the cmint config from a repo root.
 * Throws if the loaded value is missing or not a non-null object.
 */
export async function loadConfig(repoRoot: string): Promise<CheckConfig> {
	const configPath = await detectConfig(repoRoot);
	if (!configPath) throw new Error("No cmint config file found");

	debug("loadConfig: loading %s", configPath);
	const ext = extname(configPath);
	const isJSON = ext === ".json";
	const isTS = ext === ".ts" || ext === ".mts" || ext === ".cts";
	const isCJS = ext === ".cjs";
	const needsJiti = isTS || isCJS;

	let config: unknown;

	if (isJSON) {
		const raw = readFileSync(configPath, "utf-8");
		config = JSON.parse(raw);
	} else if (needsJiti) {
		const { createJiti } = await import("jiti");
		const jiti = createJiti(import.meta.url, {});
		const mod = await jiti.import(configPath);
		config = (mod as { default?: unknown }).default ?? mod;
	} else {
		// .js, .mjs, or no extension
		const imported = (await import(configPath)) as { default?: unknown };
		config = imported.default;
	}

	if (!config || typeof config !== "object" || Array.isArray(config)) {
		throw new Error("cmint config must export a non-null object with glob\u2192command mappings");
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
	const tool = extractToolName(command) ?? command.split(" ")[0];

	try {
		const result = await execa(command, {
			shell: true,
			reject: false,
			timeout,
			all: true,
			preferLocal: true,
			...(repoRoot ? { localDir: repoRoot } : {}),
		});
		const ok = !result.failed;
		debug("runCommand: %s \u2014 ok=%s", tool, ok);
		return {
			ok,
			tool: tool,
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

		debug("runCommand: %s \u2014 error: %s", tool, msg);
		return {
			ok: false,
			tool: tool,
			command,
			stdout: "",
			stderr: isTimedOut
				? `Check timed out after ${timeout}ms`
				: isNotFound
					? `Command not found: ${tool}`
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
 * A resolved command string paired with whether it originated from a function.
 * Function-originated commands are run as-is; string commands get matched files appended.
 */
interface ResolvedCommand {
	command: string;
	fromFunction: boolean;
}

/**
 * Call a function command with matched files and normalize the result to ResolvedCommand[].
 */
function resolveFunction(
	fn: (files: string[]) => string | string[],
	matchedFiles: string[],
): ResolvedCommand[] {
	const resolved = fn(matchedFiles);
	const items = Array.isArray(resolved) ? resolved : [resolved];
	return items.map((command) => ({ command, fromFunction: true }));
}

/**
 * Resolve config commands for a glob entry into an array of resolved commands.
 * Function commands are called with matched filenames; string commands are kept as-is.
 * Each resolved entry tracks whether it came from a function (for file-append behavior).
 */
function resolveCommands(
	commands: string | string[] | ((filenames: string[]) => string | string[]),
	matchedFiles: string[],
): ResolvedCommand[] {
	if (typeof commands === "function") {
		return resolveFunction(commands as (files: string[]) => string | string[], matchedFiles);
	}
	if (Array.isArray(commands)) {
		const result: ResolvedCommand[] = [];
		for (const cmd of commands) {
			if (typeof cmd === "function") {
				result.push(...resolveFunction(cmd, matchedFiles));
			} else {
				result.push({ command: cmd, fromFunction: false });
			}
		}
		return result;
	}
	return [{ command: commands as string, fromFunction: false }];
}

/**
 * Run resolved commands for a single glob entry, appending results.
 * Function-originated commands run as-is; string commands get matched files appended.
 * Returns false if any command fails (for fail-fast signaling).
 */
async function runCommandsForGlob(
	cmds: ResolvedCommand[],
	matchedFiles: string[],
	timeout: number,
	results: CheckResult[],
	repoRoot: string,
): Promise<boolean> {
	for (const { command, fromFunction } of cmds) {
		const fullCommand = fromFunction ? command : buildCommand(command, matchedFiles);
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

		if (matchedFiles.length === 0) {
			debug("runAllChecks: no files matched pattern '%s'", glob);
			continue;
		}
		debug("runAllChecks: pattern '%s' matched %d files", glob, matchedFiles.length);

		const cmds = resolveCommands(commands, matchedFiles);
		const ok = await runCommandsForGlob(cmds, matchedFiles, timeout, results, repoRoot);
		if (!ok) return { ok: false, results };
	}

	const ok = results.every((r) => r.ok);
	debug("runAllChecks: complete \u2014 ok=%s, %d results", ok, results.length);
	return { ok, results };
}
