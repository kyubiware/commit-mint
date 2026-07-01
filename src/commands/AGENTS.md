# COMMANDS KNOWLEDGE BASE

## OVERVIEW

CLI workflow orchestration. 7 source modules, 3 co-located tests.

## STRUCTURE

```
src/commands/
├── commit.ts           # Main lifecycle: retry / auto-group / normal flow
├── commit-utils.ts     # Shared recovery helpers
├── auto-group.ts       # Multi-commit grouping flow
├── staging.ts          # Interactive staging loop
├── check-phase.ts      # Shared interactive check-execution pipeline (used by staging + auto-group)
├── retry.ts            # --retry cached message replay
├── config.ts           # cmint config get/set TUI
├── commit.test.ts      # Commit flow tests
├── auto-group.test.ts  # Auto-group flow tests
└── check-phase.test.ts # Check-phase pipeline tests
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add CLI flag routing | `commit.ts` | `commitCommand()` dispatches by flag |
| Change retry behavior | `retry.ts` | `handleRetry()` loads cache, delegates to recovery |
| Change staging menu | `staging.ts` | `handleStaging()` loop, `runPreCommitChecks()` |
| Change check pipeline | `check-phase.ts` | `runCheckPhaseInteractive()` — single entry point for detectConfig → live progress display → runAllChecks → retry loop with failure menu |
| Change auto-group flow | `auto-group.ts` | `runAutoGroupFlow()` sequential per-group commits |
| Change recovery cycle | `commit-utils.ts` | `commitWithRecovery()` attempt → HEAD check → menu |
| Change config TUI | `config.ts` | `configCommand()` interactive INI read/write |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `commitCommand` | Function | `commit.ts:34` | Entry dispatcher: retry → auto-group → normal |
| `handleRetry` | Function | `retry.ts:9` | Load cached message, attempt via recovery |
| `handleStaging` | Function | `staging.ts:13` | Interactive loop: menu → stage → checks |
| `runPreCommitChecks` | Function | `staging.ts` | Post-staging wrapper: gets staged files, calls `runCheckPhaseInteractive`, then re-stages formatter modifications |
| `runCheckPhaseInteractive` | Function | `check-phase.ts:38` | Shared interactive check pipeline. Takes `(repoRoot, files: repo-root-relative, timeout, onRetry?)`. Returns `"passed" \| "skipped" \| "cancelled"` |
| `runAutoGroupFlow` | Function | `auto-group.ts:47` | Filter → commit excluded → group → sequential commits |
| `commitWithRecovery` | Function | `commit-utils.ts:27` | Attempt → HEAD check → recovery menu |
| `makeRecoveryCallbacks` | Function | `commit-utils.ts:9` | Factory for recovery menu callback set |
| `configCommand` | Function | `config.ts:216` | Interactive TUI for `~/.commit-mint` |
| `CommitFlags` | Interface | `auto-group.ts:37` | `{ auto, retry, message, hint, noCheck }` |

## ANTI-PATTERNS (COMMANDS)

- NEVER use `console.log` for user output (config.ts already violates this)
- Recovery menu is recursive — re-stage failure re-shows menu
- Auto-group commits sequentially, NOT in parallel (git locking)
- Hook failure during auto-group STOPS sequence (doesn't skip remaining groups)
- Excluded files committed BEFORE auto-group with hardcoded messages
- NEVER call `runAllChecks` directly from a command — use `runCheckPhaseInteractive` so the detectConfig guard, progress display, and failure-menu loop are applied consistently. Direct calls bypass the shared pipeline and re-introduce the path-frame / display bugs that the extraction eliminated.
