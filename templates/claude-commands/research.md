---
description: Have Codex or Claude investigate a topic read-only and report findings and a recommendation.
argument-hint: "<codex|claude|gemini|agy> <topic>"
---

Request: $ARGUMENTS

`$1` is the provider that does the work (`codex`, `claude`, `gemini` or `agy`; the last two are experimental); the rest of the request is the topic. If `$1` is neither, use the whole request and default to `codex`, the provider that is not Claude Code.

1. Call the `mate_research` MCP tool with `provider` and `topic` (add `questions`, `scope` and `context`). It returns a job id; collect the result with `mate_wait`.
2. If the `mate_*` tools are not loaded, run `npx -y agentmate jobs start <provider> "<briefing>" --role research` through the shell.
3. Read-only. Research can take minutes, so do other work while it runs.

The worker has no context beyond your briefing: state the goal, exact files, constraints and the answer shape you want. Report the outcome to the user in your own words; the user owns acceptance, so verify before relying on it.

Full rules: the `/mate:research` plugin skill.
