---
description: Have Codex or Claude investigate a topic read-only and report findings and a recommendation.
argument-hint: "<codex|claude> <topic>"
---

Request: $ARGUMENTS

Take the first word of the request as the provider (`codex` or `claude`); the rest is the topic. If the first word is neither, use the whole request and default to `claude`, the provider that is not Codex.

1. Call the `bridge_research` MCP tool with `provider` and `topic` (add `questions`, `scope` and `context`). It returns a job id; collect the result with `bridge_wait`.
2. If the `bridge_*` tools are not loaded, run `npx -y agents-bridge-mcp jobs start <provider> "<briefing>" --role research` in the shell.
3. Read-only. Research can take minutes, so do other work while it runs.

The worker has no context beyond your briefing: state the goal, exact files, constraints and the answer shape you want. Report the outcome to the user in your own words; the user owns acceptance, so verify before relying on it.

Full rules: the `$bridge:research` skill.
