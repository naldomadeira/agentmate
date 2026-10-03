---
name: implement
description: Delegate a scoped code change to Codex, Claude or Gemini (experimental) with write access, with acceptance criteria and verification. Use only when the user says /mate:implement, 'have codex implement this', 'peça ao claude para implementar', or otherwise explicitly authorizes the other agent to edit files.
argument-hint: "<codex|claude|gemini> <task>"
---

# Delegate an implementation

This is the one skill that lets the worker **edit files**. Use it only when the user has explicitly said the other agent may change the working tree. If they have not, ask first.

## How to run it

1. **MCP (preferred)** — call `mate_implement` with `provider`, `task`, optional `acceptance` (how to tell it is done) and `context`. It always runs in write mode (read-only is rejected) and returns a job id; collect it with `mate_wait`.
2. **CLI fallback**:

   ```bash
   npx -y agentmate jobs start <provider> "<implementation briefing>" --role implement --mode write --cwd <dir>
   npx -y agentmate jobs wait <id> --timeout 10m
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
- Gemini (experimental) runs `--approval-mode auto_edit`: it can edit files but not run shell commands, so it cannot run the tests or the build; run the verification yourself.
- The codex sandbox for this role is `workspace-write`; Claude runs with `acceptEdits` plus an allowlist for verification commands (`pnpm`, `npm`, `npx`, `yarn`, `bun`, `make`, `git add`, `git commit`, extendable with `AGENTMATE_CLAUDE_WRITE_TOOLS`). Neither commits or pushes unless the briefing says so, and you should rarely say so.
