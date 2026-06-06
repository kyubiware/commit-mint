import { intro, isCancel, log, note, outro, select, spinner } from "@clack/prompts";
import { bold, dim, green, red } from "kolorist";
import { copyToClipboard } from "../services/clipboard.js";
import { getModelForProvider, getProviderApiKey, readConfig } from "../services/config.js";
import { assertGitRepo, getRepoRoot, getStagedDiff, stageAll } from "../services/git.js";
import {
	formatProviderName,
	isValidProvider,
	PROVIDER_CONFIGS,
	type ProviderName,
} from "../services/provider.js";
import { generateCodeReview } from "../services/review-ai.js";
import { debug } from "../utils/debug.js";

export async function reviewCommand(): Promise<void> {
	debug("reviewCommand called");
	await assertGitRepo();

	// Stage all tracked files before reviewing
	const s = spinner();
	s.start("Staging all changes...");
	await stageAll();
	s.stop("Changes staged");

	const diffResult = await getStagedDiff();
	if (!diffResult) {
		outro(dim("No changes to review."));
		return;
	}
	if ("excludedFiles" in diffResult) {
		outro(dim("Staged files are all excluded from review."));
		return;
	}

	intro("commit-mint — code review");
	log.info(diffResult.files.map((f) => `     ${f}`).join("\n"));

	const opencodeAvailable = await isOpenCodeAvailable();
	const report = opencodeAvailable
		? await reviewWithOpenCode(diffResult.diff, diffResult.files)
		: await reviewWithGroq(diffResult.diff, diffResult.files);

	const hasIssues = report !== "NO_ISSUES_FOUND" && report.trim().length > 0;
	if (hasIssues) {
		note(report, red(bold("Review findings")));
		await offerClipboardCopy(report);
	} else {
		outro(green("No issues found. Looks good!"));
	}
}

async function offerClipboardCopy(report: string): Promise<void> {
	const shouldCopy = await select({
		message: "Copy review report to clipboard?",
		options: [
			{ label: "Yes, copy to clipboard", value: "yes" },
			{ label: "No", value: "no" },
		],
	});
	if (isCancel(shouldCopy) || shouldCopy === "no") {
		outro(dim("Done."));
		return;
	}

	const ok = await copyToClipboard(report);
	if (ok) {
		outro(green("Report copied to clipboard. You can paste it anywhere for fixes."));
	} else {
		outro(red("Failed to copy to clipboard. Install xclip, wl-copy, or xsel."));
	}
}

export async function isOpenCodeAvailable(): Promise<boolean> {
	try {
		const { exitCode } = await import("execa").then((m) =>
			m.execa("which", ["opencode"], { reject: false }),
		);
		return exitCode === 0;
	} catch {
		return false;
	}
}

export async function reviewWithGroq(diff: string, files: string[]): Promise<string> {
	const config = await readConfig();
	const provider: ProviderName = isValidProvider(config.provider ?? "groq")
		? (config.provider as ProviderName)
		: "groq";
	const apiKey = await getProviderApiKey(provider);
	const model = getModelForProvider(config, provider, PROVIDER_CONFIGS[provider].defaultModel);

	const s = spinner();
	s.start(`Reviewing with ${formatProviderName(provider)}...`);

	try {
		const report = await generateCodeReview(diff, files, {
			apiKey,
			model,
			timeout: config.timeout ? Number.parseInt(config.timeout, 10) : undefined,
			provider,
			proxy: config.proxy,
		});

		s.stop("Review complete");
		return report;
	} catch (err) {
		s.stop(red("Review failed."));
		debug("reviewWithGroq error:", err instanceof Error ? err.message : String(err));
		throw err;
	}
}

export async function reviewWithOpenCode(diff: string, files: string[]): Promise<string> {
	const s = spinner();
	s.start("Running OpenCode review...");

	try {
		const repoRoot = await getRepoRoot();

		const prompt = [
			"Review the staged changes in this git repository.",
			"Analyze the code diff for bugs, security issues, performance problems,",
			"code quality issues, and missing edge cases.",
			"",
			`Files changed (${files.length}):`,
			...files.map((f) => `  - ${f}`),
			"",
			"```diff",
			diff.slice(0, 15000), // Cap diff to avoid hitting token limits
			"```",
			"",
			"Provide a structured report with severity, location, issue, and fix suggestion for each finding.",
			"If no issues found, respond with: NO_ISSUES_FOUND",
		].join("\n");

		// Try direct execution first
		const { stdout } = await import("execa").then((m) =>
			m.execa("opencode", ["run", prompt, "--dir", repoRoot], {
				timeout: 120_000,
				reject: false,
			}),
		);

		s.stop("Review complete");
		return stdout || "OpenCode review completed but no output captured.";
	} catch (err) {
		s.stop(red("OpenCode review failed."));
		debug("reviewWithOpenCode error:", err instanceof Error ? err.message : String(err));
		throw new Error(`OpenCode review failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}
