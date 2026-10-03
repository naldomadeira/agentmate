---
name: split
description: Split a broad goal into independent parts that both agents work on in parallel, then cross-review each part and report how to integrate them. Use when the user says /mate:split, 'split the task', 'task splitting', 'split this between codex and claude', 'dividir a tarefa', 'divida o trabalho entre os agentes', or has a goal that breaks into parts with separate files.
argument-hint: "<codex|claude> <goal>"
---

# Split a task

A split job is a workflow: the provider you name **plans** the split, the parts run **in parallel** on both agents, the **other** agent **reviews** each finished part, and you read one report.

```
goal -> plan (1..maxParts parts, closed interfaces, no shared files)
     -> parts in parallel (A on codex, B on claude, ...)   read-only: research / write: one git worktree each
     -> cross-review of each part by the other agent       -> report + integration steps
```

## How to run it

1. **MCP (preferred)**: call `mate_split` with `provider` (who plans), `goal`, optional `acceptance`, `maxParts` (2 to 4, default 3), `mode` (`read-only` default or `write`), `session`, `cwd`, `model`, `timeoutMinutes`. It returns the workflow's job id; follow it with `mate_observe`, collect it with `mate_wait` / `mate_result`.
2. **CLI fallback**:

   ```bash
   npx -y agentmate jobs start <provider> "<goal>" --role split [--max-parts 3] [--mode write] --cwd .
   npx -y agentmate jobs wait <id> --timeout 10m
   ```

   `wait` exits `0` done, `1` failed or canceled, `2` still running (repeat it).

## Write the goal

- The whole outcome, the files or modules involved, constraints, and `acceptance` (which checks must pass).
- Parts must not share files. A goal that is one tangled change is better served by `crossreview`.
- Both agents see the repository, not this conversation. Put decisions that every part needs in a session note first (`mate_session_notes`).

## Modes

- **read-only (default)**: each part is a `research` job on the working directory; the report merges the findings. Use it to explore or plan a large change first.
- **write**: needs a git repository with a **clean working tree** (checked before the planner runs; commit or stash first) and the user's authorization to edit files. Each part starts from the recorded base commit in its own worktree `~/.agentmate/worktrees/<split-id>/<part>` on branch `agentmate/<split-id>/<part>`, so your tree stays untouched. Worktrees have no `node_modules`, `.env` or submodule contents. The workflow commits each part automatically (`--no-verify`, gpg signing off).

## Treat the result

- `## Parts` is a table: part, agent, part job, review job, verdict, branch. `## Needs human` lists parts that were not approved (`request-changes`, no verdict or a failure). A failed part ends the workflow `error`, after the other parts finish.
- The report lists every worktree and branch with cleanup commands. `## Integration` has the ordered `git merge agentmate/<split-id>/<part>` commands for **approved parts only**; the rest go under `## Needs human`. **Nothing is merged for you and conflicts are not resolved**; run the merges yourself, then the tests.
- Open any step with `mate_result <child-id>` (`jobs result <id>`). The plan is in the session notes (`mate_session_show`).

## Rules

- When you resume a turn with jobs in progress, call `mate_inbox` before `mate_wait`: it reports what finished or failed since you last looked.
- Only a top-level session can start it; a worker cannot. `mate_cancel` stops the workflow and its running children.
- It costs a plan, one job per part and one review per part. For one change use `implement`; for one opinion use `review`.
- In write mode run one split per working tree at a time and do not edit the repository meanwhile.
