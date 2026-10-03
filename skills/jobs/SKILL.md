---
name: jobs
description: List, observe, collect or cancel background jobs started through AgentMate. Use when the user says /mate:jobs, 'is the job done', 'list my jobs', 'cancel that job', 'ver os jobs', or needs a job id or a stored result.
argument-hint: "[list|observe|events|result|cancel] [id]"
---

# Manage jobs

Jobs are durable: they keep running and their results stay stored after the session that started them ends. This skill is the control surface for them. With no argument, list recent jobs.

## Verbs

| Verb      | MCP tool         | CLI                                          |
| --------- | ---------------- | -------------------------------------------- |
| `list`    | `mate_list`    | `npx -y agentmate jobs list`         |
| `observe` | `mate_observe` | `npx -y agentmate jobs observe <id>` |
| `events`  | `mate_events`  | `npx -y agentmate jobs events <id>`  |
| `result`  | `mate_result`  | `npx -y agentmate jobs result <id>`  |
| `cancel`  | `mate_cancel`  | `npx -y agentmate jobs cancel <id>`  |
| wait      | `mate_wait`    | `npx -y agentmate jobs wait <id>`    |

Prefer the MCP tool when it is loaded; use the CLI otherwise.

## How to use each

- **list** — `mate_list` accepts `cwd`, `limit` and `parent` (only children of that team lead job). The CLI takes `--cwd` and `--parent <id>`. Children of a team lead appear indented under it. Use it to recover an id after a restart.
- **observe** — non-blocking snapshot of status and recent events (`important` and `status` only, so it stays small); for a team lead it also lists child jobs. Add `raw` / `--raw` for the stdout/stderr tails, or `levels` / `--level fyi` for command-level detail. Run it when the user asks for progress, not on a timer.
- **events** — the job's event log, one line per event (`important`, `status`, `fyi`). Filter with `levels` / `--level`, read only what is new with `since` / `--since`, or stream with `--follow` until the job ends.
- **result** — the stored final output, without waiting. Use it after an interrupted `wait`.
- **cancel** — stops the job and keeps the output produced so far. Cancel only when the user asks or the job is clearly stuck or wrong.
- **wait** — blocks until done or the wait expires. Expiry does not stop the job. CLI exit codes: `0` done, `1` failed or canceled, `2` still running.

## Rules

- Do not substitute the result of one job for another; match ids exactly.
- After cancelling a team lead, run `list --parent <id>` and cancel any child job that is still running.
- A job with status `timeout` and a saved session can be resumed with a new job that continues it (`continue` / `--continue <id>`).
- A session (`mate_session_start`, CLI `sessions start`) is shared context across jobs and agents: pass its id as `session` / `--session <id>` when starting jobs, and every worker in it reads the notes (`mate_session_notes`, `sessions notes <id> "<text>"`) in its briefing, so keep them short and factual. `mate_session_show` / `sessions show <id>` lists the notes and the session's jobs; `mate_session_list` / `sessions list` finds ids.
- Report job state to the user briefly: id, role, provider, status, and what you will do next.
