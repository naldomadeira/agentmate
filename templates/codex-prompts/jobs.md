---
description: List, observe, collect or cancel background jobs started through AgentMate.
argument-hint: "[list|observe|result|cancel] [id]"
---

Request: $ARGUMENTS

Take the first word as the verb (`list`, `observe`, `result` or `cancel`); the rest is the job id. With no verb, list recent jobs.

- `list`: call `mate_list` (optional `cwd`, `limit`, `parent`).
- `observe <id>`: call `mate_observe` for a non-blocking progress snapshot.
- `result <id>`: call `mate_result` for the stored output, without waiting.
- `cancel <id>`: call `mate_cancel`, only when the user asked or the job is clearly stuck.

If the `mate_*` tools are not loaded, run `npx -y agentmate jobs <verb> [id]` in the shell. Match ids exactly and report id, role, provider and status briefly. Jobs outlive the session that started them, and the user owns acceptance of any result.

Full rules: the `$mate:jobs` skill.
