# Architecture

## Pattern Overview

**Overall:** CLI command-pipeline with interactive recovery loop

**Key Characteristics:**
- Single-entry orchestrator (`commitCommand`) that stages, generates, attempts, and recovers from hook failures
- Plugin-style error parsers for 5 hook tools (lint-staged, biome, tsc, vitest/jest, eslint)
- 3-tier diff compression for AI prompt efficiency
- Interactive staging menu for multi-file workflows (select files, auto-group, run checks from .cmintrc.js)
- Recursive recovery menu that loops until success or cancellation
- AI-powered auto-grouping of changed files into logical commits
- Code review via OpenCode or Groq (in-flow during message review or standalone `--review`)

## Layers

**CLI Layer:**
- Purpose: Parse argv and dispatch to commands
- Location: `src/cli.ts`
- Contains: Flag definitions (retry, all, message, hint, review, debug), command routing to `commitCommand`, `configCommand`, or `reviewCommand`
- Depends on: `cleye` library
- Used by: Package binary entry (`dist/cli.mjs`)

**Commands Layer:**
- Purpose: Orchestrate top-level workflows (commit, config, review, auto-group)
- Location: `src/commands/`
- Contains: `commit.ts` (main lifecycle), `config.ts` (config get/set), `auto-group.ts` (multi-commit flow), `review.ts` (code review)
- Depends on: Services, UI, Utils
- Used by: CLI layer

**Services Layer:**
- Purpose: Encapsulate external system interactions and business logic
- Location: `src/services/`
- Contains: `git.ts` (git operations), `ai.ts` (Groq AI generation), `hooks.ts` (hook error parsing), `config.ts` (INI config), `clipboard.ts` (cross-platform clipboard), `grouping.ts` (AI file grouping), `review-ai.ts` (AI code review), `checks.ts` (User-defined pre-commit checks via .cmintrc.js — config detection, glob matching via picomatch, command execution)
- Depends on: `execa`, `groq-sdk`, `ini`, Node.js built-ins
- Used by: Commands layer

**UI Layer:**
- Purpose: Interactive terminal UI for recovery decisions and staging
- Location: `src/ui/`
- Contains: `menu.ts` (recovery TUI + staging menu), `review-message.ts` (message review with inline code review), `grouping.ts` (grouping confirmation UI)
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
   - `--all` flag: auto-stage all tracked files — `stageAll`
   - Single file: auto-stage it — `stageFiles`
   - Multiple files: show interactive staging menu (select files / auto-group / run checks) — `src/ui/menu.ts:showStagingMenu`
     - "Auto-group into commits" delegates to `runAutoGroupFlow` in `src/commands/auto-group.ts`
     - "Run checks (from .cmintrc.js)" runs `runAllChecks` then refreshes changed files list
6. Run user-defined checks (if .cmintrc.js exists) — `src/services/checks.ts:runAllChecks`. On failure: show check failure menu (copy/skip/cancel) — `src/ui/menu.ts:showCheckFailureMenu`
7. Get staged diff with exclude patterns — `src/services/git.ts:getStagedDiff`
   - Returns `ExcludedFilesResult` when all staged files match exclude patterns (lockfiles, dist, etc.)
   - Excluded-only case: builds hardcoded message ("chore: update lockfile" / "chore: update generated files"), caches it, commits directly
8. Ensure API key exists (prompt if missing) — `src/services/config.ts:getApiKey` / `setConfigValue`
9. Generate commit message via AI with 3-tier diff compression — `src/services/ai.ts:generateCommitMessage`
10. Present message review (use-as-is / edit / review with OpenCode / cancel) — `src/ui/review-message.ts:reviewCommitMessage`
11. Cache commit message — `src/utils/cache.ts:saveCachedCommit`
12. Attempt `git commit -m` with real-time stderr collection — `src/services/git.ts:attemptCommit`
13. On success: print "Done." — `src/commands/commit.ts`
14. On failure: parse hook errors — `src/services/hooks.ts:parseHookErrors`
15. Show recovery menu — `src/ui/menu.ts:showRecoveryMenu`

**Recovery Menu Flow:**

1. User chooses action from 5 options — `src/ui/menu.ts:showRecoveryMenu`
2. **Copy errors:** format error report → clipboard (returns boolean) → loop back to menu
3. **Skip hooks:** `git commit --no-verify` — `src/services/git.ts:attemptCommitNoVerify`
4. **Re-stage & retry:** `git add -A` → retry commit; on re-failure, re-show errors and loop back
5. **Edit message:** prompt new message → retry commit → return "committed" or "failed"
6. **Cancel:** exit with message cached for `--retry`, return "cancelled"
- Returns `RecoveryResult` type (`"committed" | "cancelled" | "failed"`)

**Retry Flow:**

1. Parse `--retry` / `-r` flag — `src/cli.ts`
2. Load cached commit from `~/.cache/commit-mint/<12-char-sha256>.json` — `src/utils/cache.ts:loadCachedCommit`
3. Attempt commit; on failure enter recovery menu — same as normal mode steps 11-14

**Auto-Group Flow:**

1. Filter excluded files — `src/services/grouping.ts:filterExcludedFiles` (promotes lockfiles when companion manifest present)
2. Ensure API key
3. Call grouping service — `src/services/grouping.ts:generateGroups` (AI groups files by logical concern)
4. Validate groups, attach orphaned files as "Other changes" — `src/services/grouping.ts:validateGroups`
5. Show grouping confirmation — `src/ui/grouping.ts:showGroupingConfirmation`
6. Sequential multi-commit loop: for each group, `resetStaging` → `stageFiles` → `getStagedDiff` → `generateMessage` → `reviewCommitMessage` → `saveCachedCommit` → `attemptCommit`; on hook failure, show `showRecoveryMenu` and stop sequence
7. Each group commit shows progress — `src/ui/grouping.ts:showGroupProgress`

