# Architecture

## Pattern Overview

**Overall:** CLI command-pipeline with interactive recovery loop

**Key Characteristics:**
- Single-entry orchestrator (`commitCommand`) that stages, generates, attempts, and recovers from hook failures
- Plugin-style error parsers for 5 hook tools (lint-staged, biome, tsc, vitest/jest, eslint) with raw fallback
- 3-tier diff compression for AI prompt efficiency
- Provider abstraction supporting Groq, Cerebras, and Mistral via OpenAI-compatible API
- Interactive staging menu for multi-file workflows (select files, auto-group, run checks from cmint config)
- User-defined pre-commit checks via cmint config files (14 naming patterns, glob matching via picomatch, function commands)
- Recursive recovery menu with 6 options (copy, view full output, skip hooks, restage, edit message, cancel)
- Check failure menu with 4 options (copy, view full output, skip checks, cancel)
- AI-powered auto-grouping of changed files into logical commits
- Real-time hook progress display during pre-commit hook execution
- Provider-aware model resolution: `model_groq`, `model_cerebras`, `model_mistral` override the global `model` key per provider

## Layers

**CLI Layer:**
- Purpose: Parse argv and dispatch to commands
- Location: `src/cli.ts`
- Contains: Flag definitions (retry, auto, message, hint, debug, noCheck), command routing to `commitCommand` or `configCommand`
- Depends on: `cleye` library
- Used by: Package binary entry (`dist/cli.mjs`)

**Commands Layer:**
- Purpose: Orchestrate top-level workflows (commit, config, auto-group, retry, staging)
- Location: `src/commands/`
- Contains: `commit.ts` (main lifecycle), `commit-utils.ts` (shared recovery helpers), `config.ts` (interactive config TUI), `auto-group.ts` (multi-commit flow), `retry.ts` (--retry mode), `staging.ts` (interactive staging loop + pre-commit checks)
- Depends on: Services, UI, Utils
- Used by: CLI layer

**Services Layer:**
- Purpose: Encapsulate external system interactions and business logic
- Location: `src/services/`
- Contains: `git.ts` (git operations), `ai.ts` (multi-provider AI generation), `grouping.ts` (AI file grouping), `provider.ts` (multi-provider abstraction: Groq, Cerebras, Mistral), `hooks.ts` (hook error parsing + tool check summary), `hook-progress.ts` (real-time hook progress display), `checks.ts` (user-defined pre-commit checks via cmint config files — config detection, glob matching via picomatch, command execution), `config.ts` (INI config at `~/.commit-mint`), `clipboard.ts` (cross-platform clipboard)
- Depends on: `execa`, `groq-sdk`, `ini`, `picomatch`, `jiti`, Node.js built-ins
- Used by: Commands layer

**UI Layer:**
- Purpose: Interactive terminal UI for recovery decisions, staging, and grouping confirmation
- Location: `src/ui/`
- Contains: `menu.ts` (recovery TUI with 6 options + check failure menu + staging menu), `review-message.ts` (message review: use-as-is/edit/cancel), `grouping.ts` (grouping confirmation UI + grouped files display + progress display)
- Depends on: `@clack/prompts`, `kolorist`, Services (clipboard, hooks, git)
- Used by: Commands layer (`commit.ts`, `auto-group.ts`)

**Utils Layer:**
- Purpose: Shared utilities with no business logic
- Location: `src/utils/`
- Contains: `cache.ts` (commit message persistence), `debug.ts` (timestamped debug logging)
- Depends on: Node.js built-ins, `kolorist`
- Used by: All other layers

## Data Flow

**Commit Flow (normal mode):**

