---
description: Put Codex or Claude in charge of a broad objective; it delegates pieces to the other model and reports.
argument-hint: "<codex|claude> <objective>"
---

Request: $ARGUMENTS

`$1` is the provider that does the work (`codex` or `claude`); the rest of the request is the objective. If `$1` is neither, use the whole request and default to `codex`, the provider that is not Claude Code.

1. Call the `bridge_teamlead` MCP tool with `provider` (who leads), `objective`, and optional `constraints` and `context`. Read-only unless the user authorized `mode: write`. It returns the lead's job id; follow it with `bridge_observe` and collect it with `bridge_wait`.
2. If the `bridge_*` tools are not loaded, run `npx -y agents-bridge-mcp jobs start <provider> "<briefing>" --role teamlead` through the shell.
3. A Codex lead runs with `danger-full-access`, so tell the user and prefer `claude` as lead when that matters. Use it only for multi-part work.

The worker has no context beyond your briefing: state the goal, exact files, constraints and the answer shape you want. Report the outcome to the user in your own words; the user owns acceptance, so verify before relying on it.

Full rules: the `/agents-bridge:teamlead` plugin skill.
