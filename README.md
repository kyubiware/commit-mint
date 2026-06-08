# commit-mint

[![npm version](https://img.shields.io/npm/v/@kyubiware/commit-mint.svg)](https://www.npmjs.com/package/@kyubiware/commit-mint)

> Auto-group your changes into clean, conventional commits. AI handles the grouping, messages, and hook failures so you don't have to.

```
┌  commit-mint
│
◇  Files analyzed
│
●  Commit group 1 of 3: "Reading view refactor"
│
◇  Message generated
│
●  feat(compound): add compound utilities and token handling for text study
│
◇  Committed successfully.
│
●    ✓ prettier
│    ✓ eslint
│    ✓ tsc
│    ✓ vitest
◇  Message generated
│
●  feat(text-study): add compound component support to ReadingInspectorPanel
│
◇  Committed successfully.
│
●    ✓ prettier
│    ✓ eslint
│    ✓ tsc
│    ✓ vitest
│
●  Commit group 3 of 3: "Reading study list update"
◇  Message generated
│
●  feat(reading-study-list-body): add compound component support to reading study list
│
◇  Committed successfully.
│
●    ✓ prettier
│    ✓ eslint
│    ✓ tsc
│    ✓ vitest
│
└  All groups committed.
```

Requires **Node.js 18+**.

## Quick Start

```bash
npm install -g @kyubiware/commit-mint
```

```bash
cmint -a
```

On first run, you'll be prompted for a `GROQ_API_KEY` if it's not set in `~/.commit-mint` or as an environment variable. It's saved for future runs.

## Why commit-mint?

- **Auto-group by intent.** AI reads your diff and groups files into logical commits. No more `feat: update stuff` that bundles unrelated changes.
- **Zero-prompt auto mode.** `cmint -a` stages, groups, generates messages, and commits without a single prompt. Walk away and come back to clean history.
- **Hook failures handled in-flow.** When pre-commit hooks fail, you get a parsed error summary and a menu to copy, skip, retry, or edit. No raw stderr dumps.
- **Built-in pre-commit checks.** Define checks in a cmint config file and run them before AI generation. A failing check never wastes an API call.
- **Message caching on failure.** A failed commit caches its message. Fix the error, run `cmint --retry`, and pick up exactly where you left off.
- **Review before you commit.** Every message can be accepted, edited, or reviewed with OpenCode before it hits the repo.

## Auto mode (`-a`)

`cmint -a` is the primary way to use commit-mint. It runs the full pipeline with no prompts:

1. AI analyzes all changed files
2. Files are grouped into logical commits by intent
3. Each group gets its own AI-generated conventional commit message
4. Groups are committed sequentially
5. Hook failures per group trigger the recovery menu

Use this when you want clean history without the ceremony.

## Manual mode

Run `cmint` without flags for the interactive flow:

1. **Staging menu** — stage all, select files, auto-group, or cancel
2. **File selection** — multi-select specific files if you don't want everything
3. **Message review** — review the AI-generated message before committing
4. **Commit attempt** — hooks run, recovery menu appears on failure

If only one file changed, it's staged automatically.

## Usage

```bash
# Auto-group and commit everything (no prompts)
cmint -a

# Normal interactive flow
cmint

# Skip AI, provide your own message
cmint -m "feat: add dark mode"

# Pass context hint for better messages
cmint -H "refactoring auth module"

# Retry last failed commit (uses cached message)
cmint -r

# Review staged changes with AI
cmint -R

# Skip pre-commit checks
cmint -n

# Debug mode
cmint -d

# Configuration
cmint config get GROQ_API_KEY
cmint config set GROQ_API_KEY=gsk_...
cmint config set model openai/gpt-oss-20b
```

| Flag | Description |
|------|-------------|
| `-a, --auto` | Auto-group files into commits, accept all messages |
| `-m, --message` | Provide a commit message directly (skip AI) |
| `-H, --hint` | Add context hint for AI message generation |
| `-r, --retry` | Retry the last failed commit |
| `-R, --review` | Review staged changes with a coding model |
| `-n, --noCheck` | Skip pre-commit checks |
| `-d, --debug` | Enable debug output |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

## Message review

Before every commit, choose what to do with the generated message:

- **Use as-is** — accept the AI-generated message
- **Edit** — modify the message in a prompt
- **Review with OpenCode** — run a code review on staged changes before committing
- **Cancel** — exit (message is cached for `--retry`)

## Recovery menu

When a pre-commit hook blocks your commit, commit-mint parses the error output and presents an interactive menu:

```
╭─────────────────────────────────────────────────╮
│  ✘ Pre-commit hook failed                       │
│                                                  │
│  • biome: src/cli.ts — unused variable           │
│  • vitest: 1 test failed in test/cli.test.ts     │
│                                                  │
│  What do you want to do?                         │
│                                                  │
│    Copy error report to clipboard                │
│    Skip hooks and commit (--no-verify)           │
│    Re-stage files and retry                      │
│    Edit commit message                           │
│    Cancel                                        │
╰─────────────────────────────────────────────────╯
```

| Option | What it does |
|--------|-------------|
| **Copy error report** | Copies parsed, clean error output to clipboard |
| **Skip hooks** | Re-runs `git commit --no-verify` with the same message |
| **Re-stage & retry** | Runs `git add -A` again, then retries the commit |
| **Edit message** | Opens a prompt to modify the commit message, then retries |
| **Cancel** | Exits. Commit message is cached for `cmint --retry` |

The recovery menu also appears when cmint config pre-commit checks fail.

commit-mint parses errors from **lint-staged**, **biome**, **TypeScript** (`tsc`), **vitest** / **jest**, and **ESLint**. Unrecognized output falls back to raw stderr.

## Pre-commit checks

Define custom checks in a cmint config file at your project root. Supported file names (checked in priority order):
`.cmintrc`, `.cmintrc.json`, `.cmintrc.{mjs,mts,js,ts,cjs,cts}`, `cmint.config.{mjs,mts,js,ts,cjs,cts}`

They run after staging, before AI message generation, so a failing check never wastes an API call.

```js
export default {
  // String: matched files are appended as arguments
  "*.{js,ts,json}": "biome check --write --no-errors-on-unmatched",

  // Function: receive matched filenames, return command(s)
  "*.ts": () => ["tsc --noEmit", "vitest run --passWithNoTests"],
};
```

Glob patterns use [picomatch](https://github.com/micromatch/picomatch). String commands receive matched files as trailing arguments. Functions receive the matched file list and return one or more commands to run.

### TypeScript config

Use `.cmintrc.ts` or `cmint.config.ts` for type safety without adding commit-mint as a project dependency. Add an inline interface and use `satisfies`:

```ts
interface Cmintrc {
  [glob: string]: string | string[] | ((filenames: string[]) => string | string[]);
}

export default {
  "*.{js,ts,json}": "biome check --write --no-errors-on-unmatched",
  "*.ts": () => ["tsc --noEmit", "vitest run --passWithNoTests"],
} satisfies Cmintrc;
```

This gives you editor autocomplete and catches invalid values (e.g. numbers, objects) at edit time — no package install needed.

Checks execute sequentially and fail fast. Each command has a 60-second timeout.

### When checks run

- **Manual mode**: The staging menu shows a "Run checks" option when a cmint config file exists
- **Auto-group mode**: Checks run automatically on all staged files before grouping
- **Normal commit**: Checks run on staged files after staging, before diff/AI

### Check failure menu

When a check fails, you get a menu with three options:

| Option | What it does |
|--------|-------------|
| **Copy error report** | Copies the error output to clipboard |
| **Skip checks** | Proceeds without running checks |
| **Cancel** | Exits. Message is cached for `cmint --retry` |

Pass `--noCheck` or `-n` to skip checks entirely.

## Code review

Run `cmint --review` or `cmint -R` to review staged changes without committing. commit-mint checks for [OpenCode](https://github.com/opencode-ai/opencode) first, then falls back to Groq API. The review covers bugs, security issues, performance problems, and edge cases.

## Configuration

Stored in `~/.commit-mint` (INI format):

```ini
GROQ_API_KEY=gsk_...
model=openai/gpt-oss-20b
locale=en
type=conventional
timeout=10000
proxy=
```

| Key | Default | Description |
|-----|---------|-------------|
| `GROQ_API_KEY` | — | Groq API key for AI message generation |
| `model` | `openai/gpt-oss-20b` | AI model for commit message generation |
| `locale` | `en` | Locale for generated messages |
| `type` | — | Commit type prefix (e.g. `conventional`) |
| `timeout` | `10000` | AI request timeout (ms) |
| `proxy` | — | Proxy URL for API requests |

You can also set `GROQ_API_KEY` via environment variable.

## CLI reference

```
cmint --help

  cmint

  A commit tool that actually handles hook failures

  Options:
    --retry, -r      Retry the last failed commit (default: false)
    --auto, -a       Auto-group files into commits, accept all messages (default: false)
    --message, -m    Provide a commit message directly (skip AI generation)
    --hint, -H       Add context hint for AI commit message generation
    --review, -R     Review staged changes with a coding model (default: false)
    --noCheck, -n    Skip pre-commit checks (default: false)
    --debug, -d      Enable debug output (default: false)
    --help, -h       Show help
    --version, -v    Show version

  Commands:
    config           Get/set configuration values
```

## Retry persistence

Failed commit messages are cached to `~/.cache/commit-mint/<repo-hash>.json`. Running `cmint --retry` reuses the last message without regenerating. Fix errors in another terminal, come back, and retry.

## How it works

```
commit-mint/
├── src/
│   ├── cli.ts              # Entry point, argument parsing (cleye)
│   ├── commands/
│   │   ├── commit.ts       # Main commit flow orchestrator
│   │   ├── auto-group.ts   # Auto-group multi-commit flow
│   │   ├── review.ts       # Code review command
│   │   └── config.ts       # Config get/set subcommand
│   ├── services/
│   │   ├── git.ts          # Git operations (stage, commit, diff, HEAD)
│   │   ├── ai.ts           # Groq AI commit message generation (3-tier diff compression)
│   │   ├── grouping.ts     # AI-powered file grouping into logical commits
│   │   ├── review-ai.ts    # AI code review via Groq
│   │   ├── hooks.ts        # Hook error parser (lint-staged, biome, tsc, etc.)
│   │   ├── checks.ts       # Pre-commit checks via cmint config files (glob matching, command execution)
│   │   ├── config.ts       # INI config read/write at ~/.commit-mint
│   │   └── clipboard.ts    # Cross-platform clipboard (xclip/wl-copy/pbcopy)
│   ├── ui/
│   │   ├── menu.ts         # Interactive recovery TUI + staging menu
│   │   ├── grouping.ts     # Grouping confirmation UI
│   │   └── review-message.ts # Message review step (use/edit/review/cancel)
│   └── utils/
│       ├── cache.ts        # Commit message persistence at ~/.cache/commit-mint/
│       └── debug.ts        # Timestamped debug logging to stderr
```

## Requirements

- **Node.js 18+**
- **Git** (any modern version)
- **Linux** (primary target; macOS works via `pbcopy`; WSL untested)
- **xclip**, **wl-copy**, **xsel**, or **pbcopy** for clipboard support

## Non-goals

- Not a git hook manager — cmint config checks run in-flow, not via git hooks. For git hooks, use husky or lefthook
- Not a linter/formatter — use biome, eslint, prettier
- Not a git TUI — use lazygit, gitui
- Not a commitizen replacement — just generates conventional commit messages via AI

## License

MIT © kyubiware