1. Parse CLI flags — `src/cli.ts`
2. Assert git repo — `src/services/git.ts:assertGitRepo`
3. Check git status — `src/services/git.ts:getStatusShort`
4. Get changed files list — `src/services/git.ts:getChangedFiles`
5. Stage changes:
   - `--auto` flag: delegate to `runAutoGroupFlow` in `src/commands/auto-group.ts`
   - Single file: auto-stage it — `stageFiles`
   - Multiple files: show interactive staging menu (select files / auto-group / run checks / stage all) — `src/ui/menu.ts:showStagingMenu`
     - "Auto-group into commits" delegates to `runAutoGroupFlow` in `src/commands/auto-group.ts`
     - "Run checks" runs `runAllChecks` then refreshes changed files list
     - "Stage all" stages all files
     - "Select files" shows multi-select picker
6. Run user-defined pre-commit checks (if cmint config exists and `--noCheck` not set) — `src/commands/staging.ts:runPreCommitChecks` → `src/services/checks.ts:runAllChecks`. On failure: show check failure menu (copy/view/skip/cancel) — `src/ui/menu.ts:showCheckFailureMenu`
7. Get staged diff with exclude patterns — `src/services/git.ts:getStagedDiff`
   - Returns `ExcludedFilesResult` when all staged files match exclude patterns (lockfiles, dist, etc.)
   - Excluded-only case: builds hardcoded message ("chore: update lockfile" / "chore: update generated files"), caches it, commits directly
8. Ensure provider API key exists (prompt if missing) — `src/services/config.ts:getProviderApiKey` / `setConfigValue`
9. Generate commit message via AI with 3-tier diff compression — `src/services/ai.ts:generateCommitMessage`
10. Present message review (use-as-is / edit / cancel) — `src/ui/review-message.ts:reviewCommitMessage`
11. Cache commit message — `src/utils/cache.ts:saveCachedCommit`
12. Attempt `git commit -m` with real-time hook progress display — `src/commands/commit-utils.ts:commitWithRecovery` → `src/services/git.ts:attemptCommit`
13. On success: print tool check summary from parsed hook stderr — `src/services/hooks.ts:parseToolChecks`
14. On failure: parse hook errors — `src/services/hooks.ts:parseHookErrors`
15. Show recovery menu — `src/ui/menu.ts:showRecoveryMenu`

**Recovery Menu Flow:**

1. User chooses action from 6 options — `src/ui/menu.ts:showRecoveryMenu`
2. **Copy errors:** format error report → clipboard (returns boolean) → loop back to menu
3. **View full output:** display raw stderr → loop back to menu
4. **Skip hooks:** `git commit --no-verify` — `src/services/git.ts:attemptCommitNoVerify`
5. **Re-stage & retry:** `git add -A` → retry commit; on re-failure, re-parse errors and loop back
6. **Edit message:** prompt new message → retry commit → return "committed" or "failed"
7. **Cancel:** exit with message cached for `--retry`, return "cancelled"
- Returns `RecoveryResult` type (`"committed" | "cancelled" | "failed"`)

**Retry Flow:**

1. Parse `--retry` / `-r` flag — `src/cli.ts`
2. Call `handleRetry` — `src/commands/retry.ts`
3. Load cached commit from `~/.cache/commit-mint/<12-char-sha256>.json` — `src/utils/cache.ts:loadCachedCommit`
4. Attempt commit via `commitWithRecovery`; on failure enter recovery menu — same as normal mode steps 12-15

**Auto-Group Flow:**

1. Filter excluded files (promotes lockfiles when companion manifest present) — `src/services/grouping.ts:filterExcludedFiles`
2. Commit excluded files upfront with hardcoded message
3. Run user-defined pre-commit checks on all included files (unless `--noCheck`) — `src/services/checks.ts:runAllChecks`
4. Read config and determine provider
5. Ensure API key for selected provider
6. Call grouping service — `src/services/grouping.ts:generateGroups` (AI groups files by logical concern, uses provider abstraction)
7. Validate groups, attach orphaned files as "Other changes" — `src/services/grouping.ts:validateGroups`
8. Show grouping confirmation — `src/ui/grouping.ts:showGroupingConfirmation` (skipped in auto mode)
9. Sequential multi-commit loop: for each group, `resetStaging` → `stageFiles` → `getStagedDiff` → `generateMessage` → `reviewCommitMessage` (skipped in auto mode) → `saveCachedCommit` → `attemptCommit` with progress handler; on hook failure, show `showRecoveryMenu` and stop sequence
10. Each group commit shows progress — `src/ui/grouping.ts:showGroupProgress`

