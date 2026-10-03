---
description: Put Codex or Claude in charge of a broad objective; it delegates pieces to the other model and reports.
argument-hint: "<codex|claude|gemini|agy> <objective>"
---

Request: $ARGUMENTS

Take the first word of the request as the provider (`codex`, `claude`, `gemini` or `agy`; the last two are experimental); the rest is the objective. If the first word is neither, use the whole request and default to `claude`, the provider that is not Codex.

1. Call the `mate_teamlead` MCP tool with `provider` (who leads), `objective`, and optional `partner` (the agent it delegates to), `constraints` and `context`. Read-only unless the user authorized `mode: write`. It returns the lead's job id; follow it with `mate_observe` and collect it with `mate_wait`.
2. If the `mate_*` tools are not loaded, run `npx -y agentmate jobs start <provider> "<briefing>" --role teamlead` in the shell.
3. A Codex lead runs with `danger-full-access`, and a `gemini` lead needs `mode: write` and runs `--approval-mode yolo`, and an `agy` lead needs `mode: write` and runs `--dangerously-skip-permissions`, so tell the user and prefer `claude` as lead when that matters. Use it only for multi-part work.

The worker has no context beyond your briefing: state the goal, exact files, constraints and the answer shape you want. Report the outcome to the user in your own words; the user owns acceptance, so verify before relying on it.

Full rules: the `$mate:teamlead` skill.
