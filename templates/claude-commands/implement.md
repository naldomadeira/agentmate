---
description: Have Codex or Claude implement a scoped change by editing files, only when you authorized edits.
argument-hint: "<codex|claude> <task>"
---

Request: $ARGUMENTS

`$1` is the provider that does the work (`codex` or `claude`); the rest of the request is the task. If `$1` is neither, use the whole request and default to `codex`, the provider that is not Claude Code.

1. Only if the user explicitly allowed edits, call the `mate_implement` MCP tool with `provider` and `task` (add `acceptance` and `context`). It always runs in write mode and returns a job id; collect it with `mate_wait`. If edits were not clearly authorized, ask first.
2. If the `mate_*` tools are not loaded, run `npx -y agentmate jobs start <provider> "<briefing>" --role implement` through the shell.
3. Write mode: run one write job per working tree at a time, and verify the diff and tests before accepting it.

The worker has no context beyond your briefing: state the goal, exact files, constraints and the answer shape you want. Report the outcome to the user in your own words; the user owns acceptance, so verify before relying on it.

Full rules: the `/mate:implement` plugin skill.
