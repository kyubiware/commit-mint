#!/usr/bin/env node
import { cli, command } from "cleye";
import pkg from "../package.json" with { type: "json" };

const { version } = pkg;

import { agentCommand } from "./commands/agent.js";
import { commitCommand } from "./commands/commit.js";
import { configCommand } from "./commands/config.js";
import { setAgentMode } from "./utils/agent.js";
import { setDebug } from "./utils/debug.js";

cli(
	{
		name: "cmint",
		version,
		description: "A commit tool that actually handles hook failures",
		flags: {
			retry: {
				type: Boolean,
				description: "Retry the last failed commit",
				alias: "r",
				default: false,
			},
			auto: {
				type: Boolean,
				description: "Auto-group files into commits and accept messages (no prompts)",
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
		},
		commands: [
			command({ name: "config" }, async () => {
				await configCommand();
			}),
		],
	},
	(argv) => {
		setDebug(argv.flags.debug);
		if (argv.flags.agent) {
			setAgentMode(true);
			agentCommand(argv.flags);
		} else {
			commitCommand(argv.flags);
		}
	},
);
