# Codebase Structure

## Directory Layout

```
commit-mint/
├── src/
│   ├── cli.ts                  # CLI entry point (cleye argument parser)
│   ├── env.d.ts                # Picomatch type declaration
│   ├── commands/
│   │   ├── commit.ts           # Main commit flow orchestrator
│   │   ├── commit.test.ts      # Commit flow unit tests
│   │   ├── commit-utils.ts     # Shared recovery menu factory + commitWithRecovery
│   │   ├── auto-group.ts       # Auto-group multi-commit flow
│   │   ├── auto-group.test.ts  # Auto-group flow tests
│   │   ├── config.ts           # `cmint config` interactive TUI
│   │   ├── retry.ts            # --retry mode command
│   │   └── staging.ts          # Interactive staging loop + pre-commit checks
│   ├── services/
│   │   ├── ai.ts               # Multi-provider AI commit message generation (3-tier diff compression)
│   │   ├── ai.test.ts          # AI service tests
│   │   ├── checks.ts           # User-defined pre-commit checks (config detection, glob matching, command execution)
│   │   ├── checks.test.ts      # Checks service tests
│   │   ├── clipboard.ts        # Cross-platform clipboard (wl-copy/xclip/xsel/pbcopy)
│   │   ├── clipboard.test.ts   # Clipboard service tests
│   │   ├── config.ts           # INI config read/write at ~/.commit-mint
│   │   ├── git.ts              # Git operations (stage, diff, commit, HEAD, status)
│   │   ├── git.test.ts         # Git service tests
│   │   ├── grouping.ts         # AI-powered file grouping into logical commits
│   │   ├── grouping.test.ts    # Grouping service tests
│   │   ├── hook-progress.ts    # Real-time hook progress parser and handler
│   │   ├── hook-progress.test.ts # Hook progress tests
│   │   ├── hooks.ts            # Hook error parser (lint-staged, biome, tsc, vitest/jest, eslint) + tool check summary
│   │   ├── hooks.test.ts       # Hook error parser tests
│   │   ├── provider.ts         # Multi-provider abstraction (Groq, Cerebras, Mistral)
│   │   └── provider.test.ts    # Provider tests
│   ├── ui/
│   │   ├── grouping.ts         # Grouping confirmation UI + grouped files display + progress
│   │   ├── menu.ts             # Interactive recovery TUI (6 options) + staging menu + check failure menu
│   │   ├── menu.test.ts        # Menu UI tests
│   │   └── review-message.ts   # Message review step (use-as-is/edit/cancel)
│   └── utils/
│       ├── cache.ts            # Commit message persistence at ~/.cache/commit-mint/
│       ├── debug.ts            # Timestamped debug logging to stderr
│       └── debug.test.ts       # Debug utility tests
├── .cmintrc.ts                 # Project's own cmint config file (biome + tsc + vitest)
├── .github/
│   └── workflows/
│       ├── ci.yml              # CI workflow
│       └── release.yml         # Release workflow
├── dist/                       # Build output (gitignored)
├── coverage/                   # Test coverage reports (gitignored)
├── notes/                      # Project notes
├── scripts/
│   └── release.sh             # Version bump and release script
├── .sisyphus/                  # Sisyphus planning system (drafts, evidence, plans)
├── biome.json                  # Biome linter/formatter config (tab indent, 100 width, maxLines: 400)
├── tsconfig.json               # TypeScript config (ES2022, ESNext modules, bundler resolution)
├── vitest.config.ts            # Vitest test runner config with v8 coverage
├── package.json                # Package manifest (ESM, bin: dist/cli.mjs)
├── AGENTS.md                   # OpenCode agent instructions
├── ARCHITECTURE.md             # Architecture documentation
├── STRUCTURE.md                # This file
├── vision.md                   # Project vision notes
└── README.md                   # Project documentation
```

## Directory Purposes

**`src/commands/`:**
- Purpose: Top-level command orchestrators for the CLI
- Contains: Async functions exported as command handlers
- Key files: `commit.ts` (main lifecycle, dispatches to retry/auto-group/staging), `auto-group.ts` (multi-commit auto-group flow with excluded-file pre-commit + checks + per-group recovery), `config.ts` (interactive TUI for reading/writing INI config), `commit-utils.ts` (shared `makeRecoveryCallbacks` + `commitWithRecovery`), `retry.ts` (--retry mode: load cached message, replay commit), `staging.ts` (interactive staging loop + `runPreCommitChecks`)

