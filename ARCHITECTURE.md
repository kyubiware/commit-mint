# Architecture

## Pattern Overview

**Overall:** CLI command-pipeline with interactive recovery loop

**Key Characteristics:**
- Single-entry orchestrator (`commitCommand`) that stages, generates, attempts, and recovers from hook failures
- Separate headless `agentCommand` for AI coding agents (non-interactive, JSON output, 7 documented exit codes)
- Plugin-style error parsers for 5 hook tools (lint-staged, biome, tsc, vitest/jest, eslint) with raw fallback — plus a separate `parseCheckErrors` for cmint check output format (`[tool]` prefix blocks)
- 4-tier diff compression for AI prompt efficiency (full → strip context → cap hunks → file summary)
- Provider abstraction supporting Groq, Cerebras, and Mistral via OpenAI-compatible API
- Interactive staging menu for multi-file workflows (select files, auto-group, run checks from cmint config, stage all, commit staged)
- User-defined pre-commit checks via cmint config files (14 naming patterns, glob matching via picomatch, function commands)
- Recursive recovery menu with 6 options (copy, view full output, skip hooks, restage, edit message, cancel)
- Check failure menu with 5 options (copy, view full output, retry checks, skip checks, cancel)
- AI-powered auto-grouping of changed files into logical commits, with low-quality grouping detection and retry
- Robust JSON array recovery for AI grouping responses (single-object fallback, markdown fence stripping, think tag removal)
- Real-time hook progress display during pre-commit hook execution
- Provider-aware model resolution: `model_groq`, `model_cerebras`, `model_mistral` override the global `model` key per provider
- Preflight `.cmintrc` setup prompt at the start of `cmint` (auto-detects biome/eslint/typescript/vitest, writes config file)
- Debug session logging to `~/.cache/commit-mint/debug.log` with session headers, viewable via `cmint logs`
- Agent mode (`--agent`) for headless non-interactive auto-group with JSON output to stdout

## Layers

**CLI Layer:**
- Purpose: Parse argv and dispatch to commands
- Location: `src/cli.ts`
- Contains: Flag definitions (retry, auto, message, hint, debug, noCheck, agent), subcommand routing (`logs`, `config`), dispatches to `agentCommand` (when `--agent` flag) or `commitCommand`
- Depends on: `cleye` library
- Used by: Package binary entry (`dist/cli.mjs`)

**Commands Layer:**
- Purpose: Orchestrate top-level workflows
- Location: `src/commands/`
- Contains: `commit.ts` (main lifecycle with preflight setup prompt), `commit-utils.ts` (shared recovery helpers), `agent.ts` (headless agent command with JSON output), `config.ts` (interactive config TUI), `auto-group.ts` (multi-commit flow), `retry.ts` (--retry mode), `staging.ts` (interactive staging loop + pre-commit checks), `setup.ts` (preflight setup prompt + .cmintrc wizard), `logs.ts` (debug log viewer)
- Depends on: Services, UI, Utils
- Used by: CLI layer

**Services Layer:**
- Purpose: Encapsulate external system interactions and business logic
- Location: `src/services/`
- Contains: `git.ts` (git operations), `ai.ts` (multi-provider AI generation with 4-tier diff compression), `grouping.ts` (AI file grouping + low-quality detection + orphan validation), `grouping-parser.ts` (robust JSON array recovery for grouping responses), `provider.ts` (multi-provider abstraction: Groq, Cerebras, Mistral), `hooks.ts` (hook error parsing + `parseCheckErrors` for cmint check output + tool check summary), `hook-progress.ts` (real-time hook progress parser), `checks.ts` (user-defined pre-commit checks via cmint config files — config detection, glob matching via picomatch, command execution, function commands), `config.ts` (INI config at `~/.commit-mint`), `clipboard.ts` (cross-platform clipboard)
- Depends on: `execa`, `groq-sdk`, `ini`, `picomatch`, `jiti`, Node.js built-ins
- Used by: Commands layer

**UI Layer:**
- Purpose: Interactive terminal UI for recovery decisions, staging, check failures, and grouping confirmation
- Location: `src/ui/`
- Contains: `recovery-menu.ts` (recovery TUI with 6 options + clipboard state tracking), `staging-menu.ts` (staging menu with file list display, status labels, multi-select fallback), `check-failure-menu.ts` (check failure menu with 5 options + tsc/eslint inline diagnostics), `review-message.ts` (message review: use-as-is/edit/cancel), `grouping.ts` (grouping confirmation UI + grouped files display + progress display + grouping summary)
- Depends on: `@clack/prompts`, `kolorist`, Services (clipboard, hooks, git)
- Used by: Commands layer (`commit.ts`, `auto-group.ts`, `commit-utils.ts`, `staging.ts`)

