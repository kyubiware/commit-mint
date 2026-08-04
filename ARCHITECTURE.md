# Architecture

## Pattern Overview

**Overall:** CLI command-pipeline with interactive recovery loop

**Key Characteristics:**
- Single-entry orchestrator (`commitCommand`) that stages, generates, attempts, and recovers from hook failures
- Separate headless `agentCommand` for AI coding agents (non-interactive, JSON output, 7 documented exit codes)
- Plugin-style error parsers for 5 hook tools (lint-staged, biome, tsc, vitest/jest, eslint) with raw fallback — plus a separate `parseCheckErrors` for cmint check output format (`[tool]` prefix blocks)
- 4-tier diff compression for AI prompt efficiency (full → strip context → cap hunks → file summary)
- Provider abstraction supporting Groq, Cerebras, and Mistral via OpenAI-compatible API
- Interactive staging menu shown for **every** commit (select files, auto-group, run checks from cmint config, stage all, commit staged) — also the only entry point to the auto-accept `a` hotkey and skip-checks `c` hotkey toggles. "Select files..." is hidden when there is only one file
- Auto-accept mode toggled via `a` hotkey in the staging menu; when ON, skips the message review step. Skip-checks mode toggled via `c` hotkey; when ON, bypasses user-defined pre-commit checks. Both persisted to `~/.commit-mint` as `auto-accept` and `skip-checks` keys
- User-defined pre-commit checks via cmint config files (14 naming patterns, glob matching via picomatch, function commands)
- Shared interactive check-execution pipeline (`runCheckPhaseInteractive`) used by both `runPreCommitChecks` (post-staging) and `runAutoGroupFlow` (pre-staging), encapsulating: `detectConfig` guard → live progress display → `runAllChecks` → retry loop with `showCheckFailureMenu`
- Recursive recovery menu with 6 options (copy, view full output, skip hooks, restage, edit message, cancel)
- Check failure menu with 5 options (copy, view full output, retry checks, skip checks, cancel) — includes tsc inline diagnostics (up to 3), ESLint stylish format parsing, and vitest/jest test failure grouping
- AI-powered auto-grouping of changed files into logical commits, with low-quality grouping detection and retry
- Deterministic test/source reunification that moves misplaced test files back into the group containing their source counterpart (co-located, `__tests__/` mirror, and `tests/`/`test/` mirror layouts)
- Robust JSON array recovery for AI grouping responses (single-object fallback, markdown fence stripping, think tag removal)
- Real-time hook progress display during pre-commit hook execution
- Provider-aware model resolution: `model_groq`, `model_cerebras`, `model_mistral` override the global `model` key per provider
- Preflight `.cmintrc` setup prompt at the start of `cmint` (auto-detects biome/eslint/typescript/vitest, writes config file, supports `.cmint-skip-setup` marker for permanent opt-out)
- Debug session logging to `~/.cache/commit-mint/debug.log` with session headers, viewable via `cmint logs`
- Agent mode (`--agent`) for headless non-interactive auto-group with JSON output to stdout
- Stale-while-revalidate background update notifier — checks npm registry for newer version, shows nag on startup (3 cache bands: FRESH <1h silent, SWR 1-24h serve + background refresh, STALE ≥24h blocking fetch with cancellable spinner)
- Self-update via `cmint update` subcommand — detects package manager (`npm_config_user_agent`), fetches latest from npm registry, confirms and runs global install command
- File paths normalized to repo-root-relative for glob matching across all flows

## Layers

**CLI Layer:**
- Purpose: Parse argv and dispatch to commands
- Location: `src/cli.ts`
- Contains: Flag definitions (retry, auto, message, hint, debug, noCheck, agent), subcommand routing (`logs`, `config`, `auto`, `update`), dispatches to `agentCommand` (when `--agent` flag) or `commitCommand`
- Depends on: `cleye` library
- Used by: Package binary entry (`dist/cli.mjs`)

**Commands Layer:**
- Purpose: Orchestrate top-level workflows
- Location: `src/commands/`
- Contains: `commit.ts` (main lifecycle with preflight setup prompt), `commit-utils.ts` (shared recovery helpers), `agent.ts` (headless agent command with JSON output), `config.ts` (interactive config TUI), `auto-group.ts` (multi-commit flow), `retry.ts` (--retry mode), `staging.ts` (interactive staging loop + `runPreCommitChecks`), `check-phase.ts` (shared interactive check-execution pipeline used by staging and auto-group), `setup.ts` (preflight setup prompt + .cmintrc wizard), `logs.ts` (debug log viewer), `update.ts` (self-update command)
- Depends on: Services, UI, Utils
- Used by: CLI layer

