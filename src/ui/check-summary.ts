import { log } from "@clack/prompts";
import { green } from "kolorist";
import type { CheckResults } from "../services/checks.js";

/** Minimal spinner contract — only the `stop` method is needed. */
type SpinnerStop = { stop: (message: string) => void };

/**
 * Stop a check spinner with a per-tool summary of the check results.
 *
 * - On success: stops with "All checks passed" and prints a `✓ tool` line
 *   for each result.
 * - On failure: stops with "N checks failed" (pluralized). Raw error output
 *   is intentionally NOT printed here — callers handle failure display
 *   (menu, raw print, etc.).
 */
export function stopCheckSpinner(spinner: SpinnerStop, results: CheckResults): void {
	if (results.ok) {
		spinner.stop("All checks passed");
		if (results.results.length > 0) {
			log.info(results.results.map((r) => `  ${green("✓")} ${r.tool}`).join("\n"));
		}
	} else {
		const failed = results.results.filter((r) => !r.ok);
		spinner.stop(`${failed.length} check${failed.length !== 1 ? "s" : ""} failed`);
	}
}