**Utils Layer:**
- Purpose: Shared utilities with no business logic
- Location: `src/utils/`
- Contains: `cache.ts` (commit message persistence), `debug.ts` (timestamped debug logging to stderr + persistent log file with session headers), `agent.ts` (agent mode boolean gate + `AgentResult`/`AgentCommit` types + `EXIT_CODES` constants)
- Depends on: Node.js built-ins, `kolorist`
- Used by: All other layers

## Data Flow

**Commit Flow (normal mode):**

1. Parse CLI flags — `src/cli.ts`
2. Assert git repo — `src/services/git.ts:assertGitRepo`
3. Run preflight `.cmintrc` setup prompt (skips if config exists or skip-marker present) — `src/commands/setup.ts:runPreflightSetupPrompt`
4. Check git status — `src/services/git.ts:getStatusShort`
5. Get changed files list — `src/services/git.ts:getChangedFiles`
6. Stage changes:
   - `--auto` flag: delegate to `runAutoGroupFlow` in `src/commands/auto-group.ts`
   - Single file: auto-stage it — `stageFiles`
   - Multiple files: show interactive staging menu (auto-group into commits / commit staged only / stage all / run checks / select files / cancel) — `src/ui/staging-menu.ts:showStagingMenu`
     - "Auto-group into commits" delegates to `runAutoGroupFlow` in `src/commands/auto-group.ts`
     - "Run checks" runs `runAllChecks` then refreshes changed files list
     - "Stage all" stages all files
     - "Select files" shows multi-select picker
7. Refresh file list to reflect staged state — `getChangedFiles`
8. Run user-defined pre-commit checks (if cmint config exists and `--noCheck` not set) — `src/commands/staging.ts:runPreCommitChecks` → `src/services/checks.ts:runAllChecks`. On failure: parse check errors via `parseCheckErrors`, show check failure menu (copy/view/retry/skip/cancel) — `src/ui/check-failure-menu.ts:showCheckFailureMenu`
9. Get staged diff with exclude patterns — `src/services/git.ts:getStagedDiff`
   - Returns `ExcludedFilesResult` when all staged files match exclude patterns (lockfiles, dist, etc.)
   - Excluded-only case: builds hardcoded message ("chore: update lockfile" / "chore: update generated files"), caches it, commits directly via `commitWithRecovery`
10. Ensure provider API key exists (prompt if missing) — `src/services/config.ts:getProviderApiKey` / `setConfigValue`
11. Generate commit message via AI with 4-tier diff compression — `src/services/ai.ts:generateCommitMessage`
12. Present message review (use-as-is / edit / cancel) — `src/ui/review-message.ts:reviewCommitMessage`
13. Cache commit message — `src/utils/cache.ts:saveCachedCommit`
14. Attempt `git commit -m` with real-time hook progress display — `src/commands/commit-utils.ts:commitWithRecovery` → `src/services/git.ts:attemptCommit`
15. On success: print tool check summary from parsed hook stderr — `src/services/hooks.ts:parseToolChecks`
16. On failure: parse hook errors — `src/services/hooks.ts:parseHookErrors`
17. Show recovery menu — `src/ui/recovery-menu.ts:showRecoveryMenu`

**Recovery Menu Flow:**

1. User chooses action from 6 options — `src/ui/recovery-menu.ts:showRecoveryMenu`
2. **Copy errors:** format error report → clipboard (returns boolean, tracks copied state) → loop back to menu
3. **View full output:** display raw stderr → loop back to menu (re-shows note)
4. **Skip hooks:** `git commit --no-verify` — `src/services/git.ts:attemptCommitNoVerify`
5. **Re-stage & retry:** `git add -A` → retry commit; on re-failure, re-parse errors and loop back (re-shows note)
6. **Edit message:** prompt new message → retry commit → return "committed" or "failed"
7. **Cancel:** exit with message cached for `--retry`, return "cancelled"
- Returns `RecoveryResult` type (`"committed" | "cancelled" | "failed"`)

**Retry Flow:**

1. Parse `--retry` / `-r` flag — `src/cli.ts`
2. Call `handleRetry` — `src/commands/retry.ts`
3. Load cached commit from `~/.cache/commit-mint/<12-char-sha256>.json` — `src/utils/cache.ts:loadCachedCommit`
4. Attempt commit via `commitWithRecovery`; on failure enter recovery menu — same as normal mode steps 14-17

**Auto-Group Flow:**

1. Filter excluded files (promotes lockfiles when companion manifest present) — `src/services/grouping.ts:filterExcludedFiles`
2. Commit excluded files upfront with hardcoded message (continues even if excluded commit fails)
3. Run user-defined pre-commit checks on all included files (unless `--noCheck`) — `src/services/checks.ts:runAllChecks`
   - On failure: parse check errors via `parseCheckErrors`, show check failure menu with retry loop — `src/ui/check-failure-menu.ts:showCheckFailureMenu`
   - Retry causes: re-run checks, loop back until passed/skipped/cancelled