**Services Layer:**
- Purpose: Encapsulate external system interactions and business logic
- Location: `src/services/`
- Contains: `git.ts` (git operations), `ai.ts` (multi-provider AI generation with 4-tier diff compression), `grouping.ts` (AI file grouping + low-quality detection + orphan validation), `grouping-parser.ts` (robust JSON array recovery for grouping responses), `grouping-reunite.ts` (deterministic test/source reunification), `provider.ts` (multi-provider abstraction: Groq, Cerebras, Mistral), `hooks.ts` (hook error parsing + `parseCheckErrors` for cmint check output + tool check summary), `hook-progress.ts` (real-time hook progress parser), `checks.ts` (user-defined pre-commit checks via cmint config files — config detection, glob matching via picomatch, command execution, function commands), `config.ts` (INI config at `~/.commit-mint`), `clipboard.ts` (cross-platform clipboard — wl-copy --foreground, wl-copy fallback, xclip, xsel, pbcopy), `auto-accept.ts` (auto-accept preference persistence), `skip-checks.ts` (skip-checks preference persistence), `update-check.ts` (stale-while-revalidate background update notifier), `updater.ts` (npm registry version check + global install)
- Depends on: `execa`, `groq-sdk`, `ini`, `picomatch`, `jiti`, `semver`, Node.js built-ins
- Used by: Commands layer

**UI Layer:**
- Purpose: Interactive terminal UI for recovery decisions, staging, check failures, and grouping confirmation
- Location: `src/ui/`
- Contains: `recovery-menu.ts` (recovery TUI with 6 options + clipboard state tracking), `staging-menu.ts` (staging menu with file list display, status labels, multi-select fallback, auto-accept `a` hotkey and skip-checks `c` hotkey toggle integration via `selectWithToggles`), `check-failure-menu.ts` (check failure menu with 5 options + tsc/eslint/vitest inline diagnostics), `toggle-select.ts` (generic `@clack/core` `SelectPrompt` wrapper with extensible inline hotkey toggles — auto-accept via `a`, skip-checks via `c`), `check-summary.ts` (check spinner summary utility with per-tool display), `review-message.ts` (message review: use-as-is/edit/cancel/regenerate), `grouping.ts` (grouping confirmation UI + grouped files display + progress display + grouping summary)
- Depends on: `@clack/prompts`, `@clack/core`, `kolorist`, Services (clipboard, hooks, git, auto-accept, skip-checks)
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
4. Check for updates (silent on cache hit, cancellable spinner on stale cache) — `src/services/update-check.ts:checkForUpdatesUpfront`
5. Check git status — `src/services/git.ts:getStatusShort`
6. Get changed files list — `src/services/git.ts:getChangedFiles`
7. Stage changes:
   - `--auto` flag: delegate to `runAutoGroupFlow` in `src/commands/auto-group.ts`
   - Otherwise: show interactive staging menu (auto-group into commits / commit staged only / stage all / run checks / select files / cancel) — `src/ui/staging-menu.ts:showStagingMenu`. The menu is shown for any number of changed files (including 1) because it is the only entry point to the auto-accept `a` hotkey and skip-checks `c` hotkey toggles. "Select files..." is hidden when there is only one file.
     - "Auto-group into commits" delegates to `runAutoGroupFlow` in `src/commands/auto-group.ts`
     - "Run checks" runs `runAllChecks` then refreshes changed files list
     - "Stage all" stages all files
     - "Select files" shows multi-select picker (hidden for single-file case)
8. Refresh file list to reflect staged state — `getChangedFiles`
9. Run user-defined pre-commit checks (if cmint config exists and `--noCheck` not set) — `src/commands/staging.ts:runPreCommitChecks` → `src/commands/check-phase.ts:runCheckPhaseInteractive` → `src/services/checks.ts:runAllChecks`. On failure: parse check errors via `parseCheckErrors`, show check failure menu (copy/view/retry/skip/cancel) — `src/ui/check-failure-menu.ts:showCheckFailureMenu`
10. Get staged diff with exclude patterns — `src/services/git.ts:getStagedDiff`
    - Returns `ExcludedFilesResult` when all staged files match exclude patterns (lockfiles, dist, etc.)
    - Excluded-only case: builds hardcoded message ("chore: update lockfile" / "chore: update generated files"), caches it, commits directly via `commitWithRecovery`