**`src/services/`:**
- Purpose: Encapsulated system integrations and business logic
- Contains: Git operations, AI generation (multi-provider), hook parsing, config I/O, clipboard, file grouping, user-defined checks, provider abstraction, hook progress display
- Key files: `git.ts` (all git subprocess calls, ChangedFile/DiffResult types, onProgress hook stderr collection), `ai.ts` (multi-provider via `createProvider`, 3-tier diff compression, think tag stripping, reasoning fallback, conventional commit validation with retry), `hooks.ts` (5 error parsers + tool check summary + extractToolName with sh -c unwrapping + uv support + package manager script mapping), `hook-progress.ts` (stderr parser for [STARTED]/[COMPLETED]/[FAILED] markers + progress handler factory), `checks.ts` (14 config file naming patterns, JSON/JS/TS loading via jiti, picomatch glob matching, shell command execution with timeout, function commands), `config.ts` (INI config at ~/.commit-mint, provider-aware API key resolution via `getProviderApiKey`, per-provider model keys via `getModelForProvider`), `clipboard.ts` (shell-out clipboard, returns boolean), `grouping.ts` (AI file grouping + exclude filtering + lockfile companion promotion + grouping validation + orphan file handling), `provider.ts` (multi-provider abstraction: ProviderName union, PROVIDER_CONFIGS, createProvider factory — Groq SDK for groq, generic fetch client for others)

**`src/ui/`:**
- Purpose: Interactive terminal user interface
- Contains: Recovery TUI (6 options), staging menu, check failure menu (4 options), message review step, grouping confirmation UI
- Key files: `menu.ts` (6-option recovery menu with clipboard state tracking + view raw output + staging menu with file selection/auto-group/checks/stage-all + check failure menu with copy/view/skip/cancel), `review-message.ts` (3-option message review: use-as-is/edit/cancel), `grouping.ts` (grouping confirmation with file list + grouped files table view with status indicators + commit group progress display + grouping summary)

**`src/utils/`:**
- Purpose: Generic utilities with no business logic or side effects
- Contains: Cache persistence, debug logging
- Key files: `cache.ts` (JSON file cache, 12-char SHA-256 prefix), `debug.ts` (module-level debug gate)

**`dist/`:**
- Purpose: Build output directory
- Contains: Compiled ESM bundle (`cli.mjs`), type declarations (`cli.d.ts`)
- Note: Gitignored; produced by `tsdown`

**`.github/workflows/`:**
- Purpose: CI/CD pipelines
- Contains: `ci.yml` (test + lint + typecheck on push/PR), `release.yml` (publish to npm on tags)
- Note: Not part of application code

**`scripts/`:**
- Purpose: Release automation
- Contains: `release.sh` — version bump (patch/minor/major), git tag, push
- Note: Only one script; not part of application code

**`.sisyphus/`:**
- Purpose: Sisyphus planning system artifacts
- Contains: Drafts, evidence, notepads, plans, run-continuation state
- Note: Not part of application code

## Key File Locations

**Entry Points:** `src/cli.ts`: Shebang script that parses argv via `cleye`, sets debug mode, dispatches to `commitCommand` or `configCommand`

**Configuration:** `src/services/config.ts`: Reads/writes INI at `~/.commit-mint`, merged with defaults (provider, model, model_groq, model_cerebras, model_mistral, locale, max-length, type, timeout, proxy). `getProviderApiKey(provider)` checks `$GROQ_API_KEY` / `$CEREBRAS_API_KEY` / `$MISTRAL_API_KEY` env vars first, then config file. `getModelForProvider(config, provider, defaultModel)` resolves per-provider model override `model_<provider>`, falls back to global `model`, then provider default.

**Core Logic:** `src/commands/commit.ts` (201 lines): Main orchestrator — dispatches to retry mode, auto-group, or normal flow with staging menu, excluded files, pre-commit checks, AI message generation, review, and recovery. `src/commands/auto-group.ts` (285 lines): Orchestrates multi-commit auto-group flow — excluded-file pre-commit, checks, AI grouping with provider, confirmation, sequential per-group commits with recovery. `src/commands/staging.ts` (118 lines): Interactive staging loop with auto-group, checks run, staged-only, stage-all, and select-files options. `src/commands/commit-utils.ts` (64 lines): Shared `makeRecoveryCallbacks` and `commitWithRecovery` that handles attempt → HEAD check → tool check summary / recovery menu. `src/commands/retry.ts` (27 lines): Load cached message and re-attempt commit via `commitWithRecovery`. `src/services/ai.ts` (319 lines): 3-tier diff compression, multi-provider client creation via `createProvider`, Groq SDK for groq, generic fetch client for others, think tag stripping, reasoning fallback, conventional commit validation + retry with strict prompt. `src/services/provider.ts` (134 lines): Multi-provider abstraction — Groq, Cerebras, Mistral definitions, `createProvider` factory, generic OpenAI-compatible fetch client, provider env key mapping. `src/services/checks.ts` (275 lines): User-defined pre-commit checks — 14 config naming patterns, JSON/JS/TS/MJS/CJS loading via jiti, picomatch glob matching, shell command execution with fail-fast. `src/services/hooks.ts` (313 lines): 5 error parsers (lint-staged, biome, tsc, vitest/jest, eslint), tool check summary, `extractToolName` with sh -c unwrapping, package manager script mapping, uv support. `src/services/grouping.ts` (260 lines): AI file grouping with exclude filtering, lockfile companion promotion, grouping validation, orphan file handling. `src/services/git.ts` (190 lines): Git operations with exclude patterns, `getStagedDiff` returning union type, `attemptCommit` with real-time hook progress stderr collection, `CommitResult` type.

