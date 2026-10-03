---
description: List, observe, collect or cancel background jobs started through AgentMate.
argument-hint: "[list|observe|events|result|cancel] [id]"
---

Request: $ARGUMENTS

`$1` is the verb (`list`, `observe`, `events`, `result` or `cancel`); the rest is the job id. With no verb, list recent jobs.

- `list`: call `mate_list` (optional `cwd`, `limit`, `parent`).
- `observe <id>`: call `mate_observe` for a non-blocking progress snapshot of filtered events; pass `raw: true` only when the raw stdout/stderr tails are needed.
- `events <id>`: call `mate_events` for the job's event log (optional `since`, `levels`).
- `result <id>`: call `mate_result` for the stored output, without waiting.
- `cancel <id>`: call `mate_cancel`, only when the user asked or the job is clearly stuck.

When you resume a turn with jobs in progress, call `mate_inbox` before `mate_wait`: it reports what finished or failed since you last looked.

If the `mate_*` tools are not loaded, run `npx -y agentmate jobs <verb> [id]` through the shell. Match ids exactly and report id, role, provider and status briefly. Jobs outlive the session that started them, and the user owns acceptance of any result.

Full rules: the `/mate:jobs` plugin skill.
