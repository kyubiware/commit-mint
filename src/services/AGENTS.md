# SERVICES KNOWLEDGE BASE

## OVERVIEW

External system interactions and business logic for cmint. 9 source modules, co-located tests.

## STRUCTURE

```
src/services/
├── ai.ts              # Multi-provider AI message generation, 4-tier diff compression
├── provider.ts        # Provider factory (Groq SDK, generic fetch for others)
├── git.ts             # Git operations via execa
├── hooks.ts           # Hook error parsing, 5 tool-specific parsers
├── hook-progress.ts   # Real-time hook progress parser
├── checks.ts          # User-defined pre-commit checks via cmint config files
├── grouping.ts        # AI file grouping into logical commits
├── config.ts          # INI config read/write at ~/.commit-mint
└── clipboard.ts       # Cross-platform clipboard shell-out
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add AI provider | `provider.ts` | Add to `PROVIDER_CONFIGS`, `PROVIDER_ENV_KEYS`, `isValidProvider()` |
| Change diff compression | `ai.ts` | Tiers 0-3 in `compressDiff()` |
| Change commit validation | `ai.ts` | Regex + retry in `generateCommitMessage()` |
| Parse new hook type | `hooks.ts` | Add parser, wire into `parseHookErrors()` |
| Change hook progress | `hook-progress.ts` | `[STARTED]`/`[COMPLETED]`/`[FAILED]` markers |
| Add check config format | `checks.ts` | `CONFIG_FILES` array, `loadConfig()` loader |
| Change glob matching | `checks.ts` | `matchFiles()` uses picomatch |
| Change file grouping | `grouping.ts` | `generateGroups()`, `validateGroups()` |
| Resolve model per provider | `config.ts` | `getModelForProvider()` chain: provider key → global → default |
| Change API key lookup | `config.ts` | `getProviderApiKey()` checks env first, then INI |

## CODE MAP

| Symbol | Type | Location | Role |
|--------|------|----------|------|
| `generateCommitMessage` | Function | `ai.ts` | AI call with compression, validation, retry |
| `compressDiff` | Function | `ai.ts` | 4-tier compression (full → strip context → hunk cap → summary) |
| `createProvider` | Function | `provider.ts` | Factory: Groq SDK vs generic fetch client |
| `getStagedDiff` | Function | `git.ts` | Union return: `StagedDiffResult \| ExcludedFilesResult \| null` |
| `attemptCommit` | Function | `git.ts` | `git commit -m` with real-time stderr collection |
| `parseHookErrors` | Function | `hooks.ts` | Routes to 5 tool parsers + raw fallback |
| `parseToolChecks` | Function | `hooks.ts` | Post-commit success/failure summary |
| `runAllChecks` | Function | `checks.ts` | Detect → load → match → run pipeline |
| `generateGroups` | Function | `grouping.ts` | AI grouping with orphaned file validation |
| `getModelForProvider` | Function | `config.ts` | `model_groq` → `model` → provider default |
| `copyToClipboard` | Function | `clipboard.ts` | wl-copy → xclip → xsel → pbcopy |

## ANTI-PATTERNS (SERVICES)

- NEVER hardcode model names — use `getModelForProvider()` resolution chain
- NEVER include `/openai/v1/` in Groq baseURL (SDK appends it internally)
- NEVER modify hook parsers without testing all 5 (interleaved in `parseHookErrors`)
- NEVER add clipboard dependencies — shell out to platform tools
- NEVER add lint-staged dependency — project uses cmint config files
- Config path: `~/.commit-mint` (NOT `~/.config/commit-mint`)
- Cache path: `~/.cache/commit-mint/<sha256-prefix>.json`
- Non-Groq providers use fetch client that appends `/chat/completions` directly