4. Read config and determine provider
5. Ensure API key for selected provider (prompt if missing)
6. Call grouping service — `src/services/grouping.ts:generateGroups` (AI groups files by logical concern, uses provider abstraction)
   - Uses `parseGroupingResponse` from `src/services/grouping-parser.ts` for robust JSON recovery
   - Detects low-quality grouping via `isLowQualityGrouping` and retries automatically
7. Validate groups, attach orphaned files as "Other changes" — `src/services/grouping.ts:validateGroups`
8. Show grouping confirmation — `src/ui/grouping.ts:showGroupingConfirmation` (skipped in auto mode)
9. Show grouped files table — `src/ui/grouping.ts:showGroupedFiles`
10. Sequential multi-commit loop: for each group, `resetStaging` → `stageFiles` → `getStagedDiff` → `generateMessage` → `reviewCommitMessage` (skipped in auto mode) → `saveCachedCommit` → `attemptCommit` with progress handler; on hook failure, show `showRecoveryMenu` and stop sequence
11. Each group commit shows progress — `src/ui/grouping.ts:showGroupProgress`

**Agent Mode Flow:**

1. Parse `--agent` flag — `src/cli.ts`
2. Validate flags (`--agent` + `--retry` returns error with exit code 1)
3. Call `agentCommand` — `src/commands/agent.ts:agentCommand`
4. Assert git repo, check status, auto-stage all changed files
5. Get diff; handle excluded-only case (hardcoded message) or `--message` (single commit with provided message)
6. Run user-defined pre-commit checks (unless `--noCheck`)
7. Auto-group flow: filter excluded, commit excluded upfront, read config, ensure API key, generate groups via AI, sequential per-group commits with generated message — no review, no interactive recovery
8. Emit structured JSON to stdout for each phase — `src/utils/agent.ts:writeAgentResult`
9. Set `process.exitCode` to one of 7 documented codes (0=success, 1=generic, 2=no_changes, 3=git, 4=ai, 5=check, 6=hook)

**Check Failure Menu Flow:**

1. Run user-defined pre-commit checks — `src/services/checks.ts:runAllChecks`
2. On failure: parse check errors into structured `HookError[]` — `src/services/hooks.ts:parseCheckErrors`
3. Show check failure menu — `src/ui/check-failure-menu.ts:showCheckFailureMenu` (with optional retry callback)
4. **Copy error report:** format error report → clipboard → loop back
5. **View full output:** display raw stderr → loop back
6. **Retry checks:** re-run checks → return "retried" (caller handles the loop)
7. **Skip checks:** proceed to commit without passing checks
8. **Cancel:** exit with message cached (in normal mode) or stop auto-group flow

## Key Abstractions

**HookError:**
- Purpose: Structured representation of a single hook failure (also used for check errors)
- Location: `src/services/hooks.ts:3`
- Pattern: Interface with `{ tool, message, raw }` shape

**ToolCheck:**
- Purpose: Structured representation of a tool's success/failure status in post-commit summary
- Location: `src/services/hooks.ts:231`
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
- Location: `src/ui/recovery-menu.ts:7`
- Pattern: Union type `"committed" | "cancelled" | "failed"`

**StagingChoice:**
- Purpose: Result of staging menu selection
- Location: `src/ui/staging-menu.ts:6`
- Pattern: Interface with `{ files: string[], all: boolean }`

**CommitGroup:**
- Purpose: A logical group of files for auto-group flow
- Location: `src/services/grouping.ts:7` (re-exported from `grouping-parser.ts`)
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

**AgentResult / AgentCommit / EXIT_CODES:**
- Purpose: JSON output types and exit code constants for agent mode
- Location: `src/utils/agent.ts:11-32`
- Pattern: `AgentResult { status, commits, errors? }`; `AgentCommit { message, hash, files, groupName? }`; `EXIT_CODES` constant map

**DetectedTools / ToolName:**
- Purpose: Tool detection result for preflight setup wizard
- Location: `src/commands/setup.ts:27-29`
- Pattern: Record of `ToolName` (`"biome" | "eslint" | "typescript" | "vitest"`) to boolean

## Entry Points

**cmint CLI:**
- Location: `src/cli.ts`
- Triggers: User runs `cmint` or `cmint --help`
- Responsibilities: Parse argv, set debug mode, write session header, dispatch to `agentCommand` (when `--agent`) or `commitCommand`

**commitCommand:**
- Location: `src/commands/commit.ts:35`
- Triggers: `cmint`, `cmint --auto`, `cmint -m "..."`, `cmint --retry`, `cmint -H "hint"`
- Responsibilities: Run preflight setup prompt, orchestrate entire commit lifecycle including retry mode, staging menu, excluded files handling, pre-commit checks, AI message generation, review, and recovery

