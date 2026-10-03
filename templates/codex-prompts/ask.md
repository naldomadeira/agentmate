---
description: Ask Codex or Claude a direct question and get the answer in the same turn.
argument-hint: "<codex|claude> <question>"
---

Request: $ARGUMENTS

Take the first word of the request as the provider (`codex` or `claude`); the rest is the question. If the first word is neither, use the whole request and default to `claude`, the provider that is not Codex.

1. Call the `bridge_ask` MCP tool with `provider` and `question` (add `context` for background). It waits for the answer; pass `waitSeconds: 45` (Codex limits a tool call to about 60 seconds) and continue with `bridge_wait` if it has not arrived.
2. If the `bridge_*` tools are not loaded, run `npx -y agents-bridge-mcp jobs ask <provider> "<question>" --wait 120s` in the shell.
3. Read-only. Never put secrets in the question.

The worker has no context beyond your briefing: state the goal, exact files, constraints and the answer shape you want. Report the outcome to the user in your own words; the user owns acceptance, so verify before relying on it.

Full rules: the `$ask` skill.