**Check Failure Menu Flow:**

1. Run user-defined pre-commit checks — `src/services/checks.ts:runAllChecks`
2. On failure: parse check errors into structured `HookError[]` — `src/services/hooks.ts:parseHookErrors`
3. Show check failure menu — `src/ui/menu.ts:showCheckFailureMenu`
4. **Copy error report:** format error report → clipboard → loop back
5. **View full output:** display raw stderr → loop back
6. **Skip checks:** proceed to commit without passing checks
7. **Cancel:** exit with message cached (in normal mode) or stop auto-group flow

## Key Abstractions

**HookError:**
- Purpose: Structured representation of a single hook failure
- Location: `src/services/hooks.ts:3`
- Pattern: Interface with `{ tool, message, raw }` shape

**ToolCheck:**
- Purpose: Structured representation of a tool's success/failure status in post-commit summary
- Location: `src/services/hooks.ts:173`
- Pattern: Interface with `{ tool, ok }` shape

**HookStep:**
- Purpose: A single hook execution step with status for progress display
- Location: `src/services/hook-progress.ts:4`
- Pattern: Interface with `{ status, command, tool }` shape

**ChangedFile:**
- Purpose: Representation of a changed file with status and staged state
- Location: `src/services/git.ts:35`
- Pattern: Interface with `{ path, status, staged }` shape

**DiffResult / StagedDiffResult / ExcludedFilesResult:**
- Purpose: Union type for diff query results — normal diff vs all-excluded case vs no changes
- Location: `src/services/git.ts:24-33`
- Pattern: `StagedDiffResult { files, diff } | ExcludedFilesResult { excludedFiles } | null`

**CommitResult:**
- Purpose: Result of a `git commit` attempt including hook stderr
- Location: `src/services/git.ts:141`
- Pattern: Interface with `{ ok, error?, stderr? }`

**CachedCommit:**
- Purpose: Persisted commit message with metadata for `--retry`
- Location: `src/utils/cache.ts:17`
- Pattern: Interface with `{ message, timestamp, repoPath }` shape

**Config:**
- Purpose: User configuration for AI provider, per-provider model keys, locale, max-length, type, timeout, proxy
- Location: `src/services/config.ts:15`
- Pattern: Interface with optional string-keyed properties; provider-specific model keys (`model_groq`, `model_cerebras`, `model_mistral`)

**ProviderConfig / ProviderName:**
- Purpose: Provider definitions for Groq, Cerebras, Mistral — base URL, default model, env key
- Location: `src/services/provider.ts:4-11`
- Pattern: `ProviderName` union type; `PROVIDER_CONFIGS` record mapping providers to `{ baseURL, defaultModel }`

**KnownError:**
- Purpose: Distinguishable error class for git-specific failures
- Location: `src/services/git.ts:6`
- Pattern: Class extending `Error`

**RecoveryResult:**
- Purpose: Return type from recovery menu and auto-group flow
- Location: `src/ui/menu.ts:8`
- Pattern: Union type `"committed" | "cancelled" | "failed"`

**StagingChoice:**
- Purpose: Result of staging menu selection
- Location: `src/ui/menu.ts:10`
- Pattern: Interface with `{ files: string[], all: boolean }`

**CommitGroup:**
- Purpose: A logical group of files for auto-group flow
- Location: `src/services/grouping.ts:7`
- Pattern: Interface with `{ name, description, files }` shape

**GroupingResult:**
- Purpose: Result of AI file grouping
- Location: `src/services/grouping.ts:13`
- Pattern: Interface with `{ groups: CommitGroup[], excluded: string[] }`

