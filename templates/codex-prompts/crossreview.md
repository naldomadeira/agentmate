---
description: Have one agent implement a change and the other review it, looping on findings until the reviewer approves.
argument-hint: "<codex|claude|gemini> <task>"
---

Request: $ARGUMENTS

Take the first word of the request as the provider that implements (`codex`, `claude` or `gemini`, which is experimental); the other one reviews. The rest is the task. If the first word is neither, use the whole request and default to `claude`, the provider that is not Codex.

1. Call the `mate_crossreview` MCP tool with `provider`, `task`, and optional `partner`, `acceptance` and `maxRounds` (1 to 5, default 2). It edits files, so use it only when the user authorized that. It returns the workflow's job id; follow it with `mate_observe` and collect it with `mate_wait`.
2. If the `mate_*` tools are not loaded, run `npx -y agentmate jobs start <provider> "<briefing>" --role crossreview [--max-rounds N]` in the shell.
3. The report has the rounds table, the final review and the changes. `## Needs human` means the reviewer gave no verdict; read it and decide.

The workers have no context beyond your briefing: state the goal, exact files, acceptance criteria and constraints. Report the outcome to the user in your own words; the user owns acceptance, so run the tests and check `git diff` before relying on it.

Full rules: the `$mate:crossreview` skill.
