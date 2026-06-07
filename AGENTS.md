# PROJECT KNOWLEDGE BASE

**Generated:** 2026-05-19
**Commit:** df07bf9
**Branch:** main

## OVERVIEW

CLI tool (`cmint`) that wraps `git commit` with AI-generated messages (Groq SDK) and an interactive recovery menu for pre-commit hook failures. TypeScript/ESM, built with tsdown.

## STRUCTURE

```
src/
├── cli.ts                  # Entry point (cleye CLI parser, flags: --retry/-r, --all/-a, --message/-m, --hint/-H, --debug/-d)
├── commands/
│   ├── commit.ts           # Main commit flow: stage → generate → review → commit → recover
│   ├── commit.test.ts      # Commit flow unit tests (exhaustive mock isolation)
│   └── config.ts           # `cmint config get/set` subcommand (⚠️ uses console.log)
├── services/
│   ├── ai.ts               # Groq AI message generator (3-tier diff compression, conventional commit validation + retry)
│   ├── ai.test.ts          # AI service tests (Groq SDK mock class hierarchy)
│   ├── git.ts              # Git operations (stage, diff, commit, HEAD)
│   ├── hooks.ts            # Hook error parser (lint-staged, biome, tsc, vitest, eslint)
│   ├── config.ts           # INI config at ~/.commit-mint
│   ├── clipboard.ts        # Cross-platform clipboard (xclip/wl-copy/pbcopy)
│   └── checks.ts           # User-defined pre-commit checks (.cmintrc.js config detection, glob matching, command execution)
├── ui/
│   └── menu.ts             # Recovery TUI (copy/skip/retry/edit/cancel)
└── utils/
    ├── cache.ts            # Commit message persistence at ~/.cache/commit-mint/
    ├── debug.ts            # Timestamped debug logging to stderr
    └── debug.test.ts       # Debug utility tests
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add new CLI flag | `src/cli.ts` | Add to `flags` object, pass through to `commitCommand` |
| Change commit flow | `src/commands/commit.ts` | Main lifecycle: retry mode + normal mode (with message review step) |
| Change AI generation | `src/services/ai.ts` | Diff compression, prompt building, Groq API call, validation retry |
| Parse a new hook type | `src/services/hooks.ts` | Add parser fn, wire into `parseHookErrors` |
| Add recovery menu option | `src/ui/menu.ts` | Add to options array + switch case |
| Config format/defaults | `src/services/config.ts` | INI at `~/.commit-mint`, defaults at line 20 |
| Cache persistence | `src/utils/cache.ts` | SHA-256 hash of repo path as key |
| Debug logging | `src/utils/debug.ts` | `debug(...)` prints to stderr when `--debug` flag is set |
| Add new check command | `src/services/checks.ts` | Add to .cmintrc.js config |
| Change check behavior | `src/services/checks.ts` | `matchFiles`, `buildCommand`, `runCommand`, `runAllChecks` |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `commitCommand` | Function | `src/commands/commit.ts:26` | Main commit lifecycle orchestrator |
| `generateMessage` | Function | `src/commands/commit.ts:215` | Config → AI adapter (reads config, delegates to `generateCommitMessage`) |
| `generateCommitMessage` | Function | `src/services/ai.ts:124` | Groq API call with diff compression, validation, retry |
| `compressDiff` | Function | `src/services/ai.ts:16` | 3-tier diff compression (full → strip context → per-hunk cap → file summary) |
| `parseHookErrors` | Function | `src/services/hooks.ts:14` | Routes stderr to 5 tool-specific parsers |
| `showRecoveryMenu` | Function | `src/ui/menu.ts:8` | Interactive recovery TUI (recursive on re-stage fail) |
| `attemptCommit` | Function | `src/services/git.ts:84` | `git commit -m`, returns `CommitResult` |
| `getStagedDiff` | Function | `src/services/git.ts:23` | Diff with default excludes (lockfiles, dist, etc.) |
| `KnownError` | Class | `src/services/git.ts:5` | Base error for git-specific failures |
| `HookError` | Interface | `src/services/hooks.ts:4` | `{ tool, message, raw }` error shape |
| `CachedCommit` | Interface | `src/utils/cache.ts:17` | `{ message, timestamp, repoPath }` |
| `Config` | Interface | `src/services/config.ts:10` | Config shape (GROQ_API_KEY, model, locale, max-length, type, timeout, proxy) |
| `copyToClipboard` | Function | `src/services/clipboard.ts:3` | Tries wl-copy → xclip → xsel → pbcopy |
| `debug` | Function | `src/utils/debug.ts:13` | Timestamped stderr output (gated by `isDebug()`) |
| `configCommand` | Command | `src/commands/config.ts:4` | `cmint config get/set` |
| `detectConfig` | Function | `src/services/checks.ts:32` | Check for .cmintrc.js at repo root |
| `loadConfig` | Function | `src/services/checks.ts:48` | Load and validate .cmintrc.js |
| `matchFiles` | Function | `src/services/checks.ts:117` | Filter files by picomatch glob |
| `buildCommand` | Function | `src/services/checks.ts:190` | Build command string with quoted file paths |
| `runCommand` | Function | `src/services/checks.ts:68` | Execute check command with timeout |
| `runAllChecks` | Function | `src/services/checks.ts:138` | Orchestrate all checks (detect → load → match → run) |

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
- **NEVER hardcode model names** — read from config (`model` key in `~/.commit-mint`)
- **NEVER add lint-staged dependency** — project uses .cmintrc.js for pre-commit checks

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

- `generateMessage()` delegates to `src/services/ai.ts` — fully implemented with Groq SDK, 3-tier diff compression (full → strip context → per-hunk cap → file summary), conventional commit regex validation with retry on failure
- Commit flow includes message review step (use-as-is / edit / cancel) before attempting commit
- `--hint/-H` flag passes user context to AI prompt alongside diff
- `--debug/-d` flag enables timestamped stderr logging via `src/utils/debug.ts`
- `vision.md` lists files that don't exist yet: `src/ui/display.ts`, `src/utils/platform.ts`, `src/commands/retry.ts` (retry is a flag in commit.ts, not a separate command)
- Config file path: `~/.commit-mint` (not `~/.config/commit-mint`)
- Cache path: `~/.cache/commit-mint/`
- Clipboard tries commands in order: wl-copy → xclip → xsel → pbcopy
- Recovery menu is recursive — re-stage failure re-shows the menu
- `getStagedDiff` excludes: package-lock.json, node_modules, dist, build, .next, coverage, *.log, *.min.js, *.min.css, *.lock, .DS_Store
- No CI/CD pipeline — published npm package with no GitHub Actions workflows
- `getRepoRoot` is statically imported but also dynamically re-imported in `commit.ts` (lines 33, 170) — redundant
- Package bin output: `dist/cli.mjs` (explicit ESM extension)
