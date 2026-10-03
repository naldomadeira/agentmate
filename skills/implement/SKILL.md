---
name: implement
description: Delegate a scoped code change to Codex or Claude with write access, with acceptance criteria and verification. Use only when the user explicitly authorizes the other agent to edit files.
argument-hint: "<codex|claude> <task>"
---

# Delegate an implementation

This is the one skill that lets the worker **edit files**. Use it only when the user has explicitly said the other agent may change the working tree. If they have not, ask first.

## How to run it

1. **MCP (preferred)** — call `bridge_implement` with `provider`, `task`, optional `acceptance` (how to tell it is done) and `context`. It runs in write mode and returns a job id; collect it with `bridge_wait`.
2. **CLI fallback**:

   ```bash
   npx -y agents-bridge-mcp jobs start <provider> "<implementation briefing>" --role implement --mode write --cwd <dir>
   npx -y agents-bridge-mcp jobs wait <id> --timeout 10m
   ```

   `wait` exits `0` done, `1` failed or canceled, `2` still running (repeat it, do not start a duplicate). Read the output with `jobs result <id>`.

## Write the briefing

- The task, narrowly scoped: one change, named files or modules, what must not be touched.
- Acceptance criteria that can be checked: the test that must pass, the command that must succeed, the behavior that must change.
- Repository conventions the worker cannot guess (formatter, test runner, commit rules). The worker does not commit unless you ask.
- The working directory (`cwd`). Use a dedicated git worktree if you will keep editing yourself.

## Treat the result

- The worker reports changed files and how it validated. Do not trust the report: run `git status`, `git diff` and the project's tests yourself.
- Optionally run the `review` skill on the diff with the other provider before you accept it.
- You own acceptance and delivery. If the change is wrong, discard or fix it, or `continue` the job with specific corrections.

## Rules

- One `write` job per working tree at a time. Two writers in the same tree will collide; use separate worktrees for parallel edits.
- Do not edit the same files while the job runs.
- The codex sandbox for this role is `workspace-write`; Claude runs with `acceptEdits`. Neither commits or pushes unless the briefing says so, and you should rarely say so.
