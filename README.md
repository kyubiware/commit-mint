# 🌿 commit-mint

[![npm version](https://img.shields.io/npm/v/@kyubiware/commit-mint.svg)](https://www.npmjs.com/package/@kyubiware/commit-mint)
[![Build Status](https://img.shields.io/github/actions/workflow/status/kyubiware/commit-mint/ci.yml?style=flat-square)](https://github.com/kyubiware/commit-mint/actions)
![Node.js](https://img.shields.io/badge/Node.js->=18-3c873a?style=flat-square)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](LICENSE)

**AI commit messages that actually handle what goes wrong.**

commit-mint generates conventional commit messages from your diff — and when hooks fail, it parses the errors and gives you a recovery menu instead of dumping raw stderr. It auto-groups unrelated changes into separate commits, runs your checks before generating messages, and caches failed attempts for instant retries.

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
●    ✓ biome
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

## Why commit-mint

Most AI commit tools generate a message and hope for the best. commit-mint handles the full loop:

- **Auto-groups files by intent** — 10 changed files across 3 concerns? Three separate commits, each with its own message. No competitor does this.
- **Hook failures get a recovery menu** — Parsed errors from biome, tsc, vitest, eslint, and lint-staged. Copy, skip, restage, edit, or cancel. No raw stderr dumps.
- **Pre-flight checks before AI generation** — `.cmintrc` runs your checks after staging but before the API call, so a failing check never wastes tokens.
- **Works without OpenAI** — Groq, Cerebras, and Mistral out of the box. No OpenAI key required.
- **Cached retries** — Failed commit? Fix the error and `cmint --retry` picks up the same message.

## Install

```bash
npm install -g @kyubiware/commit-mint
```

Or try it without installing:

```bash
npx @kyubiware/commit-mint
```

## Quick start

```bash
cmint config    # set provider + API key (interactive wizard)
cmint -a        # auto-group, generate messages, commit everything
```

On first run you'll be prompted for an API key if one isn't configured. It's saved for future runs.

## Usage

```bash
cmint -a              # auto-group and commit everything
cmint                 # interactive flow (staging → checks → review → commit)
cmint -m "feat: ..."  # skip AI, use your own message
cmint -H "context"    # pass a hint for better AI messages
cmint -r              # retry last failed commit (cached message)
cmint -N              # skip pre-flight checks
cmint -d              # debug mode (timestamped stderr)
cmint config          # interactive configuration wizard
```

## Comparison

| | commit-mint | aicommits | opencommit | cz-git | commitizen |
|---|:---:|:---:|:---:|:---:|:---:|
| **Auto-group files into commits** | ✅ | — | — | — | — |
| **Hook failure recovery menu** | ✅ | — | — | — | — |
| **Pre-commit checks in-flow** | ✅ | — | — | — | — |
| **AI message generation** | ✅ | ✅ | ✅ | ✅ | — |
| **No OpenAI required** | ✅ Groq, Cerebras, Mistral | ✅ Together, Ollama | — default OpenAI | — OpenAI only | n/a |
| **Message review before commit** | ✅ | ✅ | ✅ | ✅ interactive | ✅ interactive |
| **Zero-prompt auto mode** | ✅ | ✅ | ✅ | — | — |
| **Conventional commits** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Retry cached message** | ✅ | — | — | ✅ | — |

## Modes

### Auto mode (`-a`)

`cmint -a` runs the full pipeline with no prompts:

1. Excluded files (lockfiles, generated) are committed upfront.
2. `.cmintrc` checks run before AI grouping.
3. AI groups files into logical commits by intent.
4. Each group gets a generated conventional commit message.
5. Groups are committed sequentially. Hook failures pause the sequence with a recovery menu.

### Manual mode

Run `cmint` without flags for the interactive flow:

1. **Staging menu** — stage all, select files, auto-group, or run checks.
2. **Pre-flight checks** — `.cmintrc` checks run automatically (skip with `-N`).
3. **Message review** — review the AI message before committing.
4. **Commit** — hooks run, recovery menu on failure.

Single-file changes are staged automatically.

## Recovery menu

When a pre-commit hook blocks your commit, commit-mint parses the error and presents an interactive menu:

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

Errors are parsed from **lint-staged**, **biome**, **tsc**, **vitest**/**jest**, and **eslint**. Unrecognized output falls back to raw stderr.

## Pre-flight checks

`.cmintrc` is commit-mint's in-flow replacement for lint-staged. Define checks once at your project root and commit-mint runs them after staging but before AI generation — so failing checks never waste an API call.

```js
// .cmintrc.ts
export default {
  "*.{js,ts,json}": "biome check --write --no-errors-on-unmatched",
  "*.ts": () => ["tsc --noEmit", "vitest run --passWithNoTests"],
};
```

Glob patterns use [picomatch](https://github.com/micromatch/picomatch). String commands receive matched files as trailing arguments. Functions receive the file list and return one or more commands. Checks run sequentially and fail fast (60s timeout per command).

Supported config file names: `.cmintrc`, `.cmintrc.json`, `.cmintrc.{mjs,mts,js,ts,cjs,cts}`, `cmint.config.{mjs,mts,js,ts,cjs,cts}`

## Providers

| Provider | Env key | Default model |
|----------|---------|---------------|
| **Groq** | `GROQ_API_KEY` | `openai/gpt-oss-20b` |
| **Cerebras** | `CEREBRAS_API_KEY` | `gpt-oss-120b` |
| **Mistral** | `MISTRAL_API_KEY` | `mistral-small` |

Use `cmint config` to switch providers or override the model per-provider. All providers use OpenAI-compatible APIs (Groq via official SDK, Cerebras and Mistral via built-in fetch client).

## Configuration

Stored in `~/.commit-mint` (INI format). Run the wizard:

```bash
cmint config
```

| Key | Default | Description |
|-----|---------|-------------|
| `provider` | `groq` | AI provider (`groq`, `cerebras`, or `mistral`) |
| `model` | `openai/gpt-oss-20b` | Default model (overridable per-provider with `model_groq`, `model_cerebras`, `model_mistral`) |
| `locale` | `en` | Locale for generated messages |
| `max-length` | `100` | Max commit message length |
| `type` | — | Commit type prefix |
| `timeout` | `10000` | AI request timeout in ms |
| `proxy` | — | Proxy URL for API requests |

## Excluded files

Lockfiles, build output, and generated files are excluded from AI generation. When all staged files match excludes, commit-mint uses a hardcoded message (`chore: update lockfile` or `chore: update generated files`). In auto-group mode, lockfiles are promoted alongside their companion manifests (e.g. `package-lock.json` with `package.json`).

## Requirements

- **Node.js 18+**
- **Git**
- Optional clipboard tool for error copy: `wl-copy`, `xclip`, `xsel`, or `pbcopy`

## License

[MIT](LICENSE)
