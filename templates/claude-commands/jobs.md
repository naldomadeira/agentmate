---
description: List, observe, collect or cancel background jobs started through Agents Bridge.
argument-hint: "[list|observe|result|cancel] [id]"
---

Request: $ARGUMENTS

`$1` is the verb (`list`, `observe`, `result` or `cancel`); the rest is the job id. With no verb, list recent jobs.

- `list`: call `bridge_list` (optional `cwd`, `limit`, `parent`).
- `observe <id>`: call `bridge_observe` for a non-blocking progress snapshot.
- `result <id>`: call `bridge_result` for the stored output, without waiting.
- `cancel <id>`: call `bridge_cancel`, only when the user asked or the job is clearly stuck.

If the `bridge_*` tools are not loaded, run `npx -y agents-bridge-mcp jobs <verb> [id]` through the shell. Match ids exactly and report id, role, provider and status briefly. Jobs outlive the session that started them, and the user owns acceptance of any result.

Full rules: the `/bridge:jobs` plugin skill.
