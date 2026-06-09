# commit-mint

[![npm version](https://img.shields.io/npm/v/@kyubiware/commit-mint.svg)](https://www.npmjs.com/package/@kyubiware/commit-mint)
[![Build Status](https://img.shields.io/github/actions/workflow/status/kyubiware/commit-mint/ci.yml?style=flat-square)](https://github.com/kyubiware/commit-mint/actions)
![Node.js](https://img.shields.io/badge/Node.js->=18-3c873a?style=flat-square)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

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
│
●  Commit group 2 of 3: "Panel refactor"
◇  Message generated
│
●  feat(text-study): add compound component support to ReadingInspectorPanel
│
◇  Committed successfully.
│
└  All groups committed.
```

## Quick start

```bash
npm install -g @kyubiware/commit-mint
cmint -a
```

On first run, you'll be prompted for an API key if one isn't set. It's saved for future runs.

## Features

- **Auto-group by intent** — AI reads your diff and groups files into logical commits. No more `feat: update stuff` that bundles unrelated changes.
- **Zero-prompt auto mode** — `cmint -a` stages, groups, generates messages, and commits without a single prompt.
- **Hook failures handled in-flow** — Parsed error summary with a recovery menu to copy, skip, retry, or edit. No raw stderr dumps.
- **Multi-provider AI** — Works with Groq, Cerebras, and Mistral out of the box. Per-provider model configuration supported.
- **Built-in pre-commit checks** — Define checks in a cmint config file and run them before AI generation. A failing check never wastes an API call.
- **Message caching on failure** — A failed commit caches its message. Fix the error, run `cmint --retry`, and pick up where you left off.

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

# Skip pre-commit checks
cmint -N

# Debug mode
cmint -d

# Configuration
cmint config get GROQ_API_KEY
cmint config set GROQ_API_KEY=gsk_...
cmint config set provider cerebras
cmint config set model openai/gpt-oss-20b
```

| Flag | Description |
|------|-------------|
| `-a, --auto` | Auto-group files into commits, accept all messages |
| `-m, --message` | Provide a commit message directly (skip AI) |
| `-H, --hint` | Add context hint for AI message generation |
| `-r, --retry` | Retry the last failed commit |
| `-N, --noCheck` | Skip pre-commit checks |
| `-d, --debug` | Enable debug output |
| `-h, --help` | Show help |
| `-v, --version` | Show version |

## Modes

### Auto mode (`-a`)

`cmint -a` runs the full pipeline with no prompts:

1. AI analyzes all changed files
2. Files are grouped into logical commits by intent
3. Each group gets its own AI-generated conventional commit message
4. Groups are committed sequentially
5. Hook failures per group trigger the recovery menu

### Manual mode

Run `cmint` without flags for the interactive flow:

1. **Staging menu** — stage all, select files, auto-group, or run checks
2. **File selection** — multi-select specific files if you don't want everything
3. **Message review** — review the AI-generated message before committing
4. **Commit attempt** — hooks run, recovery menu appears on failure

If only one file changed, it's staged automatically.

## Providers

commit-mint supports multiple AI providers with per-provider configuration:

| Provider | Env key | Default model |
|----------|---------|---------------|
| **Groq** | `GROQ_API_KEY` | `openai/gpt-oss-20b` |
| **Cerebras** | `CEREBRAS_API_KEY` | `gpt-oss-120b` |
| **Mistral** | `MISTRAL_API_KEY` | `mistral-small` |

Switch providers with `cmint config set provider <name>`. Override the model per-provider with `cmint config set model_cerebras <model>`.

> [!TIP]
> All providers use OpenAI-compatible APIs. Groq uses the official SDK; Cerebras and Mistral use a built-in fetch client.

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
│    View full output                              │
│    Skip hooks and commit (--no-verify)           │
│    Re-stage files and retry                      │
│    Edit commit message                           │
│    Cancel                                        │
╰─────────────────────────────────────────────────╯
```

| Option | What it does |
|--------|-------------|
| **Copy error report** | Copies parsed, clean error output to clipboard |
| **View full output** | Shows raw stderr from the failed hook |
| **Skip hooks** | Re-runs `git commit --no-verify` with the same message |
| **Re-stage & retry** | Runs `git add -A` again, then retries the commit |
| **Edit message** | Opens a prompt to modify the commit message, then retries |
| **Cancel** | Exits. Commit message is cached for `cmint --retry` |

Errors are parsed from **lint-staged**, **biome**, **TypeScript** (`tsc`), **vitest**/**jest**, and **ESLint**. Unrecognized output falls back to raw stderr.

## Pre-commit checks

Define custom checks in a cmint config file at your project root. Supported file names (checked in priority order):

`.cmintrc`, `.cmintrc.json`, `.cmintrc.{mjs,mts,js,ts,cjs,cts}`, `cmint.config.{mjs,mts,js,ts,cjs,cts}`

Checks run after staging, before AI message generation, so a failing check never wastes an API call.

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

Use `.cmintrc.ts` or `cmint.config.ts` for type safety without adding commit-mint as a project dependency:

```ts
interface Cmintrc {
  [glob: string]: string | string[] | ((filenames: string[]) => string | string[]);
}

export default {
  "*.{js,ts,json}": "biome check --write --no-errors-on-unmatched",
  "*.ts": () => ["tsc --noEmit", "vitest run --passWithNoTests"],
} satisfies Cmintrc;
```

This gives you editor autocomplete and catches invalid values at edit time — no package install needed.

Checks execute sequentially and fail fast. Each command has a 60-second timeout.

### Check failure menu

When a check fails, you get a menu with four options:

| Option | What it does |
|--------|-------------|
| **Copy error report** | Copies the error output to clipboard |
| **View full output** | Shows the raw check output |
| **Skip checks** | Proceeds without running checks |
| **Cancel** | Exits. Message is cached for `cmint --retry` |

Pass `--noCheck` or `-N` to skip checks entirely.

## Configuration

Stored in `~/.commit-mint` (INI format). Set values via `cmint config set <key> <value>`.

```ini
provider=groq
GROQ_API_KEY=gsk_...
model=openai/gpt-oss-20b
locale=en
max-length=100
type=conventional
timeout=10000
proxy=
```

| Key | Default | Description |
|-----|---------|-------------|
| `provider` | `groq` | AI provider (`groq`, `cerebras`, or `mistral`) |
| `GROQ_API_KEY` | — | Groq API key (or set `GROQ_API_KEY` env var) |
| `CEREBRAS_API_KEY` | — | Cerebras API key (or set `CEREBRAS_API_KEY` env var) |
| `MISTRAL_API_KEY` | — | Mistral API key (or set `MISTRAL_API_KEY` env var) |
| `model` | `openai/gpt-oss-20b` | Default AI model for message generation |
| `model_groq` | — | Model override for Groq provider |
| `model_cerebras` | — | Model override for Cerebras provider |
| `model_mistral` | — | Model override for Mistral provider |
| `locale` | `en` | Locale for generated messages |
| `max-length` | `100` | Maximum commit message length |
| `type` | — | Commit type prefix (e.g. `conventional`) |
| `timeout` | `10000` | AI request timeout in ms |
| `proxy` | — | Proxy URL for API requests |

Model resolution follows a chain: `model_<provider>` → global `model` → provider default. Per-provider keys prevent cross-provider model leaks when switching providers.

## Retry persistence

Failed commit messages are cached to `~/.cache/commit-mint/<repo-hash>.json`. Running `cmint --retry` reuses the last message without regenerating. Fix errors in another terminal, come back, and retry.

## Requirements

- **Node.js 18+**
- **Git** (any modern version)
- **Linux** (primary target; macOS works via `pbcopy`; WSL untested)
- **xclip**, **wl-copy**, **xsel**, or **pbcopy** for clipboard support

## Non-goals

- Not a git hook manager — cmint config checks run in-flow, not via git hooks. For git hooks, use husky or lefthook.
- Not a linter/formatter — use biome, eslint, or prettier.
- Not a git TUI — use lazygit or gitui.
- Not a commitizen replacement — generates conventional commit messages via AI.