**Tests:** Co-located `*.test.ts` siblings: `src/commands/commit.test.ts`, `src/commands/auto-group.test.ts`, `src/services/ai.test.ts`, `src/services/checks.test.ts`, `src/services/clipboard.test.ts`, `src/services/git.test.ts`, `src/services/hooks.test.ts`, `src/services/hook-progress.test.ts`, `src/services/grouping.test.ts`, `src/services/provider.test.ts`, `src/ui/menu.test.ts`, `src/utils/debug.test.ts`

**Lint config:** `biome.json`: Tab indentation, 100 character line width, max 400 lines per file (800 for tests). `.cmintrc.ts`: Project's own cmint config — runs biome check, tsc, and vitest on staged files.

**TypeScript config:** `tsconfig.json`: ES2022 target, ESNext modules, bundler resolution, strict mode, output to `dist/`

**Test runner:** `vitest.config.ts`: Vitest with v8 coverage provider

## Naming Conventions

**Files:** `camelCase.ts` — `commit.ts`, `auto-group.ts`, `config.ts`, `hooks.ts`, `clipboard.ts`, `hook-progress.ts`, `grouping.ts`, `checks.ts`, `provider.ts`, `cache.ts`, `debug.ts`. Test files use `.test.ts` suffix: `commit.test.ts`, `auto-group.test.ts`, `ai.test.ts`, `git.test.ts`, `checks.test.ts`, `hooks.test.ts`, `hook-progress.test.ts`, `grouping.test.ts`, `provider.test.ts`, `clipboard.test.ts`, `menu.test.ts`, `debug.test.ts`

**Directories:** Single-word lowercase: `commands/`, `services/`, `ui/`, `utils/`

**Exports:** Named function exports — `export async function commitCommand(...)`, `export function parseHookErrors(...)`, `export async function runAutoGroupFlow(...)`; default exports are never used

**Imports:** ESM with `.js` extension — `import { x } from "../services/ai.js"` (NOT `../services/ai`)

## Where to Add New Code

**New CLI flag:** `src/cli.ts` — add to the `flags` object in `cli()`, then pass through to `commitCommand` or route to a new command handler

**New commit flow step:** `src/commands/commit.ts` — extend the main lifecycle in `commitCommand`

**New auto-group flow step:** `src/commands/auto-group.ts` — extend the sequential multi-commit loop or the check/grouping prelude in `runAutoGroupFlow`

**New extracted command (e.g. new flag mode):** `src/commands/[name].ts` — add a new file, import and dispatch from `commit.ts` or `cli.ts`

**New hook error parser:** `src/services/hooks.ts` — add a `parse*Errors` function, wire into `parseHookErrors` switch, update tests to cover behavior with all existing parsers

**New recovery menu option:** `src/ui/menu.ts` — add to the options array in `select()` and add a `case` in the `switch`; update `RecoveryResult` type if adding new result states

**New staging menu option:** `src/ui/menu.ts` — add to the options array in `select()` in `showStagingMenu`, return the appropriate type from `StagingChoice | "autogroup" | "checks" | "staged" | null`

**New AI model or prompt strategy:** `src/services/ai.ts` — extend `generateCommitMessage`, `buildSystemPrompt`, or `compressDiff`

**New grouping strategy:** `src/services/grouping.ts` — extend `generateGroups` or `validateGroups`; update `filterExcludedFiles` for new exclude patterns or lockfile companions

**New provider (Cerebras, Mistral, etc.):** `src/services/provider.ts` — add to `PROVIDER_CONFIGS` and `PROVIDER_ENV_KEYS`, update `ProviderName` type, ensure `createProvider` handles the new provider (Groq uses SDK, others use generic fetch)

**New check config file name pattern:** `src/services/checks.ts` — add to the `CONFIG_FILES` array (checked in priority order)

**New check behavior (e.g. new command format):** `src/services/checks.ts` — extend `resolveCommands`, `runCommandsForGlob`, or `matchFiles`

**New service:** `src/services/[service-name].ts` — follow the existing pattern (named exports, ESM imports, debug logging)

**New config key:** `src/services/config.ts` — add to the `Config` interface and `defaults` object; update `writeConfig` and `getModelForProvider` if provider-specific

**New UI screen:** `src/ui/[name].ts` — use `@clack/prompts` for interactive elements, `kolorist` for colors

**Shared utilities:** `src/utils/[util-name].ts` — no business logic, no side effects at import time

**Tests:** Co-located with source as `*.test.ts` — use `vitest` with `vi.mock` for dependencies
