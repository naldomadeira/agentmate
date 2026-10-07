---
description: Have Codex or Claude write a step-by-step plan for a goal, or critique an existing plan, read-only.
argument-hint: "<codex|claude|gemini|agy|copilot> <goal>"
---

Request: $ARGUMENTS

Take the first word of the request as the provider (`codex`, `claude`, `gemini` or `agy`; the last two are experimental); the rest is the goal. If the first word is neither, use the whole request and default to `claude`, the provider that is not Codex.

1. Call the `mate_plan` MCP tool with `provider` and `goal` (add `constraints` and `context`; pass `existingPlan` to critique a plan instead of creating one). It returns a job id; collect the result with `mate_wait`.
2. If the `mate_*` tools are not loaded, run `npx -y agentmate jobs start <provider> "<briefing>" --role plan` in the shell.
3. Read-only.

The worker has no context beyond your briefing: state the goal, exact files, constraints and the answer shape you want. Report the outcome to the user in your own words; the user owns acceptance, so verify before relying on it.

Full rules: the `$mate:plan` skill.
