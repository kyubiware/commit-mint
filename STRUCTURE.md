# Codebase Structure

## Directory Layout

```
commit-mint/
├── src/
│   ├── cli.ts                  # CLI entry point (cleye argument parser)
│   ├── commands/
│   │   ├── commit.ts           # Main commit flow orchestrator
│   │   ├── commit.test.ts      # Commit flow unit tests
│   │   ├── auto-group.ts       # Auto-group multi-commit flow
│   │   ├── auto-group.test.ts  # Auto-group flow tests
│   │   ├── config.ts           # `cmint config get/set` subcommand
│   │   └── config.ts           # Config get/set subcommand
│   ├── services/
│   │   ├── ai.ts               # Groq AI commit message generation (3-tier diff compression)
│   │   ├── ai.test.ts          # AI service tests
│   │   ├── git.ts              # Git operations (stage, diff, commit, HEAD, status)
│   │   ├── git.test.ts         # Git service tests
│   │   ├── hooks.ts            # Hook error parser (lint-staged, biome, tsc, vitest/jest, eslint) + tool check summary
│   │   ├── config.ts           # INI config read/write at ~/.commit-mint
│   │   ├── clipboard.ts        # Cross-platform clipboard (wl-copy/xclip/xsel/pbcopy)
│   │   ├── clipboard.test.ts   # Clipboard service tests
│   │   ├── grouping.ts         # AI-powered file grouping into logical commits
│   │   ├── grouping.test.ts    # Grouping service tests
│   │   └── lint-staged.ts      # lint-staged config detection and runner
│   ├── ui/
│   │   ├── menu.ts             # Interactive recovery TUI + staging menu
│   │   ├── menu.test.ts        # Menu UI tests
│   │   ├── review-message.ts   # Message review step (use-as-is/edit/cancel)
│   │   └── grouping.ts         # Grouping confirmation UI + progress display
│   └── utils/
│       ├── cache.ts            # Commit message persistence at ~/.cache/commit-mint/
│       ├── debug.ts            # Timestamped debug logging to stderr
│       └── debug.test.ts       # Debug utility tests
├── dist/                       # Build output (gitignored)
├── coverage/                   # Test coverage reports (gitignored)
├── notes/                      # Project notes
├── .sisyphus/                  # Sisyphus planning system (drafts, evidence, plans)
├── biome.json                  # Biome linter/formatter config (tab indent, 100 width)
├── tsconfig.json               # TypeScript config (ES2022, ESNext modules, bundler resolution)
├── vitest.config.ts            # Vitest test runner config with v8 coverage
├── .lintstagedrc.mjs            # lint-staged config: biome check, tsc, vitest run
├── package.json                # Package manifest (ESM, bin: dist/cli.mjs)
└── README.md                   # Project documentation
```

## Directory Purposes

**`src/commands/`:**
- Purpose: Top-level command orchestrators for the CLI
- Contains: Async functions exported as command handlers
- Key files: `commit.ts` (main lifecycle with staging menu), `auto-group.ts` (multi-commit auto-group flow), `config.ts` (config get/set)

**`src/services/`:**
- Purpose: Encapsulated system integrations and business logic
- Contains: Git operations, AI generation, hook parsing, config I/O, clipboard, file grouping, lint-staged runner
- Key files: `git.ts` (all git subprocess calls, ChangedFile/DiffResult types), `ai.ts` (Groq SDK + 3-tier diff compression + think tag stripping + reasoning fallback), `hooks.ts` (error parsers + tool check summary), `config.ts` (INI config), `clipboard.ts` (shell-out clipboard, returns boolean), `grouping.ts` (AI file grouping + exclude filtering + lockfile companion promotion), `lint-staged.ts` (config file detection + npx lint-staged runner)

**`src/ui/`:**
- Purpose: Interactive terminal user interface
- Contains: Recovery TUI, staging menu, message review step, grouping confirmation UI
- Key files: `menu.ts` (5-option recovery menu with clipboard state tracking + staging menu with file selection/auto-group/lint-staged), `review-message.ts` (3-option message review: use-as-is/edit/cancel), `grouping.ts` (grouping confirmation with file list + commit group progress display)

**`src/utils/`:**
- Purpose: Generic utilities with no business logic or side effects
- Contains: Cache persistence, debug logging
- Key files: `cache.ts` (JSON file cache, 12-char SHA-256 prefix), `debug.ts` (module-level debug gate)