**Code Review Flow:**

1. `cmint --review` / `-R` flag — `src/cli.ts`
2. Assert git repo, stage all, get diff — `src/commands/review.ts:reviewCommand`
3. Check if OpenCode is available (`which opencode`) — `isOpenCodeAvailable`
4. OpenCode available: build review prompt with diff, run `opencode run <prompt> --dir <repo>`
5. OpenCode unavailable: use Groq SDK with `generateCodeReview` — `src/services/review-ai.ts`
6. Show findings as structured note; offer clipboard copy

## Key Abstractions

**HookError:**
- Purpose: Structured representation of a single hook failure
- Location: `src/services/hooks.ts:4`
- Pattern: Interface with `{ tool, message, raw }` shape

**ToolCheck:**
- Purpose: Structured representation of a tool's success/failure status in post-commit summary
- Location: `src/services/hooks.ts:157`
- Pattern: Interface with `{ tool, ok }` shape

**ChangedFile:**
- Purpose: Representation of a changed file with status and staged state
- Location: `src/services/git.ts:34`
- Pattern: Interface with `{ path, status, staged }` shape

**DiffResult / StagedDiffResult / ExcludedFilesResult:**
- Purpose: Union type for diff query results — normal diff vs all-excluded case vs no changes
- Location: `src/services/git.ts:23-32`
- Pattern: `StagedDiffResult { files, diff } | ExcludedFilesResult { excludedFiles } | null`

**CommitResult:**
- Purpose: Result of a `git commit` attempt including hook stderr
- Location: `src/services/git.ts:140`
- Pattern: Interface with `{ ok, error?, stderr? }`

**CachedCommit:**
- Purpose: Persisted commit message with metadata for `--retry`
- Location: `src/utils/cache.ts:17`
- Pattern: Interface with `{ message, timestamp, repoPath }` shape

**Config:**
- Purpose: User configuration for AI model, locale, max-length, type, timeout, proxy
- Location: `src/services/config.ts:10`
- Pattern: Interface with optional string-keyed properties

**KnownError:**
- Purpose: Distinguishable error class for git-specific failures
- Location: `src/services/git.ts:5`
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
- Location: `src/services/grouping.ts:6`
- Pattern: Interface with `{ name, description, files }` shape

**GroupingResult:**
- Purpose: Result of AI file grouping
- Location: `src/services/grouping.ts:12`
- Pattern: Interface with `{ groups: CommitGroup[], excluded: string[] }`

**CheckConfig:**
- Purpose: User-defined check configuration mapping globs to commands
- Location: `src/services/checks.ts:8`
- Pattern: Index signature `[glob: string]: string | string[]`

**CheckResult:**
- Purpose: Result of a single check command execution
- Location: `src/services/checks.ts:13`
- Pattern: Interface with `{ ok, tool, command, stdout, stderr, files }` shape

**CheckResults:**
- Purpose: Aggregated results from running all configured checks
- Location: `src/services/checks.ts:23`
- Pattern: Interface with `{ ok, results: CheckResult[] }` shape

## Entry Points

**cmint CLI:**
- Location: `src/cli.ts`
- Triggers: User runs `cmint` or `cmint --help`
- Responsibilities: Parse argv, set debug flag, dispatch to `commitCommand`, `configCommand`, or `reviewCommand`

**commitCommand:**
- Location: `src/commands/commit.ts:30`
- Triggers: `cmint`, `cmint -a`, `cmint -m "..."`, `cmint -r`, `cmint -H "hint"`
- Responsibilities: Orchestrate entire commit lifecycle including retry mode, staging menu, excluded files handling

**configCommand:**
- Location: `src/commands/config.ts:4`
- Triggers: `cmint config get <key>`, `cmint config set <key>=<value>`
- Responsibilities: Read/write `~/.commit-mint` INI values

**reviewCommand:**
- Location: `src/commands/review.ts:9`
- Triggers: `cmint --review`, `cmint -R`
- Responsibilities: Stage all tracked files, run code review via OpenCode or Groq, display findings

**runAutoGroupFlow:**
- Location: `src/commands/auto-group.ts:32`
- Triggers: "Auto-group into commits" from staging menu
- Responsibilities: Filter excluded files, call AI grouping, show confirmation, sequential multi-commit with per-group recovery

## Error Handling

**Strategy:** Fail soft with structured feedback and recovery paths

- Git operations use `execa` with `reject: false` for expected failures; `KnownError` for domain-specific errors
- Commit attempts use try/catch with `ExecaError` — collect stderr, return `CommitResult` with `ok: boolean`
- AI errors are mapped to user-friendly messages (invalid key, rate limit, timeout, API error)
- Hook errors are parsed into structured `HookError[]` with 5 tool-specific parsers and a raw fallback for unrecognized output
- Recovery menu provides 5 ways to respond to hook failures (none are dead ends)
- Staging errors are caught and reported with non-zero exit

## Cross-Cutting Concerns

**Logging:** `src/utils/debug.ts` — module-level boolean gate, timestamped stderr output via `console.error` with `kolorist` dim styling. Enabled by `--debug` / `-d` flag.

**Caching:** `src/utils/cache.ts` — SHA-256 hash (12-char prefix) of repo path → JSON file in `~/.cache/commit-mint/`. Stores commit message, timestamp, and repo path for `--retry`.

**Storage:** `src/services/config.ts` — INI-format config at `~/.commit-mint`. Defaults merged via spread. Keys: GROQ_API_KEY, model, locale, max-length, type, timeout, proxy.
