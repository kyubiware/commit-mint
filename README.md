# commit-mint

[![npm](https://img.shields.io/npm/v/@kyubiware/commit-mint.svg)](https://www.npmjs.com/package/@kyubiware/commit-mint)
[![CI](https://img.shields.io/github/actions/workflow/status/kyubiware/commit-mint/ci.yml)](https://github.com/kyubiware/commit-mint/actions)
[![Node](https://img.shields.io/badge/node-%3E%3D18-3c873a)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A commit tool that handles hook failures. Generates conventional commit messages
from your diff, auto-groups unrelated changes into separate commits, runs your
checks before any API call, and gives you a recovery menu when hooks block the
commit instead of dumping raw stderr.

## Install

```bash
npm install -g @kyubiware/commit-mint
```

Or run without installing:

```bash
npx @kyubiware/commit-mint
```

Requires Node.js 18+ and git. Run `cmint config` once to set the AI provider and
API key. The key is saved to `~/.commit-mint` (INI).

## Usage

```bash
cmint                  # interactive: stage → checks → review → commit
cmint -a               # auto-group, generate messages, commit everything
cmint -m "feat: ..."   # skip AI, use your own message
cmint -H "context"     # hint to the AI (e.g. "refactor only, no behavior change")
cmint -r               # retry the last failed commit (cached message)
cmint -N               # skip pre-flight checks
cmint -d               # debug logging to stderr
cmint config           # edit provider, model, locale, etc.
```

## Pre-flight checks (`.cmintrc`)

`.cmintrc` is commit-mint's pre-commit check system. The config syntax is
identical to [lint-staged](https://github.com/okonet/lint-staged) — glob keys
mapping to shell commands — but the checks run inside commit-mint's flow, not
as a separate git hook.

This matters for three reasons:

**1. Checks run before the AI call.** commit-mint runs checks before
generating the commit message. A failing check short-circuits before any API
call. With lint-staged, the hook fires after the message is already finalized
(if the AI call was made) or the user has typed one in — so a broken check
wastes the message.

**2. Failures get a recovery menu, not raw stderr.** lint-staged prints whatever
the tool emitted and exits. commit-mint parses biome, tsc, vitest/jest, eslint,
and lint-staged output into structured errors. Then commit-mint lets you copy the error report to clipboard,
so you can paste straight to your coding agent.

**3. Live retry.** After your coding agent fixes the error in another terminal, pick "Retry checks" in
the menu, no need to exit and re-run `cmint`.

Same syntax, fewer moving parts, and the checks live in the same process as
the rest of the commit.

### Config file names

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

`.ts`/`.cts`/`.cjs` are loaded via [jiti](https://github.com/unjs/jiti) — use
TypeScript syntax freely. `.json` is parsed as plain JSON. Everything else is
loaded as ESM with `import default`.

### Config shape

A default export. Each key is a [picomatch](https://github.com/micromatch/picomatch)
glob; each value is a command string, a string array, or a function that
returns either.

```ts
// .cmintrc.ts
export default {
	"*.{js,ts,json}": "biome check --write --no-errors-on-unmatched --error-on-warnings",
	"*.ts": () => ["tsc --noEmit", "vitest run --passWithNoTests", "npm run build"],
};
```

This is the actual `.cmintrc.ts` commit-mint ships with for its own
development — biome on staged JS/TS/JSON, then tsc + vitest + build on staged
TS.

**String commands** get matched files appended as trailing arguments. Files
with spaces in their paths are quoted automatically.

```ts
export default {
	"*.ts": "eslint --fix", // runs `eslint --fix src/foo.ts src/bar.ts`
};
```

**String arrays** run sequentially, each as a separate command. First failure
stops the run.

```ts
export default {
	"*.ts": ["eslint --fix", "prettier --write"],
};
```

**Function commands** receive the matched files and return a command or array
of commands. Use these when the command depends on the file list, or you want
multiple commands from one glob:

```ts
export default {
	"*.ts": (files) =>
		files.length > 5 ? `vitest run ${files.join(" ")}` : "vitest run",
};
```

### Glob matching

- Globs without a `/` match at any depth (e.g. `*.ts` matches `src/foo.ts` and
  `a/b/c.ts`).
- Dotfiles are included.
- Paths with spaces are quoted before being appended.

### Behavior

- Checks run after `git add`, before the AI call.
- Globs are processed in declaration order.
- Commands run sequentially per glob. First failure stops the run (fail-fast)
  and skips remaining globs.
- 60s timeout per command. ENOENT (command not found) and timeouts are
  reported back to the menu as their own error.
- Skipped entirely with `cmint -N`.

### Failure menu

When a check fails, the same `parseHookErrors` pipeline that handles git
hooks runs, and a menu appears:

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

- **Copy error report** — copies the raw stderr (works with `wl-copy`,
  `xclip`, `xsel`, or `pbcopy`).
- **View full error output** — shows the raw stderr.
- **Retry checks** — re-runs the same checks. Fix in another terminal, hit
  enter, no restart.
- **Skip checks and commit** — proceed to commit despite the failure.
- **Cancel** — exit. The message is cached so `cmint -r` re-attempts with the
  same message.

For tsc failures specifically, the summary includes up to 3 file:line:column
diagnostics inline, with a `+N more` line if there are more.

## Auto-group mode (`-a`)

When you have 10 changed files across 3 concerns, `cmint -a` makes 3 commits,
each with its own message. The flow:

1. Excluded files (lockfiles, build output) are committed upfront with a
   hardcoded `chore: update lockfile` message.
2. `.cmintrc` checks run on the remaining files.
3. The AI groups files by intent.
4. Each group is staged, diffed, and committed sequentially. A per-group
   message is generated, and (in non-`auto` mode) reviewed.
5. A hook failure on any group shows the recovery menu and stops the sequence
   — the remaining groups are not committed.

`cmint` (no `-a`) on multiple files shows a staging menu:

```
What do you want to stage?
  Stage all files
  Select files...
  Auto-group into commits
  Run checks
```

## Recovery menu

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

Errors are parsed from **lint-staged**, **biome**, **tsc**, **vitest**/**jest**,
and **eslint**. Unrecognized output falls back to a single raw-stderr entry.

## Providers

| Provider | Env var           | Default model        |
| -------- | ----------------- | -------------------- |
| Groq     | `GROQ_API_KEY`    | `openai/gpt-oss-20b` |
| Cerebras | `CEREBRAS_API_KEY` | `gpt-oss-120b`     |
| Mistral  | `MISTRAL_API_KEY` | `mistral-small`      |

All three use OpenAI-compatible APIs. Groq uses the official SDK; Cerebras and
Mistral use a built-in fetch client. Per-provider model overrides: set
`model_groq`, `model_cerebras`, or `model_mistral` in `~/.commit-mint`.
Resolution order is `model_<provider>` → `model` → provider default.

`cmint config` walks you through provider, API key, model, locale, and
timeout.

## Configuration

`~/.commit-mint` (INI format). Run `cmint config` to edit.

| Key              | Default              | Description                                       |
| ---------------- | -------------------- | ------------------------------------------------- |
| `provider`       | `groq`               | `groq`, `cerebras`, or `mistral`                  |
| `model`          | `openai/gpt-oss-20b` | Default model; overridable per provider           |
| `model_groq`     | —                    | Override default when provider is `groq`          |
| `model_cerebras` | —                    | Override default when provider is `cerebras`      |
| `model_mistral`  | —                    | Override default when provider is `mistral`       |
| `locale`         | `en`                 | Locale for generated messages                     |
| `max-length`     | `100`                | Max commit message length                         |
| `type`           | —                    | Force commit type prefix                          |
| `timeout`        | `10000`              | AI request timeout in ms                          |
| `proxy`          | —                    | Proxy URL for API requests                        |

API key lookup checks the env var first, then the INI file.

## Excluded files

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

## Requirements

- Node.js 18+
- git
- Optional, for clipboard copy: `wl-copy`, `xclip`, `xsel`, or `pbcopy`

## License

[MIT](LICENSE)
