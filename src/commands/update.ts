import * as p from "@clack/prompts"
import { cyan, dim, green, red } from "kolorist"
import {
	buildUpdateCommand,
	detectPackageManager,
	fetchLatestVersion,
	isUpdateAvailable,
	runUpdate,
} from "../services/updater.js"

export interface UpdateFlags {
	yes?: boolean
}

/**
 * Self-update flow for the installed `cmint` package. Detects the active
 * package manager from `npm_config_user_agent`, asks the npm registry for the
 * latest published version, and — if newer — runs the equivalent global
 * install command after a confirmation prompt (skippable with `--yes`).
 *
 * Never throws. Registry failures and install failures are reported through
 * `p.outro(...)` and `process.exit(1)`; cancellation and "already current"
 * resolve normally so the CLI exits cleanly.
 */
export async function updateCommand(currentVersion: string, flags?: UpdateFlags): Promise<void> {
	p.intro("cmint update")

	const pm = detectPackageManager(process.env.npm_config_user_agent)
	p.log.info(`Package manager: ${pm}`)

	p.log.message("Checking latest version...")
	const latest = await fetchLatestVersion()

	if (latest === null) {
		p.outro(red("Could not reach the npm registry. Check your connection and try again."))
		process.exit(1)
		return
	}

	if (!isUpdateAvailable(currentVersion, latest)) {
		p.outro(`Already up-to-date: v${currentVersion}`)
		return
	}

	p.log.step(`${dim(currentVersion)} → ${green(latest)}`)

	const cmd = buildUpdateCommand(pm)

	if (flags?.yes !== true) {
		const confirmed = await p.confirm({ message: `Run \`${cmd}\`?`, initialValue: true })
		if (p.isCancel(confirmed) || !confirmed) {
			p.outro("Update cancelled.")
			return
		}
	}

	p.log.message(`Running ${cyan(cmd)}...`)
	const ok = await runUpdate(pm)

	if (ok) {
		p.outro(green(`Updated to v${latest}`))
		return
	}

	p.outro(red("Update failed. See output above."))
	process.exit(1)
}