11. Ensure provider API key exists (prompt if missing) — `src/services/config.ts:getProviderApiKey` / `setConfigValue`
12. Generate commit message via AI with 4-tier diff compression — `src/services/ai.ts:generateCommitMessage`
13. Check auto-accept preference — `src/services/auto-accept.ts:getAutoAccept`
    - Auto-accept ON: skip review, log message directly
    - Auto-accept OFF: present message review (use-as-is / edit / cancel / regenerate) — `src/ui/review-message.ts:reviewCommitMessage`
14. Cache commit message — `src/utils/cache.ts:saveCachedCommit`
15. Attempt `git commit -m` with real-time hook progress display — `src/commands/commit-utils.ts:commitWithRecovery` → `src/services/git.ts:attemptCommit`
16. On success: print tool check summary from parsed hook stderr — `src/services/hooks.ts:parseToolChecks`
17. Loop check: if the staging choice was a subset ("Select files..." / "Commit staged files only" — `stagedAll` false from `handleStaging`) and `getChangedFiles()` still returns uncommitted files, re-show the staging menu (step 7) and repeat steps 8-16 — `src/commands/commit.ts` commit loop. "Stage all" and `--single` stage everything in one pass, so they exit with "Done." after the first commit
18. On failure: parse hook errors — `src/services/hooks.ts:parseHookErrors`
19. Show recovery menu — `src/ui/recovery-menu.ts:showRecoveryMenu`

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
3. Run user-defined pre-commit checks on all included files (unless `--noCheck`) — `src/commands/check-phase.ts:runCheckPhaseInteractive` → `src/services/checks.ts:runAllChecks`
   - On failure: parse check errors via `parseCheckErrors`, show check failure menu with retry loop — `src/ui/check-failure-menu.ts:showCheckFailureMenu`
   - Retry causes: re-run checks, loop back until passed/skipped/cancelled
4. Read config and determine provider
5. Ensure API key for selected provider (prompt if missing)
6. Call grouping service — `src/services/grouping.ts:generateGroups` (AI groups files by logical concern, uses provider abstraction)
   - Uses `parseGroupingResponse` from `src/services/grouping-parser.ts` for robust JSON recovery
   - Detects low-quality grouping via `isLowQualityGrouping` and retries automatically
7. Reunite test files with their source counterparts — `src/services/grouping-reunite.ts:reuniteTestsWithSources`
8. Validate groups, attach orphaned files as "Other changes" — `src/services/grouping.ts:validateGroups`
9. Show grouping confirmation — `src/ui/grouping.ts:showGroupingConfirmation` (skipped in auto mode)
10. Show grouped files table — `src/ui/grouping.ts:showGroupedFiles`
11. Sequential multi-commit loop: for each group, `resetStaging` → `stageFiles` → `getStagedDiff` → `generateMessage` → `reviewCommitMessage` (skipped in auto mode) → `saveCachedCommit` → `attemptCommit` with progress handler; on hook failure, show `showRecoveryMenu` and stop sequence
12. Each group commit shows progress — `src/ui/grouping.ts:showGroupProgress`

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
3. Show check failure menu with tsc diagnostic extraction, ESLint stylish format parsing, vitest/jest test failure grouping — `src/ui/check-failure-menu.ts:showCheckFailureMenu` (with optional retry callback)
4. **Copy error report:** format error report → clipboard → loop back
5. **View full output:** display raw stderr → loop back
6. **Retry checks:** re-run checks → return "retried" (caller handles the loop)
7. **Skip checks:** proceed to commit without passing checks
8. **Cancel:** exit with message cached (in normal mode) or stop auto-group flow

## Key Abstractions

**CheckPhaseOutcome:**
- Purpose: Outcome enum returned by `runCheckPhaseInteractive` so callers can react to user's failure-menu choice
- Location: `src/commands/check-phase.ts:15`
- Pattern: Union type `"passed" | "skipped" | "cancelled"`

**CheckRetryCallback:**
- Purpose: Optional callback invoked before each retry after the user picks "Retry checks" from the failure menu — used to refresh staged state (e.g. `stageAll()`)
- Location: `src/commands/check-phase.ts:24`
- Pattern: `() => Promise<void>`

