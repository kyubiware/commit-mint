import { spawn } from "node:child_process"
import { debug } from "../utils/debug.js"

/** Milliseconds to wait after stdin closes for quick exit failures. */
const GRACE_PERIOD_MS = 150

export async function copyToClipboard(content: string): Promise<boolean> {
	debug("clipboard: copying %d bytes", content.length)
	// wl-copy is listed twice: `--foreground` keeps the wl-copy process we spawned
	// as the one holding the clipboard (instead of an invisible forked child that
	// can die silently and leave the Wayland clipboard empty without any error).
	// The plain `wl-copy` fallback covers wl-clipboard 1.x, which lacks the flag.
	const commands: [string, string[]][] = [
		["wl-copy", ["--foreground"]],
		["wl-copy", []],
		["xclip", ["-selection", "clipboard"]],
		["xsel", ["--clipboard", "--input"]],
		["pbcopy", []],
	]

	for (const [cmd, args] of commands) {
		try {
			const success = await tryCopy(cmd, args, content)
			if (success) return true
		} catch {}
	}
	return false
}

/**
 * Try to copy content using a single clipboard tool.
 *
 * Waits a short grace period after stdin closes to detect quick failures
 * (e.g. wl-copy on non-Wayland, missing display). If the tool survives
 * the grace period, assumes success — clipboard tools like xclip and
 * wl-copy hold the selection open indefinitely, so we can't wait for exit.
 */
/**
 * Evaluate clipboard tool status after the grace period.
 * If the child already exited, report based on exit code.
 * If still alive, assume success (clipboard tools hold selection open).
 */
function handleGracePeriod(
	settled: boolean,
	exitCode: number | null,
	stderrChunks: Buffer[],
	child: ReturnType<typeof spawn>,
	done: (result: boolean, reason?: string) => void,
) {
	if (settled) return

	if (exitCode !== null) {
		if (exitCode === 0) {
			done(true, "exited 0")
		} else {
			const stderr = Buffer.concat(stderrChunks).toString().trim()
			done(false, `exit ${exitCode}${stderr ? `: ${stderr}` : ""}`)
		}
		return
	}

	// Child still alive — assume success. Clipboard tools
	// (xclip, wl-copy) hold the selection open, so they
	// don't exit until something else takes the clipboard.
	child.unref()
	done(true)
}

function tryCopy(cmd: string, args: string[], content: string): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		debug("clipboard: trying %s", cmd)

		const child = spawn(cmd, args, {
			stdio: ["pipe", "ignore", "pipe"],
		})

		let settled = false
		const stderrChunks: Buffer[] = []

		child.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk)
		})

		const done = (result: boolean, reason?: string) => {
			if (settled) return
			settled = true
			debug("clipboard: %s %s%s", cmd, result ? "ok" : "failed", reason ? ` (${reason})` : "")
			resolve(result)
		}

		// Command not found (ENOENT)
		child.on("error", (err) => {
			done(false, err.message)
		})

		// Track exit for grace-period detection
		let exitCode: number | null = null
		child.on("exit", (code) => {
			exitCode = code
		})

		child.stdin.write(content, (err) => {
			if (err) {
				done(false, "stdin write error")
				return
			}
			child.stdin.end(() => {
				// stdin closed — start grace period to detect quick failures
				setTimeout(
					() => handleGracePeriod(settled, exitCode, stderrChunks, child, done),
					GRACE_PERIOD_MS,
				)
			})
		})
	})
}
