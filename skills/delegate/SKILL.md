---
name: delegate
description: Delegate a task to another agent CLI (codex or claude) as a background job — second opinions, reviews, research, scoped implementation. Use when the user asks to hand work to Codex or Claude, or wants an independent opinion from a different model.
argument-hint: "<codex|claude> <task>"
---

# Delegate to another agent

Jobs run in a detached process, so they survive the end of this session and never block it.
Use the `bridge_*` MCP tools when they are available; otherwise use the same verbs through the CLI
(`npx -y agents-bridge-mcp jobs <verb>`). Do not try to register an MCP server or edit host
configuration when MCP is unavailable.

## Workflow

1. **Brief** — the worker has no context besides your prompt. State the goal, the files or diff to look at,
   and the shape of the answer you want.
2. **Start** — `bridge_start` (CLI: `npx -y agents-bridge-mcp jobs start <provider> "<prompt>"`). Default mode is `read-only`;
   pass `mode: write` only when the task must edit files, and say so in the briefing.
3. **Wait** — `bridge_wait` (CLI: `npx -y agents-bridge-mcp jobs wait <id>`). Expiring a wait does **not** stop the job; call it again.
   Do other independent work in between instead of polling.
4. **Result** — `bridge_wait` returns the result for the same id when it completes. Use `bridge_result`
   (CLI: `npx -y agents-bridge-mcp jobs result <id>`) after an interrupted wait. Do not substitute a
   result from another job.
5. **Assess** — read the result critically and integrate or follow up. You own acceptance and delivery,
   not the worker.

## Rules

- Ask for progress (`bridge_observe`, CLI: `npx -y agents-bridge-mcp jobs observe <id>`) only when the user asks; routine updates are noise.
- `bridge_cancel` (CLI: `npx -y agents-bridge-mcp jobs cancel <id>`) stops a job and keeps its partial output.
- A `timeout` job with a session can be resumed: start a new job with `continue: <id>`.
- Parallel jobs are for independent tasks. Two `write` jobs in one working tree will collide — use separate worktrees.
- CLI `wait` exits `0` done, `1` failed/canceled, `2` still running. Never pipe its output: a pipe loses the exit code.
- Delegation depth is 1: a delegated worker must not start jobs of its own.
