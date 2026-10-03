---
name: jobs
description: List, observe, collect or cancel background jobs started through Agents Bridge. Use when the user says /bridge:jobs, 'is the job done', 'list my jobs', 'cancel that job', 'ver os jobs', or needs a job id or a stored result.
argument-hint: "[list|observe|result|cancel] [id]"
---

# Manage jobs

Jobs are durable: they keep running and their results stay stored after the session that started them ends. This skill is the control surface for them. With no argument, list recent jobs.

## Verbs

| Verb      | MCP tool         | CLI                                          |
| --------- | ---------------- | -------------------------------------------- |
| `list`    | `bridge_list`    | `npx -y agents-bridge-mcp jobs list`         |
| `observe` | `bridge_observe` | `npx -y agents-bridge-mcp jobs observe <id>` |
| `result`  | `bridge_result`  | `npx -y agents-bridge-mcp jobs result <id>`  |
| `cancel`  | `bridge_cancel`  | `npx -y agents-bridge-mcp jobs cancel <id>`  |
| wait      | `bridge_wait`    | `npx -y agents-bridge-mcp jobs wait <id>`    |

Prefer the MCP tool when it is loaded; use the CLI otherwise.

## How to use each

- **list** — `bridge_list` accepts `cwd`, `limit` and `parent` (only children of that team lead job). The CLI takes `--cwd` and `--parent <id>`. Children of a team lead appear indented under it. Use it to recover an id after a restart.
- **observe** — non-blocking snapshot of status and recent output; for a team lead it also lists child jobs. Run it when the user asks for progress, not on a timer.
- **result** — the stored final output, without waiting. Use it after an interrupted `wait`.
- **cancel** — stops the job and keeps the output produced so far. Cancel only when the user asks or the job is clearly stuck or wrong.
- **wait** — blocks until done or the wait expires. Expiry does not stop the job. CLI exit codes: `0` done, `1` failed or canceled, `2` still running.

## Rules

- Do not substitute the result of one job for another; match ids exactly.
- After cancelling a team lead, run `list --parent <id>` and cancel any child job that is still running.
- A job with status `timeout` and a saved session can be resumed with a new job that continues it (`continue` / `--continue <id>`).
- Report job state to the user briefly: id, role, provider, status, and what you will do next.