**runCheckPhaseInteractive:**
- Purpose: Single entry point for the interactive check-execution pipeline shared by `runPreCommitChecks` (post-staging) and `runAutoGroupFlow` (pre-staging). Encapsulates: `detectConfig` guard → live progress display → `runAllChecks` → retry loop with `showCheckFailureMenu`. Caller is responsible for deriving repo-root-relative file paths and deciding how to handle `"cancelled"` (`process.exit(1)` vs propagating up).
- Location: `src/commands/check-phase.ts:44`
- Pattern: Async function `(repoRoot, files, timeout, onRetry?) => Promise<CheckPhaseOutcome>`

**HookError:**
- Purpose: Structured representation of a single hook failure (also used for check errors)
- Location: `src/services/hooks.ts:3`
- Pattern: Interface with `{ tool, message, raw }` shape

**ToolCheck:**
- Purpose: Structured representation of a tool's success/failure status in post-commit summary
- Location: `src/services/hooks.ts:230`
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
- Purpose: User configuration for AI provider, per-provider model keys, locale, max-length, type, timeout, proxy, auto-accept, skip-checks
- Location: `src/services/config.ts:15`
- Pattern: Interface with optional string-keyed properties; provider-specific model keys (`model_groq`, `model_cerebras`, `model_mistral`); auto-accept key; skip-checks key

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
- Location: `src/ui/staging-menu.ts:8`
- Pattern: Interface with `{ files: string[], all: boolean }`

**ToggleOption / ToggleSelectOptions / ToggleSelectResult:**
- Purpose: Types for the generic toggle-enabled select prompt — wraps `@clack/core` `SelectPrompt` with extensible inline hotkey toggles (auto-accept via `a`, skip-checks via `c`)
- Location: `src/ui/toggle-select.ts:22-56`
- Pattern: `ToggleSelectResult<T> { value: T, toggles: Record<string, boolean> }`

**CommitGroup:**
- Purpose: A logical group of files for auto-group flow
- Location: `src/services/grouping-parser.ts` (re-exported from `grouping.ts:7`)
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

**UpdateCheckStatus:**
- Purpose: Outcome of update check — distinguishes cache hits from real fetches
- Location: `src/services/update-check.ts:195-202`
- Pattern: Union type `"skipped" | "cache-update" | "cache-current" | "fetch-update" | "fetch-current" | "fetch-failed-or-aborted" | "error"`

**PackageManager:**
- Purpose: Active package manager detected for self-update
- Location: `src/services/updater.ts:5`
- Pattern: Union type `"npm" | "pnpm" | "yarn" | "bun"`

## Entry Points

**cmint CLI:**
- Location: `src/cli.ts`
- Triggers: User runs `cmint` or `cmint --help`
- Responsibilities: Parse argv, set debug mode, write session header, dispatch to subcommands (`logs`, `config`, `auto`, `update`) or `agentCommand` (when `--agent`) or `commitCommand`

**commitCommand:**
- Location: `src/commands/commit.ts:36`
- Triggers: `cmint`, `cmint --auto`, `cmint -m "..."`, `cmint --retry`, `cmint -H "hint"`, `cmint auto`
- Responsibilities: Run preflight setup prompt, check for updates upfront, orchestrate entire commit lifecycle including retry mode, staging menu, excluded files handling, pre-commit checks, AI message generation, review (with auto-accept), and recovery

**agentCommand:**
- Location: `src/commands/agent.ts:42`
- Triggers: `cmint --agent`
- Responsibilities: Headless non-interactive auto-group with JSON output, validates flags, asserts repo, auto-stages, runs checks, generates groups and messages, emits structured JSON, sets documented exit codes

**configCommand:**
- Location: `src/commands/config.ts:217`
- Triggers: `cmint config`
- Responsibilities: Interactive TUI for reading/writing `~/.commit-mint` INI values — provider selection, API key, model, locale, max-length, type, timeout, proxy

**logsCommand:**
- Location: `src/commands/logs.ts:8`
- Triggers: `cmint logs` or `cmint logs -n 50`
- Responsibilities: Read debug log file from `~/.cache/commit-mint/debug.log`, extract last session's content, display to stdout

**updateCommand:**
- Location: `src/commands/update.ts:25`
- Triggers: `cmint update` or `cmint update -y`
- Responsibilities: Detect package manager, fetch latest version from npm registry, confirm and run global install command

