---
name: cmint
description: AI-powered commit message generation and auto-grouping. Use cmint --agent for non-interactive JSON-output commits in CI pipelines or coding agent workflows.
---

# cmint Agent Skill

Use `cmint --agent` to automate git commits with AI-generated messages and logical file grouping.

## When to use
- Making commits after finishing a task
- Staging and committing multiple changes at once
- Needing conventional commit messages from diffs

## Agent Interface Reference

| Flag | Description |
|------|-------------|
| `--agent` | Auto-group, AI generates, no review, JSON output |
| `--agent --message "msg"` | Single-commit mode using provided message |
| `--agent --noCheck` | Skip user-defined pre-commit checks |
| `--agent --hint "..."` | Pass context/instructions to AI |
| `--agent --debug` | Log verbose diagnostic info to stderr |

**Note**: `--agent --retry` is incompatible and will exit with error.

## JSON Output Schema
Returns a single JSON object to stdout:

```json
{
  "status": "success",
  "commits": [
    {
      "message": "feat: add user auth",
      "hash": "abc1234",
      "files": ["src/auth.ts"]
    }
  ],
  "errors": []
}
```
Statuses: `success`, `no_changes`, `failure`.

## Exit Codes
- 0: Success
- 1: Generic error
- 2: No changes staged/detected
- 3: Git operation failure
- 4: AI generation failure
- 5: User check failure
- 6: Hook failure

## Installation
```bash
npx skills add kyubiware/commit-mint
```

## Example Agent Workflow
1. Agent finishes code changes.
2. Agent calls `cmint --agent --hint "implement login feedback"`.
3. Agent parses JSON output to verify commit hashes and messages.
4. If `status` is `failure`, agent reads `errors` array to troubleshoot.
