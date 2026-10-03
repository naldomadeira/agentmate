---
name: delegate
description: Delegate a task to another agent CLI (codex, claude or gemini, experimental) as a background job, covering second opinions, reviews, research and scoped implementation. Use when the user says /mate:delegate, 'hand this to codex', 'delegue ao claude', or wants an independent opinion from a different model that fits no single role.
argument-hint: "<codex|claude|gemini> <task>"
---

# Delegate to another agent

Jobs run in a detached process, so they survive the end of this session and never block it.
Use the `mate_*` MCP tools when they are available; otherwise use the same verbs through the CLI
(`npx -y agentmate jobs <verb>`). Do not try to register an MCP server or edit host
configuration when MCP is unavailable.

This is the generic path. When the task fits a role, prefer the matching skill, which has a tuned prompt and its own rules:
`ask` (quick question), `review` (diff or plan review), `research` (investigation), `plan` (plan or critique),
`implement` (write access) and `teamlead` (broad objective delegated across both models). `teamlead`, `crossreview` and `split` take a `partner`, the other agent (default: the first installed one).
Use `delegate` for work that fits none of them, with `mate_start` and `role` left as `custom`.

## Workflow

1. **Brief** — the worker has no context besides your prompt. State the goal, the files or diff to look at,
   and the shape of the answer you want.
2. **Start** — `mate_start` (CLI: `npx -y agentmate jobs start <provider> "<prompt>" [--role <role>]`).
   Default mode is `read-only`; pass `mode: write` only when the task must edit files, and say so in the briefing.
3. **Wait** — `mate_wait` (CLI: `npx -y agentmate jobs wait <id>`). Expiring a wait does **not** stop the job; call it again.
   Do other independent work in between instead of polling.
4. **Result** — `mate_wait` returns the result for the same id when it completes. Use `mate_result`
   (CLI: `npx -y agentmate jobs result <id>`) after an interrupted wait. Do not substitute a
   result from another job.
5. **Assess** — read the result critically and integrate or follow up. You own acceptance and delivery,
   not the worker.

## Rules

- Ask for progress (`mate_observe`, CLI: `npx -y agentmate jobs observe <id>`) only when the user asks; routine updates are noise.
- `mate_cancel` (CLI: `npx -y agentmate jobs cancel <id>`) stops a job and keeps its partial output.
- A `timeout` job with a session can be resumed: start a new job with `continue: <id>` (CLI: `--continue <id>`). Not available for `gemini` (experimental): start a new job with the full context.
- Parallel jobs are for independent tasks. Two `write` jobs in one working tree will collide — use separate worktrees.
- CLI `wait` exits `0` done, `1` failed/canceled, `2` still running. Never pipe its output: a pipe loses the exit code.
- Delegation depth limit is 2: a session starts a `teamlead` job, the team lead delegates to workers, and those workers cannot delegate further.
  A delegated worker that is not a team lead must not start jobs of its own. The runtime refuses a third level and refuses a team lead started by a worker.
