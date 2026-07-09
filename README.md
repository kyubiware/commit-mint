<div align="center">

# 🌿 commit-mint

**AI-powered git commits — auto-group, generate, recover**

[![npm](https://img.shields.io/npm/v/@kyubiware/commit-mint.svg)](https://www.npmjs.com/package/@kyubiware/commit-mint)
[![CI](https://img.shields.io/github/actions/workflow/status/kyubiware/commit-mint/ci.yml)](https://github.com/kyubiware/commit-mint/actions)
[![GitHub stars](https://img.shields.io/github/stars/kyubiware/commit-mint?style=flat&logo=github)](https://github.com/kyubiware/commit-mint)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`commit-mint` (`cmint`) is an AI-powered wrapper around `git commit` that wraps
the full lifecycle — stage, generate, attempt, recover — and never leaves you
holding a lost message and a wall of raw stderr.

</div>

> Every AI commit tool generates a message, calls `git commit`, and dies on
> hook failure. `commit-mint` parses the failure, hands you a recovery menu
> (copy errors to clipboard, skip hooks, re-stage and retry), and caches the
> message so `cmint -r` resumes exactly where you stopped.

`cmint` runs your pre-commit checks, generates a conventional commit message
with AI, attempts the commit, and on failure shows a recovery menu with the
parsed error report ready to paste into a coding agent.

## Quick Start

```bash
npm install -g @kyubiware/commit-mint
```

```bash
cmint config  # set your API key and preferred provider
```

```bash
cmint # interactive cli for committing changes
```

## Why commit-mint?

- [x] **Checks run before the AI call.** A failing check short-circuits before
      any API call. With `lint-staged`, the hook fires after the message is
      already finalized — a broken check wastes the message.
- [x] **Failures get a recovery menu, not raw stderr.** Output from `biome`,
      `tsc`, `vitest`/`jest`, `eslint`, and `lint-staged` is parsed into
      structured errors and presented in a 6-option menu.
- [x] **Live retry.** Fix the error in another terminal, pick "Retry checks" in
      the menu — no need to exit and re-run `cmint`.
- [x] **Auto-group mode.** Ten changed files across three concerns become three
      commits, each with its own AI-generated message.
- [x] **Message caching on failure.** Cached to `~/.cache/commit-mint/`. `cmint
      -r` re-attempts with the same message after you fix the underlying issue.

## Comparison

|                                                          | commit-mint | aicommits | opencommit | cz-git  | commitizen |
| -------------------------------------------------------- | :---------: | :-------: | :--------: | :-----: | :--------: |
| **Auto-group files into commits**                        | ✅          | —         | —          | —       | —          |
| **Hook failure recovery menu**                           | ✅          | —         | —          | —       | —          |
| **Pre-commit checks in-flow** (`.cmintrc`)               | ✅          | —         | —          | —       | —          |
| **AI message generation**                                | ✅          | ✅        | ✅         | ✅      | —          |
| **No OpenAI required** (Groq, Cerebras, Mistral)         | ✅          | ✅        | —          | —       | n/a        |
| **Message review before commit**                         | ✅          | ✅        | ✅         | ✅      | ✅         |
| **Zero-prompt auto mode**                                | ✅          | ✅        | ✅         | —       | —          |
| **Conventional commits**                                 | ✅          | ✅        | ✅         | ✅      | ✅         |
| **Retry cached message** (`cmint -r`)                    | ✅          | —         | —          | ✅      | —          |

## Command Reference

```bash
cmint             # interactive: stage → checks → review → commit
cmint -a          # auto-group, generate messages, commit everything
cmint -a 3        # auto-group into exactly 3 commits
cmint -s          # stage all tracked files in single commit, skip staging menu
cmint config      # edit provider, model, locale, etc.
cmint update      # update cmint to the latest published version
```

## Pre-flight Checks (`.cmintrc`)

`.cmintrc` is commit-mint's pre-commit check system. The config syntax is
identical to [`lint-staged`](https://github.com/okonet/lint-staged) — glob keys
mapping to shell commands — but the checks run inside commit-mint's flow, not
as a separate git hook.

> **Already using `lint-staged`?** Rename your config file to `.cmintrc` — same
> syntax, no changes needed.

Run `cmint config` to auto-generate one, or create it manually:

```ts
// .cmintrc.ts
export default {
	"*.{js,ts,json}": "biome check --write --no-errors-on-unmatched --error-on-warnings",
	"*.ts": () => ["tsc --noEmit", "vitest run --passWithNoTests", "npm run build"],
};
```

(This is the actual `.cmintrc.ts` commit-mint ships with for its own
development.)

When a check fails:

```
Pre-commit check failed
  • [biome] src/services/ai.ts:12:1 lint/suspicious/noExplicitAny — Unexpected any...
  • [tsc] src/services/ai.ts:55:18 — error TS2345: Argument of type 'string' is...

What do you want to do?
  Copy error report to clipboard
  View full error output
  Retry checks
  Skip checks and commit
  Cancel
```

- **Copy error report** — copies the raw stderr to clipboard (formatted for an
  AI agent).
- **View full error output** — shows the raw stderr.
- **Retry checks** — re-runs the same checks. Fix in another terminal, hit
  enter, no restart.
- **Skip checks and commit** — proceed to commit despite the failure.
- **Cancel** — exit. The message is cached so `cmint -r` re-attempts with the
  same message.

For `tsc` failures specifically, the summary includes up to 3 `file:line:column`
diagnostics inline, with a `+N more` line if there are more.

Config shape, file name patterns, and glob matching rules are documented in
the [API Reference](#pre-flight-check-config).

## Recovery Menu

When a git hook blocks the commit, commit-mint parses the output and shows:

```
Pre-commit hook failed
  • [biome] src/cli.ts — unused variable
  • [vitest] 1 test failed in test/cli.test.ts

What do you want to do?
  Copy error report to clipboard
  View full error output
  Skip hooks and commit (--no-verify)
  Re-stage files and retry
  Edit commit message
  Cancel
```

Six options, none are dead ends:

- **Copy error report** — raw stderr to clipboard, formatted for an AI agent.
- **View full error output** — show the unparsed stderr in a note.
- **Skip hooks** — commit with `--no-verify`. Use when the failure is
  understood and not worth blocking on.
- **Re-stage** — `git add -A`, retry the commit. Picks up fixes you make in
  another terminal without restarting cmint. If re-stage still fails, the
  menu re-shows the errors.
- **Edit** — tweak the AI message, then retry.
- **Cancel** — exit. The message is cached; `cmint -r` re-attempts with the
  same message after you fix the underlying issue.

Hook progress is shown in real time during the commit — `[STARTED]` /
`[COMPLETED]` / `[FAILED]` markers from each task are streamed to stderr as
they happen.

Errors are parsed from **`lint-staged`**, **`biome`**, **`tsc`**,
**`vitest`/`jest`**, and **`eslint`**. Unrecognized output falls back to a
single raw-stderr entry.

## API Reference

### Subcommands

| Name | Description |
|---|---|
| `cmint` | Default. Run the interactive commit flow. |
| `cmint auto` | Alias for `cmint -a`. Auto-group, generate, commit. |
| `cmint config` | Interactive TUI for reading/writing `~/.commit-mint`. |
| `cmint logs` | Show the debug log from the last session. |
| `cmint update` | Update cmint to the latest published version. |

### Flags

| Flag | Description |
|---|---|
| `-a`, `--auto [N]` | Auto-group files into N commits (default: LLM decides). Use `-a 0` or `-a` for AI-determined groups |
| `-m`, `--message <msg>` | Use your own message instead of AI generation |
| `-H`, `--hint <hint>` | Context hint to the AI (e.g. `"refactor only"`) |
| `-r`, `--retry` | Retry last failed commit (uses cached message) |
| `-N`, `--noCheck` | Skip pre-flight checks |
| `-d`, `--debug` | Debug logging to stderr |
| `--agent` | Headless JSON-output mode for AI coding agents |
| `-y`, `--yes` | Skip confirmation prompt (used with `cmint update`) |

### Config Keys

Stored in `~/.commit-mint` (INI format). Run `cmint config` to edit.

| Key | Default | Description |
|---|---|---|
| `provider` | `groq` | `groq`, `cerebras`, or `mistral` |
| `model` | `openai/gpt-oss-20b` | Default model; overridable per provider |
| `model_groq` | — | Override default when provider is `groq` |
| `model_cerebras` | — | Override default when provider is `cerebras` |
| `model_mistral` | — | Override default when provider is `mistral` |
| `locale` | `en` | Locale for generated messages |
| `max-length` | `100` | Max commit message length |
| `type` | — | Force commit type prefix |
| `timeout` | `10000` | AI request timeout in ms |
| `proxy` | — | Proxy URL for API requests |
| `auto-accept` | `false` | `a` hotkey: skip message review step |
| `run-checks` | `true` | `c` hotkey: run user-defined pre-commit checks |

API key lookup checks the env var first, then the INI file.

### Environment Variables

| Variable | Used by | Required |
|---|---|---|
| `GROQ_API_KEY` | `cmint` (when `provider=groq`) | Yes, unless set in `~/.commit-mint` |
| `CEREBRAS_API_KEY` | `cmint` (when `provider=cerebras`) | Yes, unless set in `~/.commit-mint` |
| `MISTRAL_API_KEY` | `cmint` (when `provider=mistral`) | Yes, unless set in `~/.commit-mint` |
| `https_proxy` / `HTTPS_PROXY` | All providers | Optional — overrides `proxy` config key |
| `NO_COLOR` | All UI | Optional — disables `kolorist` color output |

### Providers

| Provider | Env var | Default model | Client |
|---|---|---|---|
| `groq` | `GROQ_API_KEY` | `openai/gpt-oss-20b` | `groq-sdk` |
| `cerebras` | `CEREBRAS_API_KEY` | `gpt-oss-120b` | Built-in fetch |
| `mistral` | `MISTRAL_API_KEY` | `mistral-small` | Built-in fetch |

All three use OpenAI-compatible APIs and have a generous free tier. Per-
provider model overrides: set `model_groq`, `model_cerebras`, or `model_mistral`
in `~/.commit-mint`. Resolution order is `model_<provider>` → `model` →
provider default.

### Pre-flight Check Config

#### File names

Checked in this order. First match wins.

```
.cmintrc
.cmintrc.json
.cmintrc.mjs
.cmintrc.mts
.cmintrc.js
.cmintrc.ts
.cmintrc.cjs
.cmintrc.cts
cmint.config.mjs
cmint.config.mts
cmint.config.js
cmint.config.ts
cmint.config.cjs
cmint.config.cts
```

`.ts`/`.cts`/`.cjs` are loaded via [`jiti`](https://github.com/unjs/jiti) —
use TypeScript syntax freely. `.json` is parsed as plain JSON. Everything else
is loaded as ESM with `import default`.

#### Shape

A default export. Each key is a [`picomatch`](https://github.com/micromatch/picomatch)
glob; each value is a command string, a string array, or a function that
returns either.

| Form | Behavior |
|---|---|
| `string` | Matched files are appended as trailing arguments. Paths with spaces are quoted automatically. |
| `string[]` | Commands run sequentially, each as a separate command. All commands run regardless of failures. |
| `(files) => string \| string[]` | Function receives the matched files. Use when the command depends on the file list. |

**String command:**

```ts
export default {
	"*.ts": "eslint --fix", // runs `eslint --fix src/foo.ts src/bar.ts`
};
```

**String array:**

```ts
export default {
	"*.ts": ["eslint --fix", "prettier --write"],
};
```

**Function command:**

```ts
export default {
	"*.ts": (files) =>
		files.length > 5 ? `vitest run ${files.join(" ")}` : "vitest run",
};
```

#### Glob matching

- Globs without a `/` match at any depth (e.g. `*.ts` matches `src/foo.ts` and
  `a/b/c.ts`).
- Dotfiles are included.
- Paths with spaces are quoted before being appended.

#### Behavior

- Checks run after `git add`, before the AI call.
- Globs are processed in declaration order.
- Commands run sequentially per glob. All commands and all globs always run;
  failures are collected and returned together.
- 60s timeout per command. ENOENT (command not found) and timeouts are
  reported back to the menu as their own error.
- Skipped entirely with `cmint -N` or the `c` hotkey toggle.

### Exit Codes

`cmint --agent` uses 7 documented exit codes. Interactive `cmint` always exits
with `0` or `1`.

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic error |
| 2 | No changes |
| 3 | Git error |
| 4 | AI error |
| 5 | Check failure |
| 6 | Hook failure |

### Agent JSON Output Schema

The command returns a single JSON object to stdout. See the [Agent
Flow](#agent-flow---agent) section for invocation patterns.

```ts
type AgentResult = {
	status: "success" | "no_changes" | "failure" | "cancelled";
	commits: Array<{
		message: string;
		hash: string;
		files: string[];
		groupName?: string;
	}>;
	errors?: string[];
};
```

### Excluded Files

These patterns are filtered from AI generation by default:

```
package-lock.json
node_modules/**  dist/**  build/**  .next/**  coverage/**
*.log  *.min.js  *.min.css  *.lock  .DS_Store
```

When every staged file matches an exclude, commit-mint uses a hardcoded
message: `chore: update lockfile` for lockfiles, `chore: update generated
files` for the rest. In auto-group mode, lockfiles (`package-lock.json`,
`pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`) are promoted
alongside their companion manifest (e.g. `package-lock.json` stays with
`package.json`).

### Debug Logs

`cmint --debug` streams timestamped log lines to stderr. The same log is
persisted to `~/.cache/commit-mint/debug.log` with a `--- session <ISO
timestamp> ---` header on every CLI invocation.

View the last session's log:

```bash
cmint logs              # entire last session
cmint logs -n 50        # last 50 lines
```

## Requirements

- [x] Node.js 18+
- [x] git
- [x] One of: `GROQ_API_KEY`, `CEREBRAS_API_KEY`, or `MISTRAL_API_KEY`
      (or run `cmint config` to set one)
- [x] Optional, for clipboard copy: `wl-copy`, `xclip`, `xsel`, or `pbcopy`

## Support

- [GitHub Issues](https://github.com/kyubiware/commit-mint/issues) — bug
  reports and feature requests
- [GitHub Discussions](https://github.com/kyubiware/commit-mint/discussions) —
  questions and ideas
- [npm](https://www.npmjs.com/package/@kyubiware/commit-mint) — releases and
  install stats

## Built With

- [TypeScript](https://www.typescriptlang.org/) — strict, ESM-only, `tsdown`
  bundler
- [@clack/prompts](https://github.com/natemoo-re/clack) + [`kolorist`](https://github.com/marvinhagemeister/kolorist) —
  interactive TUI primitives
- [`cleye`](https://github.com/alloc/cleye) — CLI argument parsing
- [`execa`](https://github.com/sindresorhus/execa) — subprocess execution with
  clean stderr capture
- [`groq-sdk`](https://github.com/groq/groq-typescript) — official Groq client
- [`picomatch`](https://github.com/micromatch/picomatch) — glob matching
- [`jiti`](https://github.com/unjs/jiti) — TypeScript config loader
- [`ini`](https://github.com/npm/ini) — INI config parsing
- [`semver`](https://github.com/npm/node-semver) — version comparison for
  `cmint update`

## AI Agent Skill

> If you're an AI coding agent, this section is for you.

Install `commit-mint` as a skill in OpenCode, Cursor, or any agent that loads
[npm skills](https://www.npmjs.com/package/skills):

```bash
npx skills add kyubiware/commit-mint
```

The skill teaches the agent the non-interactive agent flow:

1. Run `cmint --agent` (or `cmint --agent --noCheck` to skip pre-commit
   checks).
2. Parse the JSON `AgentResult` from stdout.
3. Read the `process.exitCode` against the [Exit Codes](#exit-codes) table.

The agent never has to interact with the recovery menu — failures are
surfaced as `status: "failure"` with an `errors[]` array, or one of the
`--agent`-specific exit codes (3 = git, 4 = AI, 5 = check, 6 = hook).

For OpenCode, the skill is also shipped with the project at
[`skills/cmint/SKILL.md`](skills/cmint/SKILL.md).

## License

[MIT](LICENSE)