**CheckConfig:**
- Purpose: User-defined check configuration mapping globs to commands, string arrays, or functions
- Location: `src/services/checks.ts:28`
- Pattern: Index signature `[glob: string]: string | string[] | ((filenames: string[]) => string | string[])`

**CheckResult / CheckResults:**
- Purpose: Result of a single check command execution and aggregated results
- Location: `src/services/checks.ts:33-46`
- Pattern: `CheckResult { ok, tool, command, stdout, stderr, files }`; `CheckResults { ok, results: CheckResult[] }`

## Entry Points

**cmint CLI:**
- Location: `src/cli.ts`
- Triggers: User runs `cmint` or `cmint --help`
- Responsibilities: Parse argv, set debug flag, dispatch to `commitCommand` or `configCommand`

**commitCommand:**
- Location: `src/commands/commit.ts:34`
- Triggers: `cmint`, `cmint --auto`, `cmint -m "..."`, `cmint --retry`, `cmint -H "hint"`
- Responsibilities: Orchestrate entire commit lifecycle including retry mode, staging menu, excluded files handling, pre-commit checks

**configCommand:**
- Location: `src/commands/config.ts:216`
- Triggers: `cmint config`
- Responsibilities: Interactive TUI for reading/writing `~/.commit-mint` INI values — provider selection, API key, model, locale, max-length, type, timeout, proxy

**runAutoGroupFlow:**
- Location: `src/commands/auto-group.ts:47`
- Triggers: "Auto-group into commits" from staging menu, or `cmint --auto`
- Responsibilities: Filter excluded files, run pre-commit checks, call AI grouping with provider, show confirmation, sequential multi-commit with per-group recovery

**handleRetry:**
- Location: `src/commands/retry.ts:9`
- Triggers: `cmint --retry` or `cmint -r`
- Responsibilities: Load cached commit message, attempt commit via `commitWithRecovery`, exit with error on failure

**handleStaging:**
- Location: `src/commands/staging.ts:13`
- Triggers: Multiple changed files in normal mode
- Responsibilities: Interactive staging loop — auto-group, run checks, select files, stage all; returns selected files or delegates to auto-group flow

**showCheckFailureMenu:**
- Location: `src/ui/menu.ts:269`
- Triggers: User-defined pre-commit check failure
- Responsibilities: Show structured error summary, offer copy/view/skip/cancel, return `"skipped"` or `"cancelled"`

## Error Handling

**Strategy:** Fail soft with structured feedback and recovery paths

- Git operations use `execa` with `reject: false` for expected failures; `KnownError` for domain-specific errors
- Commit attempts use try/catch with `ExecaError` — collect stderr, return `CommitResult` with `ok: boolean`
- AI errors are mapped to user-friendly messages per provider (invalid key, rate limit, timeout, API error) — `src/services/ai.ts:mapGroqError` also handles non-Groq provider errors via status code regex
- Hook errors are parsed into structured `HookError[]` with 5 tool-specific parsers and a raw fallback for unrecognized output — `src/services/hooks.ts:parseHookErrors`
- User-defined pre-commit check failures show a separate `showCheckFailureMenu` (copy/view/skip/cancel) — none are dead ends
- Recovery menu provides 6 ways to respond to hook failures (none are dead ends)
- Staging errors are caught and reported with non-zero exit

## Cross-Cutting Concerns

**Logging:** `src/utils/debug.ts` — module-level boolean gate, timestamped stderr output via `console.error` with `kolorist` dim styling. Enabled by `--debug` / `-d` flag.

**Caching:** `src/utils/cache.ts` — SHA-256 hash (12-char prefix) of repo path → JSON file in `~/.cache/commit-mint/`. Stores commit message, timestamp, and repo path for `--retry`.

**Storage:** `src/services/config.ts` — INI-format config at `~/.commit-mint`. Defaults merged via spread. Keys: GROQ_API_KEY, CEREBRAS_API_KEY, MISTRAL_API_KEY, provider, model, model_groq, model_cerebras, model_mistral, locale, max-length, type, timeout, proxy.
