---
name: teamlead
description: Hand a broad objective to Codex or Claude acting as team lead, which breaks it down and delegates pieces to the other model as child jobs. Use for multi-part work where you want one owner to coordinate.
argument-hint: "<codex|claude> <objective>"
---

# Run a team lead

A team lead is a job whose worker plans the objective, delegates subtasks to the **other** provider through the CLI, reviews what comes back and reports. You start it, then watch it. You stay the owner of the outcome.

```
your session -> teamlead job (depth 0, started by you) -> child jobs (depth 1, cannot start jobs)
```

## How to run it

1. **MCP (preferred)** — call `bridge_teamlead` with `provider` (who leads), `objective`, optional `constraints` and `context`. Read-only by default; pass `mode: write` only if the user authorized edits. It returns the lead's job id.
2. **CLI fallback**:

   ```bash
   npx -y agents-bridge-mcp jobs start <provider> "<objective briefing>" --role teamlead
   ```

3. **Follow it** — `bridge_observe <id>` (CLI `jobs observe <id>`) shows the lead's output and its child jobs with status; `bridge_list` with `parent` set to the id lists only the children. Collect the final report with `bridge_wait` / `bridge_result`.

## Write the briefing

- The objective as an outcome with a definition of done, not a task list. The lead decomposes it.
- Constraints: what is off limits, time budget, whether write jobs are allowed.
- Context the lead cannot discover: decisions already made, conventions, why this matters.

## Treat the result

- The report has Objective, Plan, Delegations (id, provider, role, status), Findings, Decisions, Deliverables and Open questions. Check each deliverable yourself.
- Use the delegation table to open any child result with `bridge_result` when a claim needs verifying.
- If the lead stopped early or went off track, `bridge_cancel` it, then check `bridge_list` with `parent` set to its id and cancel any child that is still running.

## Rules

- The depth limit is 2: the runtime refuses a third level and refuses a team lead started by a worker. A read-only team lead cannot start `write` children.
- Codex team leads run with the `danger-full-access` sandbox in either mode, because they must start worker processes and write job state in `~/.agents-bridge`. In read-only mode the runtime refuses `write` children and the prompt forbids edits, but the lead itself is not sandboxed. Tell the user this before starting one, and prefer `claude` as lead when that is a concern.
- The lead calls the CLI pinned to the installed version (`npx -y agents-bridge-mcp@<version> jobs ...`), so an unpublished local checkout must be published or linked for team lead mode to work.
- At most one `write` job per working tree at a time, across the whole tree of jobs.
- A team lead costs several model runs. Use `ask`, `review` or `delegate` when one job is enough.
