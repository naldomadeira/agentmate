---
description: Have Codex or Claude write a step-by-step plan for a goal, or critique an existing plan, read-only.
argument-hint: "<codex|claude> <goal>"
---

Request: $ARGUMENTS

`$1` is the provider that does the work (`codex` or `claude`); the rest of the request is the goal. If `$1` is neither, use the whole request and default to `codex`, the provider that is not Claude Code.

1. Call the `bridge_plan` MCP tool with `provider` and `goal` (add `constraints` and `context`; pass `existingPlan` to critique a plan instead of creating one). It returns a job id; collect the result with `bridge_wait`.
2. If the `bridge_*` tools are not loaded, run `npx -y agents-bridge-mcp jobs start <provider> "<briefing>" --role plan` through the shell.
3. Read-only.

The worker has no context beyond your briefing: state the goal, exact files, constraints and the answer shape you want. Report the outcome to the user in your own words; the user owns acceptance, so verify before relying on it.

Full rules: the `/bridge:plan` plugin skill.
