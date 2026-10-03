---
description: Split a goal into independent parts that both agents work on in parallel, cross-reviewed, with integration steps.
argument-hint: "<codex|claude|gemini> <goal>"
---

Request: $ARGUMENTS

`$1` is the provider that plans the split (`codex`, `claude` or `gemini`, which is experimental); both agents run the parts and the other one reviews each. The rest of the request is the goal. If `$1` is neither, use the whole request and default to `codex`, the provider that is not Claude Code.

1. Call the `mate_split` MCP tool with `provider`, `goal`, and optional `partner` (the other agent), `acceptance`, `maxParts` (2 to 4, default 3) and `mode`. The default `read-only` researches the parts; `write` implements each in its own git worktree and branch, so use it only when the user authorized edits. It returns the workflow's job id; follow it with `mate_observe` and collect it with `mate_wait`.
2. If the `mate_*` tools are not loaded, run `npx -y agentmate jobs start <provider> "<goal>" --role split [--max-parts N] [--mode write]` through the shell.
3. The report has the parts table, the integration steps and `## Needs human`. Nothing is merged for you; conflicts are not resolved automatically. Write mode needs a git repository with a clean working tree; each part gets its own worktree and branch, committed automatically, with no `node_modules` or `.env`.

The workers have no context beyond your goal: state the files, constraints and acceptance criteria. Report the outcome to the user in your own words; the user owns acceptance, so run the tests before relying on it.

Full rules: the `/mate:split` plugin skill.
