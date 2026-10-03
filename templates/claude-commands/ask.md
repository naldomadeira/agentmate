---
description: Ask Codex or Claude a direct question and get the answer in the same turn.
argument-hint: "<codex|claude|gemini|agy> <question>"
---

Request: $ARGUMENTS

`$1` is the provider that does the work (`codex`, `claude`, `gemini` or `agy`; the last two are experimental); the rest of the request is the question. If `$1` is neither, use the whole request and default to `codex`, the provider that is not Claude Code.

1. Call the `mate_ask` MCP tool with `provider` and `question` (add `context` for background). It waits for the answer.
2. If the `mate_*` tools are not loaded, run `npx -y agentmate jobs ask <provider> "<question>" --wait 120s` through the shell.
3. Read-only. Never put secrets in the question.

The worker has no context beyond your briefing: state the goal, exact files, constraints and the answer shape you want. Report the outcome to the user in your own words; the user owns acceptance, so verify before relying on it.

Full rules: the `/mate:ask` plugin skill.
