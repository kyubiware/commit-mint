import { intro, outro, spinner } from "@clack/prompts";
import { green, red } from "kolorist";
import { getHead, getRepoRoot } from "../services/git.js";
import { loadCachedCommit } from "../utils/cache.js";
import { debug } from "../utils/debug.js";
import { commitWithRecovery } from "./commit-utils.js";

/** Handle --retry mode: load cached message and re-attempt commit */
export async function handleRetry(): Promise<void> {
	debug("Entering retry mode");
	const repoRoot = await getRepoRoot();
	const cached = await loadCachedCommit(repoRoot);
	if (!cached) {
		outro(red("No cached commit message found. Run cmint without --retry first."));
		process.exit(1);
	}
	intro("🌿 commit-mint — retry");
	const s = spinner();
	const headBefore = await getHead();
	s.start("Running pre-commit hooks...");
	const result = await commitWithRecovery(cached.message, s, headBefore);
	if (result === "committed") {
		outro(green("Committed successfully."));
	} else {
		process.exit(1);
	}
}
