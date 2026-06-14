# Codebase Structure

## Directory Layout

```
commit-mint/
├── src/
│   ├── cli.ts                  # CLI entry point (cleye argument parser, flag routing)
│   ├── env.d.ts                # Picomatch type declaration
│   ├── commands/
│   │   ├── agent.ts            # Headless agent command (non-interactive, JSON output)
│   │   ├── agent.test.ts       # Agent command tests
│   │   ├── auto-group.ts       # Auto-group multi-commit flow
│   │   ├── auto-group.test.ts  # Auto-group flow tests
│   │   ├── commit.ts           # Main commit flow orchestrator (with preflight setup)
│   │   ├── commit.test.ts      # Commit flow unit tests
│   │   ├── commit-utils.ts     # Shared recovery helpers + commitWithRecovery
│   │   ├── config.ts           # `cmint config` interactive TUI
│   │   ├── logs.ts             # `cmint logs` debug log viewer
│   │   ├── retry.ts            # --retry mode command
│   │   ├── setup.ts            # Preflight .cmintrc setup wizard + tool detection
│   │   ├── setup.test.ts       # Setup tests
│   │   └── staging.ts          # Interactive staging loop + pre-commit checks
│   ├── services/
│   │   ├── ai.ts               # Multi-provider AI commit message generation (4-tier diff compression)
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
│   │   ├── grouping-parser.ts  # Robust JSON array recovery for AI grouping responses
│   │   ├── hook-progress.ts    # Real-time hook progress parser and handler
│   │   ├── hook-progress.test.ts # Hook progress tests
│   │   ├── hooks.ts            # Hook error parser (5 tools) + parseCheckErrors + tool check summary
│   │   ├── hooks.test.ts       # Hook error parser tests
│   │   ├── provider.ts         # Multi-provider abstraction (Groq, Cerebras, Mistral)
│   │   └── provider.test.ts    # Provider tests
│   ├── ui/
│   │   ├── check-failure-menu.ts    # Check failure menu (5 options: copy/view/retry/skip/cancel)
│   │   ├── check-failure-menu.test.ts # Check failure menu tests
│   │   ├── grouping.ts         # Grouping confirmation UI + grouped files display + progress
│   │   ├── recovery-menu.ts    # Interactive recovery TUI (6 options)
│   │   ├── recovery-menu.test.ts # Recovery menu tests
│   │   ├── review-message.ts   # Message review step (use-as-is/edit/cancel)
│   │   └── staging-menu.ts     # Staging menu (file list, status labels, multi-select fallback)
│   └── utils/
│       ├── agent.ts            # Agent mode boolean gate + AgentResult types + EXIT_CODES
│       ├── agent.test.ts       # Agent utility tests
│       ├── cache.ts            # Commit message persistence at ~/.cache/commit-mint/
│       ├── debug.ts            # Timestamped debug logging to stderr + persistent log file with session headers
│       └── debug.test.ts       # Debug utility tests
├── .cmintrc.ts                 # Project's own cmint config file (biome + tsc + vitest)
├── .cmint-skip-setup           # Optional marker to suppress preflight setup prompt
├── .github/
│   └── workflows/
│       ├── ci.yml              # CI workflow
│       └── release.yml         # Release workflow
├── .omo/                       # OpenCode planning system (drafts, evidence, notepads, plans)
├── .opencode/                  # OpenCode configuration directory
├── dist/                       # Build output (gitignored)
├── coverage/                   # Test coverage reports (gitignored)
├── landing/                    # Landing page assets (empty or unused)
├── notes/                      # Project notes
├── packages/
│   └── cmint/                  # Standalone cmint package (cli.mjs symlink, package.json)
├── scripts/
│   └── release.sh              # Version bump and release script
├── skills/
│   └── cmint/                  # OpenCode skill manifest (SKILL.md)
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
- Key files: `commit.ts` (main lifecycle with preflight setup dispatch, delegates to retry/auto-group/staging), `auto-group.ts` (multi-commit auto-group flow with excluded-file pre-commit + checks with retry menu + AI grouping with low-quality detection + per-group recovery), `agent.ts` (headless agent command — validates flags, asserts repo, auto-stages, runs checks, generates groups and messages, emits JSON to stdout), `config.ts` (interactive TUI for reading/writing INI config), `setup.ts` (`.cmintrc` wizard — detects biome/eslint/typescript/vitest via marker files, generates config, preflight prompt with skip-marker), `logs.ts` (reads debug log from `~/.cache/commit-mint/debug.log`, shows last session or `-n` lines), `commit-utils.ts` (shared `makeRecoveryCallbacks` + `commitWithRecovery`), `retry.ts` (--retry mode: load cached message, replay commit), `staging.ts` (interactive staging loop + `runPreCommitChecks` with retry)

**`src/services/`:**
- Purpose: Encapsulated system integrations and business logic
- Contains: Git operations, AI generation (multi-provider), hook parsing, config I/O, clipboard, file grouping, user-defined checks, provider abstraction, hook progress display, grouping response parser
- Key files: `git.ts` (all git subprocess calls, ChangedFile/DiffResult types, onProgress hook stderr collection), `ai.ts` (multi-provider via `createProvider`, 4-tier diff compression, think tag stripping, reasoning fallback, conventional commit validation with retry), `hooks.ts` (5 error parsers + `parseCheckErrors` for cmint check output + `extractToolName` with sh -c unwrapping + uv support + package manager script mapping + tool check summary), `hook-progress.ts` (stderr parser for [STARTED]/[COMPLETED]/[FAILED] markers + progress handler factory), `checks.ts` (14 config file naming patterns, JSON/JS/TS loading via jiti, picomatch glob matching, shell command execution with timeout, function commands), `grouping.ts` (AI file grouping via `generateGroups` using `parseGroupingResponse` from group-parser + exclude filtering + lockfile companion promotion + `validateGroups` + orphan handling + `isLowQualityGrouping` with retry), `grouping-parser.ts` (robust JSON recovery: markdown fence stripping, think tag removal, array extraction, top-level object scan fallback), `config.ts` (INI config at ~/.commit-mint, provider-aware API key resolution via `getProviderApiKey`, per-provider model keys via `getModelForProvider`), `clipboard.ts` (shell-out clipboard, returns boolean), `provider.ts` (multi-provider abstraction: ProviderName union, PROVIDER_CONFIGS, createProvider factory — Groq SDK for groq, generic fetch client for others)

**`src/ui/`:**
- Purpose: Interactive terminal user interface
- Contains: Recovery TUI (6 options), staging menu (6 options with file list/status), check failure menu (5 options with tsc/eslint inline diagnostics), message review step, grouping confirmation UI
- Key files: `recovery-menu.ts` (6-option recovery menu with clipboard state tracking + view raw output + skip hooks + restage + edit message + cancel), `staging-menu.ts` (file list with staged/changed grouping, status labels, 6 options: auto-group / commit staged / stage all / run checks / select files / cancel), `check-failure-menu.ts` (5 options: copy/view/retry/skip/cancel, tsc diagnostic extraction with summary limit, eslint stylish format parsing, `formatCheckFailureSummary`), `review-message.ts` (3-option message review: use-as-is/edit/cancel), `grouping.ts` (grouping confirmation with file list + changed files table + grouping summary + group progress display)

**`src/utils/`:**
- Purpose: Generic utilities with no business logic or side effects
- Contains: Agent mode state, cache persistence, debug logging (stderr + file)
- Key files: `agent.ts` (module-level boolean gate, `AgentResult`/`AgentCommit` types, `EXIT_CODES` constants, `writeAgentResult` JSON output), `cache.ts` (JSON file cache, 12-char SHA-256 prefix), `debug.ts` (module-level debug gate + persistent log file with session headers, `writeSessionHeader`, `getLogFilePath`)

**`dist/`:**
- Purpose: Build output directory
- Contains: Compiled ESM bundle (`cli.mjs`), type declarations (`cli.d.ts`)
- Note: Gitignored; produced by `tsdown`

**`.github/workflows/`:**
- Purpose: CI/CD pipelines
- Contains: `ci.yml` (test + lint + typecheck on push/PR), `release.yml` (publish to npm on tags)
- Note: Not part of application code

**`.omo/`:**
- Purpose: OpenCode planning system artifacts
- Contains: Drafts, evidence, notepads, plans, run-continuation state, boulder.json
- Note: Generated by `.omo` agent framework; not part of application code

**`scripts/`:**
- Purpose: Release automation
- Contains: `release.sh` — version bump (patch/minor/major), git tag, push
- Note: Only one script; not part of application code

**`skills/cmint/`:**
- Purpose: OpenCode skill manifest for AI agent integration
- Contains: `SKILL.md` — describes how to use cmint from coding agents
- Note: Installed via `npx skills add kyubiware/commit-mint`

## Key File Locations

**Entry Points:** `src/cli.ts`: Shebang script that parses argv via `cleye`, sets debug mode, writes session header, dispatches to `agentCommand` (when `--agent`) or `commitCommand`; has `config` and `logs` subcommands

**Configuration:** `src/services/config.ts`: Reads/writes INI at `~/.commit-mint`, merged with defaults (provider, model, model_groq, model_cerebras, model_mistral, locale, max-length, type, timeout, proxy). `getProviderApiKey(provider)` checks `$GROQ_API_KEY` / `$CEREBRAS_API_KEY` / `$MISTRAL_API_KEY` env vars first, then config file. `getModelForProvider(config, provider, defaultModel)` resolves per-provider model override `model_<provider>`, falls back to global `model`, then provider default.

**Core Logic:** `src/commands/commit.ts` (204 lines): Main orchestrator — preflight setup prompt, dispatches to retry mode, auto-group, or normal flow with staging menu, excluded files, pre-commit checks, AI message generation, review, and recovery. `src/commands/auto-group.ts` (319 lines): Orchestrates multi-commit auto-group flow — excluded-file pre-commit, checks with retry menu, AI grouping with low-quality detection, confirmation, sequential per-group commits with recovery. `src/commands/agent.ts` (310 lines): Headless agent mode — validates flags, asserts repo, auto-stages, runs checks, generates groups and messages, emits JSON. `src/commands/staging.ts` (146 lines): Interactive staging loop with auto-group, checks run, stage-all, select-files options + `runPreCommitChecks` with retry loop. `src/commands/commit-utils.ts` (64 lines): Shared `makeRecoveryCallbacks` and `commitWithRecovery` that handles attempt → HEAD check → tool check summary / recovery menu. `src/commands/retry.ts` (27 lines): Load cached message and re-attempt commit via `commitWithRecovery`. `src/commands/setup.ts` (239 lines): `.cmintrc` setup wizard + preflight prompt with skip-marker. `src/commands/logs.ts` (50 lines): Debug log viewer reading `~/.cache/commit-mint/debug.log`. `src/services/ai.ts` (319 lines): 4-tier diff compression, multi-provider client creation via `createProvider`, Groq SDK for groq, generic fetch client for others, think tag stripping, reasoning fallback, conventional commit validation + retry with strict prompt. `src/services/provider.ts` (134 lines): Multi-provider abstraction — Groq, Cerebras, Mistral definitions, `createProvider` factory, generic OpenAI-compatible fetch client, provider env key mapping. `src/services/checks.ts` (305 lines): User-defined pre-commit checks — 14 config naming patterns, JSON/JS/TS/MJS/CJS loading via jiti, picomatch glob matching, shell command execution with fail-fast, function commands. `src/services/hooks.ts` (370 lines): 5 error parsers (lint-staged, biome, tsc, vitest/jest, eslint) + `parseCheckErrors` for cmint check output + tool check summary + `extractToolName` with sh -c unwrapping, package manager script mapping, uv support. `src/services/grouping.ts` (282 lines): AI file grouping — `generateGroups` using `parseGroupingResponse` from group-parser, `isLowQualityGrouping` with retry, exclude filtering, lockfile companion promotion, `validateGroups`, orphan handling. `src/services/grouping-parser.ts` (133 lines): Robust JSON recovery from AI responses — think tag stripping, markdown fence removal, array extraction, top-level object scan fallback, group coercion. `src/services/git.ts` (190 lines): Git operations with exclude patterns, `getStagedDiff` returning union type, `attemptCommit` with real-time progress handler, `attemptCommitNoVerify`. `src/services/config.ts` (135 lines): INI read/write, default merge, API key resolution. `src/services/hook-progress.ts` (45 lines): Progress handler factory, marker parser. `src/services/clipboard.ts` (110 lines): Shell-out clipboard with fallback chain. `src/ui/recovery-menu.ts` (138 lines): 6-option recovery menu with clipboard state tracking. `src/ui/staging-menu.ts` (132 lines): Staging menu with status labels, file list, multi-select fallback. `src/ui/check-failure-menu.ts` (247 lines): Check failure menu with tsc/eslint inline diagnostics, 5 options. `src/ui/grouping.ts` (110 lines): Grouping confirmation, table view, progress display. `src/ui/review-message.ts` (41 lines): 3-option message review. `src/utils/debug.ts` (50 lines): Module-level gate + persistent log file with session headers. `src/utils/cache.ts` (47 lines): JSON cache with SHA-256 key. `src/utils/agent.ts` (36 lines): Agent mode gate, types, exit codes.

**Tests:** Co-located `*.test.ts` siblings: `src/commands/agent.test.ts`, `src/commands/auto-group.test.ts`, `src/commands/commit.test.ts`, `src/commands/setup.test.ts`, `src/services/ai.test.ts`, `src/services/checks.test.ts`, `src/services/clipboard.test.ts`, `src/services/git.test.ts`, `src/services/grouping.test.ts`, `src/services/hooks.test.ts`, `src/services/hook-progress.test.ts`, `src/services/provider.test.ts`, `src/ui/check-failure-menu.test.ts`, `src/ui/recovery-menu.test.ts`, `src/utils/agent.test.ts`, `src/utils/debug.test.ts`

**Lint config:** `biome.json`: Tab indentation, 100 character line width, max 400 lines per file (800 for tests). `.cmintrc.ts`: Project's own cmint config — runs biome check, tsc, and vitest on staged files.

**TypeScript config:** `tsconfig.json`: ES2022 target, ESNext modules, bundler resolution, strict mode, output to `dist/`

**Test runner:** `vitest.config.ts`: Vitest with v8 coverage provider

## Naming Conventions

**Files:** `camelCase.ts` — `commit.ts`, `auto-group.ts`, `agent.ts`, `config.ts`, `setup.ts`, `logs.ts`, `hooks.ts`, `clipboard.ts`, `hook-progress.ts`, `grouping.ts`, `grouping-parser.ts`, `checks.ts`, `provider.ts`, `recovery-menu.ts`, `staging-menu.ts`, `check-failure-menu.ts`, `cache.ts`, `debug.ts`, `agent.ts`. Test files use `.test.ts` suffix: `commit.test.ts`, `auto-group.test.ts`, `agent.test.ts`, `setup.test.ts`, `ai.test.ts`, `git.test.ts`, `checks.test.ts`, `hooks.test.ts`, `hook-progress.test.ts`, `grouping.test.ts`, `provider.test.ts`, `clipboard.test.ts`, `recovery-menu.test.ts`, `check-failure-menu.test.ts`, `agent.test.ts`, `debug.test.ts`

**Directories:** Single-word lowercase: `commands/`, `services/`, `ui/`, `utils/`

**Exports:** Named function exports — `export async function commitCommand(...)`, `export function parseHookErrors(...)`, `export async function runAutoGroupFlow(...)`; default exports are never used

**Imports:** ESM with `.js` extension — `import { x } from "../services/ai.js"` (NOT `../services/ai`)

## Where to Add New Code

**New CLI flag:** `src/cli.ts` — add to `flags` object in `cli()`, then dispatch to `agentCommand` or pass through to `commitCommand`

**New CLI subcommand (e.g. new top-level mode):** `src/cli.ts` — add to `commands` array in `cli()`, provide handler function

**New commit flow step:** `src/commands/commit.ts` — extend the main lifecycle in `commitCommand`

**New auto-group flow step:** `src/commands/auto-group.ts` — extend the sequential multi-commit loop or the check/grouping prelude in `runAutoGroupFlow`

**New agent flow behavior:** `src/commands/agent.ts` — extend `agentCommand` (validates flags, auto-stages, runs checks, groups, commits, emits JSON)

**New extracted command (e.g. new flag mode):** `src/commands/[name].ts` — add a new file, import and dispatch from `commit.ts` or `cli.ts`

**New hook error parser:** `src/services/hooks.ts` — add a `parse*Errors` function, wire into `parseHookErrors` switch, update tests to cover behavior with all existing parsers

**New recovery menu option:** `src/ui/recovery-menu.ts` — add to the options array in `select()` and add a `case` in the `switch`; update `RecoveryResult` type if adding new result states

**New staging menu option:** `src/ui/staging-menu.ts` — add to the options array in `select()` in `showStagingMenu`, return the appropriate type from the union

**New check failure menu option:** `src/ui/check-failure-menu.ts` — add to the options array in `select()` and add a `case` in the `switch`; update return type if adding new result states

**New AI model or prompt strategy:** `src/services/ai.ts` — extend `generateCommitMessage`, `buildSystemPrompt`, or `compressDiff`

**New grouping strategy:** `src/services/grouping.ts` — extend `generateGroups` or `validateGroups`; update `filterExcludedFiles` for new exclude patterns or lockfile companions

**New grouping parser strategy:** `src/services/grouping-parser.ts` — extend `parseGroupingResponse` with additional recovery paths

**New provider (Cerebras, Mistral, etc.):** `src/services/provider.ts` — add to `PROVIDER_CONFIGS` and `PROVIDER_ENV_KEYS`, update `ProviderName` type, ensure `createProvider` handles the new provider (Groq uses SDK, others use generic fetch)

**New check config file name pattern:** `src/services/checks.ts` — add to the `CONFIG_FILES` array (checked in priority order)

**New check behavior (e.g. new command format):** `src/services/checks.ts` — extend `resolveCommands`, `runCommandsForGlob`, or `matchFiles`

**New service:** `src/services/[service-name].ts` — follow the existing pattern (named exports, ESM imports, debug logging)

**New config key:** `src/services/config.ts` — add to the `Config` interface and `defaults` object; update `writeConfig` and `getModelForProvider` if provider-specific

**New UI screen:** `src/ui/[name].ts` — use `@clack/prompts` for interactive elements, `kolorist` for colors; follow split-pattern (one file per menu/screen)

**Shared utilities:** `src/utils/[util-name].ts` — no business logic, no side effects at import time

**Tests:** Co-located with source as `*.test.ts` — use `vitest` with `vi.mock` for dependencies