**agentCommand:**
- Location: `src/commands/agent.ts:54`
- Triggers: `cmint --agent`
- Responsibilities: Headless non-interactive auto-group with JSON output, validates flags, asserts repo, auto-stages, runs checks, generates groups and messages, emits structured JSON, sets documented exit codes

**configCommand:**
- Location: `src/commands/config.ts:216`
- Triggers: `cmint config`
- Responsibilities: Interactive TUI for reading/writing `~/.commit-mint` INI values — provider selection, API key, model, locale, max-length, type, timeout, proxy

**logsCommand:**
- Location: `src/commands/logs.ts:8`
- Triggers: `cmint logs` or `cmint logs -n 50`
- Responsibilities: Read debug log file from `~/.cache/commit-mint/debug.log`, extract last session's content, display to stdout

**runAutoGroupFlow:**
- Location: `src/commands/auto-group.ts:49`
- Triggers: "Auto-group into commits" from staging menu, or `cmint --auto`
- Responsibilities: Filter excluded files, run pre-commit checks (with check failure menu + retry loop), call AI grouping with provider (including low-quality retry), show confirmation, sequential multi-commit with per-group recovery

**handleRetry:**
- Location: `src/commands/retry.ts:9`
- Triggers: `cmint --retry` or `cmint -r`
- Responsibilities: Load cached commit message, attempt commit via `commitWithRecovery`, exit with error on failure

**handleStaging:**
- Location: `src/commands/staging.ts:14`
- Triggers: Multiple changed files in normal mode
- Responsibilities: Interactive staging loop — auto-group, run checks, stage all, commit staged, select files; returns selected files or delegates to auto-group flow

**showCheckFailureMenu:**
- Location: `src/ui/check-failure-menu.ts:166`
- Triggers: User-defined pre-commit check failure
- Responsibilities: Show structured error summary with tsc/eslint inline diagnostics, offer copy/view/retry/skip/cancel, return `"skipped"` or `"cancelled"` or `"retried"`

**runPreflightSetupPrompt:**
- Location: `src/commands/setup.ts:191`
- Triggers: Start of `cmint` (inside `commitCommand`)
- Responsibilities: Detect existing `.cmintrc`, detect tools (biome/eslint/typescript/vitest), prompt user to auto-generate config, write `.cmintrc` file, support skip-marker (`".cmint-skip-setup"`) for permanent opt-out

## Error Handling

**Strategy:** Fail soft with structured feedback and recovery paths

- Git operations use `execa` with `reject: false` for expected failures; `KnownError` for domain-specific errors
- Commit attempts use try/catch with `ExecaError` — collect stderr, return `CommitResult` with `ok: boolean`
- AI errors are mapped to user-friendly messages per provider (invalid key, rate limit, timeout, API error) — `src/services/ai.ts` also handles non-Groq provider errors via status code regex
- Hook errors are parsed into structured `HookError[]` with 5 tool-specific parsers and a raw fallback for unrecognized output — `src/services/hooks.ts:parseHookErrors`
- User-defined pre-commit check failures show a separate `check-failure-menu.ts:showCheckFailureMenu` (copy/view/retry/skip/cancel) — none are dead ends
- Recovery menu provides 6 ways to respond to hook failures (none are dead ends)
- Staging errors are caught and reported with non-zero exit
- Agent mode uses 7 distinct exit codes via `EXIT_CODES` and emits `AgentResult` JSON on output

## Cross-Cutting Concerns

**Logging:** `src/utils/debug.ts` — module-level boolean gate, timestamped output. Writes to both stderr (via `console.error` with `kolorist` dim styling, only when `--debug` enabled) and a persistent log file at `~/.cache/commit-mint/debug.log` (always). Every CLI invocation writes a `--- session <ISO timestamp> ---` header. Viewable via `cmint logs [-n <lines>]`.

**Caching:** `src/utils/cache.ts` — SHA-256 hash (12-char prefix) of repo path → JSON file in `~/.cache/commit-mint/`. Stores commit message, timestamp, and repo path for `--retry`.

**Agent mode:** `src/utils/agent.ts` — module-level boolean gate (`setAgentMode`/`isAgentMode`). Defines `AgentResult`, `AgentCommit` types, `EXIT_CODES` constants, and `writeAgentResult` for JSON stdout output. Used by `agentCommand` and checked by UI functions to skip interactive prompts.

**Storage:** `src/services/config.ts` — INI-format config at `~/.commit-mint`. Defaults merged via spread. Keys: GROQ_API_KEY, CEREBRAS_API_KEY, MISTRAL_API_KEY, provider, model, model_groq, model_cerebras, model_mistral, locale, max-length, type, timeout, proxy.
