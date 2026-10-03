---
name: crossreview
description: Have one agent implement a scoped change and the other agent review it, looping on the findings without you relaying anything by hand. Use when the user says /mate:crossreview, 'cross-review', 'cross review this', 'revisão cruzada', 'implementa e o outro revisa', 'codex implementa e o claude revisa', or wants one agent to build and the other to check the work.
argument-hint: "<codex|claude> <task>"
---

# Cross-review

A crossreview job is a workflow: the provider you name **implements** (write mode), the **other** agent **reviews** the uncommitted diff read-only, and when the reviewer asks for changes the implementer continues its own session with the findings. You start it once and read one report.

```
implement (A, write) -> review (B, read-only) -> Verdict: approve          -> done
                                              -> Verdict: request-changes -> A revises -> review again
```

## How to run it

1. **MCP (preferred)** — call `mate_crossreview` with `provider` (who implements), `task`, optional `acceptance`, `maxRounds` (1 to 5, default 2), `cwd`, `model`, `timeoutMinutes`. It returns the workflow's job id; follow it with `mate_observe`, collect it with `mate_wait` / `mate_result`. `mate_start` with `role: crossreview` works too.
2. **CLI fallback**:

   ```bash
   npx -y agentmate jobs start <provider> "<task briefing>" --role crossreview [--max-rounds 3] --cwd .
   npx -y agentmate jobs wait <id> --timeout 10m
   ```

   `wait` exits `0` done, `1` failed or canceled, `2` still running (repeat it).

## Write the briefing

- The task as a complete, scoped change, plus `acceptance`: what makes it done and which checks must pass.
- The files involved and what is out of scope. One change per run; split broad work with `teamlead`.
- Both agents see the repository, not this conversation.

## Treat the result

- `## Rounds` is a table: round, implement job, review job, verdict (`approve`, `request-changes` or `none`). `## Final review` is the last review, `## Changes` the last implementer report.
- `## Needs human` means the reviewer gave no clear verdict: the loop stopped on purpose. Read the final review and decide.
- "Round budget exhausted" means the reviewer still wanted changes; the latest edits are in the tree. Read the findings before accepting.
- Open any step with `mate_result <child-id>` (`jobs result <id>`). Run `git diff` and the tests yourself before you accept.

## Rules

- When you resume a turn with jobs in progress, call `mate_inbox` before `mate_wait`: it reports what finished or failed since you last looked.
- It edits files: the implementer runs in **write mode**. Use it only when the user authorized edits, and keep one write job per working tree.
- Only a top-level session can start it; a worker cannot. `model` applies to the implementer only.
- The reviewer reads the uncommitted diff, so do not commit between rounds. `mate_cancel` stops the workflow and its running child.
- A cross-review costs at least two model runs per round. For one opinion on existing code use `review`.
