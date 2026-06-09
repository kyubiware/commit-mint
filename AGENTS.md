# PROJECT KNOWLEDGE BASE

**Generated:** 2026-06-09
**Commit:** 476246b
**Branch:** main

## OVERVIEW

CLI tool (`cmint`) that wraps `git commit` with AI-generated messages (multi-provider: Groq, Cerebras, Mistral) and an interactive recovery menu for pre-commit hook failures. TypeScript/ESM, built with tsdown.

## STRUCTURE

```
src/
├── cli.ts                  # Entry point (cleye CLI parser, flags: --retry/-r, --auto/-a, --message/-m, --hint/-H, --noCheck/-n, --debug/-d)
├── env.d.ts                # Picomatch type declaration
├── commands/               # CLI workflow orchestrators → see src/commands/AGENTS.md
├── services/               # External system integrations → see src/services/AGENTS.md
├── ui/
│   ├── menu.ts             # Recovery TUI (6 options) + staging menu + check failure menu (4 options)
│   ├── menu.test.ts        # Menu UI tests
│   ├── review-message.ts   # Message review step (use-as-is / edit / cancel)
│   └── grouping.ts         # Grouping confirmation UI + grouped files display + progress
└── utils/
    ├── cache.ts            # Commit message persistence at ~/.cache/commit-mint/
    ├── debug.ts            # Timestamped debug logging to stderr
    └── debug.test.ts       # Debug utility tests
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add new CLI flag | `src/cli.ts` | Add to `flags` object, pass through to `commitCommand` |
| Change commit flow | `src/commands/commit.ts` | Main lifecycle: retry → auto-group → normal (staging → checks → generate → review → commit) |
| Change auto-group flow | `src/commands/auto-group.ts` | Multi-commit: excluded files → checks → AI grouping → sequential per-group commits |
| Change AI generation | `src/services/ai.ts` | 4-tier diff compression, multi-provider, validation retry |
| Add/change provider | `src/services/provider.ts` | Add to `PROVIDER_CONFIGS` + `PROVIDER_ENV_KEYS`, update `ProviderName` |
| Parse a new hook type | `src/services/hooks.ts` | Add parser fn, wire into `parseHookErrors` |
| Add recovery menu option | `src/ui/menu.ts` | Add to options array + switch case |
| Add staging menu option | `src/ui/menu.ts` | Add to `showStagingMenu` options |
| Change message review | `src/ui/review-message.ts` | 3-option review: use-as-is / edit / cancel |
| Config format/defaults | `src/services/config.ts` | INI at `~/.commit-mint`, per-provider model keys |
| Cache persistence | `src/utils/cache.ts` | SHA-256 hash of repo path as key |
| Debug logging | `src/utils/debug.ts` | `debug(...)` prints to stderr when `--debug` flag is set |
| Add new check command | `src/services/checks.ts` | Add to cmint config file (14 naming patterns) |
| Change file grouping | `src/services/grouping.ts` | AI grouping, exclude filtering, lockfile companion promotion |
| Change hook progress display | `src/services/hook-progress.ts` | [STARTED]/[COMPLETED]/[FAILED] marker parsing |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `commitCommand` | Function | `src/commands/commit.ts:34` | Main commit lifecycle orchestrator |
| `runAutoGroupFlow` | Function | `src/commands/auto-group.ts:47` | Auto-group multi-commit flow |
| `handleStaging` | Function | `src/commands/staging.ts:13` | Interactive staging loop |
| `handleRetry` | Function | `src/commands/retry.ts:9` | Load cached message, re-attempt commit |
| `commitWithRecovery` | Function | `src/commands/commit-utils.ts` | Attempt → HEAD check → recovery menu |
| `configCommand` | Command | `src/commands/config.ts:216` | `cmint config` interactive TUI |
| `generateCommitMessage` | Function | `src/services/ai.ts:172` | Multi-provider AI call, diff compression, validation retry |
| `compressDiff` | Function | `src/services/ai.ts:55` | 4-tier diff compression (full → strip context → cap hunks → file summary) |
| `createProvider` | Function | `src/services/provider.ts:104` | Provider factory (Groq SDK or fetch client) |
| `parseHookErrors` | Function | `src/services/hooks.ts:13` | Routes stderr to 5 tool-specific parsers |
| `parseToolChecks` | Function | `src/services/hooks.ts:182` | Post-commit tool success/failure summary |
| `generateGroups` | Function | `src/services/grouping.ts:154` | AI file grouping into logical commits |
| `validateGroups` | Function | `src/services/grouping.ts:227` | Attach orphaned files, deduplicate |
| `runAllChecks` | Function | `src/services/checks.ts:239` | Detect config → load → match → run checks |
| `getStagedDiff` | Function | `src/services/git.ts:59` | Diff with exclude patterns, returns union type |
| `attemptCommit` | Function | `src/services/git.ts:148` | `git commit -m` with real-time stderr collection |
| `showRecoveryMenu` | Function | `src/ui/menu.ts:140` | 6-option recovery TUI (recursive on re-stage fail) |
| `showStagingMenu` | Function | `src/ui/menu.ts:17` | Staging: select files / auto-group / run checks / stage all |
| `showCheckFailureMenu` | Function | `src/ui/menu.ts:269` | Check failure: copy / view / skip / cancel |
| `reviewCommitMessage` | Function | `src/ui/review-message.ts` | Message review: use-as-is / edit / cancel |
| `showGroupingConfirmation` | Function | `src/ui/grouping.ts` | Grouping confirmation with file list |
| `Config` | Interface | `src/services/config.ts:15` | Config shape with per-provider model keys |
| `ProviderName` | Type | `src/services/provider.ts:4` | `"groq" \| "cerebras" \| "mistral"` |

## CONVENTIONS

- **Tabs for indentation** (biome.json: `indentStyle: "tab"`, `lineWidth: 100`)
- **ESM only** — all imports use `.js` extension (`import { x } from "./foo.js"`)
- **Error handling**: `execa` with `reject: false` for expected failures; try/catch with `ExecaError` for commits
- **Config**: INI format at `~/.commit-mint`, defaults merged via spread
- **Cache**: JSON at `~/.cache/commit-mint/<sha256-prefix>.json`
- **CLI parsing**: `cleye` library (argv → typed flags)
- **TUI**: `@clack/prompts` for selects/notes/spinners, `kolorist` for colors
- **No index files** — direct imports from module files
- **Tests**: Co-located `*.test.ts` siblings, `vi.mock(...)` at top, `vi.mocked(...)` for assertions
- **Build**: `tsdown` (NOT tsup) — configured via CLI args only, no config file

## ANTI-PATTERNS (THIS PROJECT)

- **NEVER use `console.log` for user output** — use `@clack/prompts` (intro/outro/note/log) or `kolorist`. ⚠️ `src/commands/config.ts` violates this (uses `console.log`/`console.error`)
- **NEVER use CommonJS syntax** — this is ESM-only (`"type": "module"`)
- **NEVER add clipboard dependencies** — shell out to platform tools (xclip/wl-copy/pbcopy)
- **NEVER modify hook output parsing without testing all 5 parsers** — lint-staged, biome, tsc, vitest/eslint are all interleaved in `parseHookErrors`
- **NEVER hardcode model names** — use `getModelForProvider()` resolution chain (per-provider override → global model → provider default)
- **NEVER add lint-staged dependency** — project uses cmint config files for pre-commit checks
- **NEVER include `/openai/v1/` in Groq baseURL** — Groq SDK appends it internally; non-Groq providers use fetch client that appends `/chat/completions` directly

## COMMANDS

```bash
npm run build           # tsdown src/cli.ts --format esm --dts --clean
npm run dev             # tsx src/cli.ts
npm run dev:debug       # tsx src/cli.ts --debug
npm run lint            # biome check .
npm run lint:fix        # biome check --fix .
npm run typecheck       # tsc --noEmit
npm run test            # vitest run
npm run test:coverage   # vitest run --coverage
npm run test:watch      # vitest --watch
```

## NOTES

- Multi-provider AI: Groq SDK for groq provider, generic fetch client for cerebras/mistral. `createProvider()` in `src/services/provider.ts` routes automatically.
- Diff compression is 4-tier (not 3): Tier 0 full (≤20K chars) → Tier 1 strip context → Tier 2 cap hunks (10 changed lines) → Tier 3 file summary
- Commit flow includes message review step (use-as-is / edit / cancel) before attempting commit
- `--hint/-H` flag passes user context to AI prompt alongside diff
- `--debug/-d` flag enables timestamped stderr logging via `src/utils/debug.ts`
- `--noCheck/-n` flag skips pre-commit checks
- Config file path: `~/.commit-mint` (not `~/.config/commit-mint`)
- Cache path: `~/.cache/commit-mint/`
- Clipboard tries commands in order: wl-copy → xclip → xsel → pbcopy
- Recovery menu is recursive — re-stage failure re-shows the menu
- `getStagedDiff` excludes: package-lock.json, node_modules, dist, build, .next, coverage, *.log, *.min.js, *.min.css, *.lock, .DS_Store
- Auto-group commits sequentially (git locking), hook failure stops the sequence
- Lockfile companion promotion: `package-lock.json` staged alongside `package.json` even if excluded
- Excluded-only diff gets hardcoded commit message ("chore: update lockfile" / "chore: update generated files")
- CI: `.github/workflows/ci.yml` (test + lint + typecheck) + `release.yml` (publish on tags)
- Package bin output: `dist/cli.mjs` (explicit ESM extension)
