---
name: teamlead
description: Hand a broad objective to Codex, Claude, Gemini or Antigravity (the last two experimental) acting as team lead, which breaks it down and delegates pieces to the other model as child jobs. Use when the user says /mate:teamlead, 'run a team lead', 'let codex lead this', 'coloque o claude como líder', or has multi-part work that needs one coordinating owner.
argument-hint: "<codex|claude|gemini|agy> <objective>"
---

# Run a team lead

A team lead is a job whose worker plans the objective, delegates subtasks to its **partner** through the CLI, reviews what comes back and reports. You start it, then watch it. You stay the owner of the outcome.

```
your session -> teamlead job (depth 0, started by you) -> child jobs (depth 1, cannot start jobs)
```

## How to run it

1. **MCP (preferred)** — call `mate_teamlead` with `provider` (who leads), `objective`, optional `partner` (the agent it delegates to; default: the first installed other agent, which must be installed), `constraints`, `effort`, `model`, `account` (Codex only) and `context`. Read-only by default; pass `mode: write` only if the user authorized edits. It returns the lead's job id.
2. **CLI fallback**:

   ```bash
   npx -y agentmate jobs start <provider> "<objective briefing>" --role teamlead [--effort <e>] [--account <acc>]
   ```

3. **Follow it** — `mate_observe <id>` (CLI `jobs observe <id>`) shows the lead's output and its child jobs with status; `mate_list` with `parent` set to the id lists only the children. Collect the final report with `mate_wait` / `mate_result`.

## Write the briefing

- The objective as an outcome with a definition of done, not a task list. The lead decomposes it.
- Constraints: what is off limits, time budget, whether write jobs are allowed.
- Context the lead cannot discover: decisions already made, conventions, why this matters.

## Treat the result

- The report has Objective, Plan, Delegations (id, provider, role, status), Findings, Decisions, Deliverables and Open questions. Check each deliverable yourself.
- Use the delegation table to open any child result with `mate_result` when a claim needs verifying.
- If the lead stopped early or went off track, `mate_cancel` it, then check `mate_list` with `parent` set to its id and cancel any child that is still running.

## Rules

- When you resume a turn with jobs in progress, call `mate_inbox` before `mate_wait`: it reports what finished or failed since you last looked.
- The depth limit is 2: the runtime refuses a third level and refuses a team lead started by a worker. A read-only team lead cannot start `write` children.
- Codex team leads run with the `danger-full-access` sandbox in either mode, because they must start worker processes and write job state in `~/.agentmate`. In read-only mode the runtime refuses `write` children and the prompt forbids edits, but the lead itself is not sandboxed. Tell the user this before starting one, and prefer `claude` as lead when that is a concern.
- A `gemini` lead (experimental) is accepted only with `mode: write`, because delegating needs the shell, which Gemini allows only with `--approval-mode yolo`; that mode approves every tool call, so tell the user before starting one. Prefer `claude` or `codex` as lead.
- An `agy` lead (experimental) is likewise accepted only with `mode: write`, because delegating needs the shell, which headless agy allows only with `--dangerously-skip-permissions`; that flag skips every permission check, so tell the user before starting one.
- The lead calls the CLI pinned to the installed version (`npx -y agentmate@<version> jobs ...`), so an unpublished local checkout must be published or linked for team lead mode to work.
- At most one `write` job per working tree at a time, across the whole tree of jobs.
- A team lead costs several model runs. Use `ask`, `review` or `delegate` when one job is enough.