**runAutoGroupFlow:**
- Location: `src/commands/auto-group.ts:50`
- Triggers: "Auto-group into commits" from staging menu, or `cmint --auto` / `cmint auto`
- Responsibilities: Filter excluded files, run pre-commit checks (with check failure menu + retry loop), call AI grouping with provider (including low-quality retry and test/source reunification), show confirmation, sequential multi-commit with per-group recovery

**handleRetry:**
- Location: `src/commands/retry.ts:9`
- Triggers: `cmint --retry` or `cmint -r`
- Responsibilities: Load cached commit message, attempt commit via `commitWithRecovery`, exit with error on failure

**handleStaging:**
- Location: `src/commands/staging.ts:20`
- Triggers: Changed files in normal mode
- Responsibilities: Interactive staging loop — auto-group, run checks, stage all, commit staged, select files; calls `showStagingMenu` which uses `selectWithToggles` from `toggle-select.ts` for auto-accept (`a`) and skip-checks (`c`) hotkey toggles; returns selected files (with `stagedAll` flag indicating whether the user chose "Stage all" vs a subset — drives the commit loop) or delegates to auto-group flow

**showCheckFailureMenu:**
- Location: `src/ui/check-failure-menu.ts:235`
- Triggers: User-defined pre-commit check failure
- Responsibilities: Show structured error summary with tsc/eslint/vitest inline diagnostics, offer copy/view/retry/skip/cancel, return `"skipped"` or `"cancelled"` or `"retried"`

**runPreflightSetupPrompt:**
- Location: `src/commands/setup.ts:189`
- Triggers: Start of `cmint` (inside `commitCommand`)
- Responsibilities: Detect existing `.cmintrc`, detect tools (biome/eslint/typescript/vitest), prompt user to auto-generate config, write `.cmintrc` file, support skip-marker (`".cmint-skip-setup"`) for permanent opt-out

**checkForUpdatesUpfront:**
- Location: `src/services/update-check.ts:310`
- Triggers: Start of `cmint` (inside `commitCommand`, after header)
- Responsibilities: Stale-while-revalidate update check — fast path for fresh/SWR cache, slow path with cancellable spinner for stale/missing cache, displays nag when update available

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
- Update check errors are silently swallowed (best-effort nag, never surfaces errors to user)

## Cross-Cutting Concerns

**Logging:** `src/utils/debug.ts` — module-level boolean gate, timestamped output. Writes to both stderr (via `console.error` with `kolorist` dim styling, only when `--debug` enabled) and a persistent log file at `~/.cache/commit-mint/debug.log` (always). Every CLI invocation writes a `--- session <ISO timestamp> ---` header. Viewable via `cmint logs [-n <lines>]`.

**Caching:** `src/utils/cache.ts` — SHA-256 hash (12-char prefix) of repo path → JSON file in `~/.cache/commit-mint/`. Stores commit message, timestamp, and repo path for `--retry`. Also: `src/services/update-check.ts` — JSON cache at `~/.cache/commit-mint/update-check.json` for update notifier with stale-while-revalidate strategy.

**Agent mode:** `src/utils/agent.ts` — module-level boolean gate (`setAgentMode`/`isAgentMode`). Defines `AgentResult`, `AgentCommit` types, `EXIT_CODES` constants, and `writeAgentResult` for JSON stdout output. Used by `agentCommand` and checked by UI functions to skip interactive prompts.

**Auto-accept:** `src/services/auto-accept.ts` — persists auto-accept preference to `~/.commit-mint` as `auto-accept` key. Toggled via `a` hotkey in the staging menu (`src/ui/toggle-select.ts`). When enabled, skips the message review step in `commitCommand`.

**Skip-checks:** `src/services/skip-checks.ts` — persists skip-checks preference to `~/.commit-mint` as `skip-checks` key. Toggled via `c` hotkey in the staging menu (`src/ui/toggle-select.ts`). When enabled, bypasses user-defined pre-commit checks in the staging flow.

**Storage:** `src/services/config.ts` — INI-format config at `~/.commit-mint`. Defaults merged via spread. Keys: GROQ_API_KEY, CEREBRAS_API_KEY, MISTRAL_API_KEY, provider, model, model_groq, model_cerebras, model_mistral, locale, max-length, type, timeout, proxy, auto-accept, skip-checks.
