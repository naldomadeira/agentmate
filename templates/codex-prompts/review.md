---
description: Have Codex or Claude review a diff, files or a plan, read-only, and report findings by severity.
argument-hint: "<codex|claude> <target: diff, files or plan>"
---

Request: $ARGUMENTS

Take the first word of the request as the provider (`codex` or `claude`); the rest is the review target. If the first word is neither, use the whole request and default to `claude`, the provider that is not Codex.

1. Call the `mate_review` MCP tool with `provider` and `target` (add `focus`, for example security or concurrency, and `context`). It returns a job id; collect the result with `mate_wait`.
2. If the `mate_*` tools are not loaded, run `npx -y agentmate jobs start <provider> "<briefing>" --role review` in the shell.
3. Read-only. Name the exact diff range or file paths in `target`.

The worker has no context beyond your briefing: state the goal, exact files, constraints and the answer shape you want. Report the outcome to the user in your own words; the user owns acceptance, so verify before relying on it.

Full rules: the `$mate:review` skill.
