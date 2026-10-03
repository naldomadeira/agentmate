---
description: Have Codex or Claude review a diff, files or a plan, read-only, and report findings by severity.
argument-hint: "<codex|claude|gemini|agy> <target: diff, files or plan>"
---

Request: $ARGUMENTS

`$1` is the provider that does the work (`codex`, `claude`, `gemini` or `agy`; the last two are experimental); the rest of the request is the review target. If `$1` is neither, use the whole request and default to `codex`, the provider that is not Claude Code.

1. Call the `mate_review` MCP tool with `provider` and `target` (add `focus`, for example security or concurrency, and `context`). It returns a job id; collect the result with `mate_wait`.
2. If the `mate_*` tools are not loaded, run `npx -y agentmate jobs start <provider> "<briefing>" --role review` through the shell.
3. Read-only. Name the exact diff range or file paths in `target`.

The worker has no context beyond your briefing: state the goal, exact files, constraints and the answer shape you want. Report the outcome to the user in your own words; the user owns acceptance, so verify before relying on it.

Full rules: the `/mate:review` plugin skill.