**`dist/`:**
- Purpose: Build output directory
- Contains: Compiled ESM bundle (`cli.mjs`), type declarations (`cli.d.ts`)
- Note: Gitignored; produced by `tsdown`

**`.sisyphus/`:**
- Purpose: Sisyphus planning system artifacts
- Contains: Drafts, evidence, notepads, plans, run-continuation state
- Note: Not part of application code

## Key File Locations

**Entry Points:** `src/cli.ts`: Shebang script that parses argv via `cleye`, sets debug mode, dispatches to `commitCommand` or `configCommand`

**Configuration:** `src/services/config.ts`: Reads/writes INI at `~/.commit-mint`, merged with defaults (model, locale, max-length, type, timeout, proxy). `getApiKey()` checks `$GROQ_API_KEY` env var first, then config file

**Core Logic:** `src/commands/commit.ts` (340 lines): Orchestrates stage → generate → review → commit → recover lifecycle with staging menu, excluded files handling, and lint-staged integration. `src/commands/auto-group.ts` (193 lines): Orchestrates multi-commit auto-group flow with file filtering, AI grouping, confirmation, and sequential per-group commits. `src/services/ai.ts` (304 lines): 3-tier diff compression, Groq API call, think tag stripping, reasoning fallback, conventional commit validation + retry with strict prompt. `src/services/grouping.ts` (261 lines): AI file grouping with exclude filtering, lockfile companion promotion, grouping validation, orphan file handling

**Tests:** Co-located `*.test.ts` siblings in `src/commands/`, `src/services/`, `src/ui/`, `src/utils/`

**Lint config:** `biome.json`: Tab indentation, 100 character line width. `.lintstagedrc.mjs`: Runs biome check, tsc, and vitest on staged ts files

**TypeScript config:** `tsconfig.json`: ES2022 target, ESNext modules, bundler resolution, strict mode, output to `dist/`

**Test runner:** `vitest.config.ts`: Vitest with v8 coverage provider

## Naming Conventions

**Files:** `camelCase.ts` — `commit.ts`, `auto-group.ts`, `config.ts`, `hooks.ts`, `clipboard.ts`, `grouping.ts`, `cache.ts`, `debug.ts`. Test files use `.test.ts` suffix: `commit.test.ts`, `ai.test.ts`, `git.test.ts`, `debug.test.ts`, `menu.test.ts`, `grouping.test.ts`, `clipboard.test.ts`

**Directories:** Single-word lowercase: `commands/`, `services/`, `ui/`, `utils/`

**Exports:** Named function exports — `export async function commitCommand(...)`, `export function parseHookErrors(...)`, `export async function runAutoGroupFlow(...)`; default exports are never used

**Imports:** ESM with `.js` extension — `import { x } from "../services/ai.js"` (NOT `../services/ai`)

## Where to Add New Code

**New CLI flag:** `src/cli.ts` — add to the `flags` object in `cli()`, then pass through to `commitCommand` or route to a new command handler

**New commit flow step:** `src/commands/commit.ts` — extend the main lifecycle in `commitCommand`

**New auto-group flow step:** `src/commands/auto-group.ts` — extend the sequential multi-commit loop in `runAutoGroupFlow`

**New hook error parser:** `src/services/hooks.ts` — add a `parse*Errors` function, wire into `parseHookErrors` switch, update tests to cover behavior with all existing parsers

**New recovery menu option:** `src/ui/menu.ts` — add to the options array in `select()` and add a `case` in the `switch`; update `RecoveryResult` type if adding new result states

**New staging menu option:** `src/ui/menu.ts` — add to the options array in `select()` in `showStagingMenu`, return the appropriate type from `StagingChoice | "autogroup" | "lint-staged" | null`

**New AI model or prompt strategy:** `src/services/ai.ts` — extend `generateCommitMessage`, `buildSystemPrompt`, or `compressDiff`

**New grouping strategy:** `src/services/grouping.ts` — extend `generateGroups` or `validateGroups`; update `filterExcludedFiles` for new exclude patterns

**New lint-staged behavior:** `src/services/lint-staged.ts` — extend `hasLintStagedConfig` with new config file names, or change `runLintStaged` arguments

**New service:** `src/services/[service-name].ts` — follow the existing pattern (named exports, ESM imports, debug logging)

**New config key:** `src/services/config.ts` — add to the `Config` interface and `defaults` object

**Shared utilities:** `src/utils/[util-name].ts` — no business logic, no side effects at import time

**Tests:** Co-located with source as `*.test.ts` — use `vitest` with `vi.mock` for dependencies
