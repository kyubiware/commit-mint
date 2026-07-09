#!/usr/bin/env node
import { cli, command } from "cleye"
import pkg from "../package.json" with { type: "json" }

const { version } = pkg

import { handleAutoSubcommand } from "./cli.js"
import { agentCommand } from "./commands/agent.js"
import { commitCommand } from "./commands/commit.js"
import { configCommand } from "./commands/config.js"
import { logsCommand } from "./commands/logs.js"
import { updateCommand } from "./commands/update.js"
import { setAgentMode } from "./utils/agent.js"
import { setDebug, writeSessionHeader } from "./utils/debug.js"

cli(
	{
		name: "cmint",
		version,
		description:
			"AI-powered git commit tool — auto-group changed files, generate messages, run pre-commit checks",
		flags: {
			retry: {
				type: Boolean,
				description: "Retry the last failed commit",
				alias: "r",
				default: false,
			},
			auto: {
				type: (raw: string) => {
					if (raw === "") return true
					const n = Number(raw)
					return Number.isNaN(n) ? true : n
				},
				description:
					"Auto-group files into commits. Use -a <N> to request N groups (0 = LLM decides)",
				alias: "a",
				default: false,
			},
			message: {
				type: String,
				description: "Provide a commit message directly (skip AI generation)",
				alias: "m",
			},
			hint: {
				type: String,
				description: "Add context hint for AI commit message generation",
				alias: "H",
			},
			debug: {
				type: Boolean,
				description: "Enable debug output",
				alias: "d",
				default: false,
			},
			noCheck: {
				type: Boolean,
				description: "Skip user-defined pre-commit checks",
				alias: "N",
				default: false,
			},
			agent: {
				type: Boolean,
				description: "AI agent mode: non-interactive auto-group with JSON output",
				default: false,
			},
			single: {
				type: Boolean,
				description: "Stage all files as a single commit with AI message (non-interactive)",
				alias: "s",
				default: false,
			},
		},
		commands: [
			command(
				{
					name: "logs",
					description: "Show debug logs from the last cmint run",
					flags: {
						lines: {
							type: Number,
							description: "Number of lines to show from the end",
							alias: "n",
						},
					},
				},
				async (argv) => {
					await logsCommand(argv.flags)
				},
			),
			command(
				{
					name: "auto",
					description: "Auto-group files into logical commits (alias for --auto)",
				},
				async () => {
					await handleAutoSubcommand(version)
					process.exit(0)
				},
			),
			command({ name: "config" }, async () => {
				await configCommand()
			}),
			command(
				{
					name: "update",
					description: "Update cmint to the latest published version",
					flags: {
						yes: {
							type: Boolean,
							description: "Skip confirmation prompt",
							alias: "y",
							default: false,
						},
					},
				},
				async (argv) => {
					await updateCommand(version, argv.flags)
				},
			),
		],
	},
	async (argv) => {
		writeSessionHeader()
		setDebug(argv.flags.debug)
		if (argv.flags.agent) {
			setAgentMode(true)
			await agentCommand(argv.flags)
			process.exit(process.exitCode)
		} else {
			await commitCommand(argv.flags, version)
			process.exit(process.exitCode || 0)
		}
	},
)
