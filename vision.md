# commit-mint

> AI-powered git commit tool — auto-group changed files, generate messages, run pre-commit checks.

## Problem

When `git commit` fails due to pre-commit hooks (lint-staged, biome, eslint, tsc, etc.), you're left staring at a wall of raw error output with no clear path forward. The commit message is lost. You have to fix the errors, remember/regenerate the message, and try again. Every AI commit tool (aicommits, lazycommit, opencommit) has this same gap — they generate a message, call `git commit`, and if hooks fail, they just die.

## What commit-mint does differently

commit-mint wraps the entire commit lifecycle — generate, attempt, recover, retry:

```
stage files → generate message → attempt commit → hooks fail?
                                                          ├─ copy errors to clipboard
                                                          ├─ skip hooks & commit
                                                          └─ re-stage & retry
```

## Core Flow

### 1. Stage
- `cmint` stages all changed tracked files (`git add -A` equivalent)
- Shows what's being staged

### 2. Generate commit message
- Uses AI (Groq by default, configurable) to analyze the diff and generate a conventional commit message
- User reviews and can edit/accept the message

### 3. Attempt commit
- Runs `git commit -m "<message>"`
- If it succeeds → done, exit

### 4. On hook failure — recovery menu
Parses the git hook error output and presents a clean TUI menu:

```
╭─────────────────────────────────────────────────╮
│  ✘ Pre-commit hook failed                       │
│                                                  │
│  Lint-staged reported 2 errors:                  │
│  • biome: src/cli.ts — unused variable           │
│  • vitest: 1 test failed in test/cli.test.ts     │
│                                                  │
│  What do you want to do?                         │
│                                                  │
│  ❯ Copy error report to clipboard                │
│    Skip hooks and commit (--no-verify)           │
│    Re-stage files and retry                      │
│    Edit commit message                           │
│    Cancel                                        │
╰─────────────────────────────────────────────────╯
```

### Recovery options explained

| Option | What it does |
|--------|-------------|
| **Copy error report** | Copies parsed, clean error output to clipboard so you can paste it into another terminal for an AI agent to fix |
| **Skip hooks** | Re-runs `git commit --no-verify` with the same message — for when hooks are wrong or you'll fix later |
| **Re-stage & retry** | `git add -A` again (picks up any fixes made in another terminal), then re-attempts commit with the same message |
| **Edit message** | Opens editor to modify the commit message, then re-attempts |
| **Cancel** | Exit. Commit message is cached for `cmint --retry` |

### Retry persistence

Failed commit messages are cached to `~/.cache/commit-mint/<repo-hash>.json`. Running `cmint --retry` reuses the last message without regenerating.

## Architecture

```
commit-mint/
├── src/
│   ├── cli.ts              # Entry point, argument parsing
│   ├── commands/
│   │   ├── commit.ts       # Main commit flow
│   │   ├── config.ts       # Config management
│   │   └── retry.ts        # Retry last commit
│   ├── services/
│   │   ├── ai.ts           # AI message generation (Groq API)
│   │   ├── git.ts          # Git operations (stage, commit, diff)
│   │   ├── hooks.ts        # Hook error parsing & formatting
│   │   └── clipboard.ts    # Cross-platform clipboard
│   ├── ui/
│   │   ├── menu.ts         # Interactive recovery menu
│   │   └── display.ts      # Colored output, spinners
│   └── utils/
│       ├── cache.ts        # Message persistence
│       └── platform.ts     # OS detection
├── package.json
├── tsconfig.json
└── README.md
```

## CLI interface

```bash
# Normal commit flow
cmint
cmint -a          # auto-stage tracked files

# Retry last failed commit
cmint --retry
cmint -r

# Skip AI, provide your own message
cmint -m "feat: add new thing"

# Config
cmint config set GROQ_API_KEY=gsk_...
cmint config get model
cmint config set model openai/gpt-oss-20b
```

## Config

Stored in `~/.commit-mint` (INI format, same as lazycommit):

```ini
GROQ_API_KEY=gsk_...
model=openai/gpt-oss-20b
locale=en
max-length=100
type=conventional
```

## Key differentiators from existing tools

1. **Hook error parsing** — No tool parses lint-staged/biome/eslint output into a clean summary. We do.
2. **Interactive recovery menu** — No tool offers copy/skip/retry as an in-flow choice. We do.
3. **Message caching on failure** — commitizen has `--retry` but only for its ecosystem. We work with plain `git commit`.
4. **Re-stage & retry loop** — Fix errors in terminal B, come back, hit retry. No tool supports this workflow.
5. **Clipboard integration** — Copy the error report, hand it to an AI coding agent, get fixes, retry.

## Dependencies (keep minimal)

- `execa` — subprocess execution (captures stderr cleanly)
- `@clack/prompts` + `kolorist` — TUI (proven in lazycommit, aicommits)
- `cleye` — CLI argument parsing (proven in lazycommit)
- `groq-sdk` — AI message generation
- `ini` — config file parsing

Zero clipboard dependency — we shell out to `xclip`/`wl-copy`/`pbcopy` based on platform.

## Target users

- Developers using pre-commit hooks (husky, lint-staged, lefthook, biome)
- Developers using AI coding agents (OpenCode, Cursor, Aider) who want to paste error output into another terminal
- Teams that want a safer `--no-verify` escape hatch with visibility

## Non-goals

- Not a hook manager (husky/lefthook exist)
- Not a linter/formatter (lint-staged/biome exist)
- Not a git TUI (lazygit/gitui exist)
- Not a commitizen replacement (just generates conventional commit messages via AI)

## Success criteria

- `npm i -g @kyubiware/commit-mint` works on macOS, Linux, WSL
- Hook failure recovery menu appears for lint-staged, biome, eslint, tsc, vitest, jest errors
- Clipboard copy works on macOS (`pbcopy`), Linux X11 (`xclip`), Linux Wayland (`wl-copy`)
- `--retry` restores last failed commit message
- Commit message generation quality matches lazycommit/aicommits
