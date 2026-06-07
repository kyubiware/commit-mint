#!/usr/bin/env node
import { cli, command } from "cleye";
import pkg from "../package.json" with { type: "json" };

const { version } = pkg;

import { commitCommand } from "./commands/commit.js";
import { configCommand } from "./commands/config.js";
import { reviewCommand } from "./commands/review.js";
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
			review: {
				type: Boolean,
				description: "Review staged changes with a coding model",
				alias: "R",
				default: false,
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
		},
		commands: [
			command({ name: "config" }, async () => {
				await configCommand();
			}),
		],
	},
	(argv) => {
		setDebug(argv.flags.debug);
		if (argv.flags.review) {
			reviewCommand();
		} else {
			commitCommand(argv.flags);
		}
	},
);
