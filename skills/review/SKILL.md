---
name: review
description: Get an independent code review of a diff, branch, files or a plan from Codex, Claude or Gemini (experimental), with findings ranked by severity. Use when the user says /mate:review, 'have codex review this', 'peça ao claude para revisar', or wants a second reviewer before merging.
argument-hint: "<codex|claude|gemini> [target] [focus]"
---

# Independent review

Ask the other model to review work you or the user produced. The first argument is the provider; `target` and `focus` follow. With no target, review the uncommitted work: the output of `git diff` (and `git diff --staged`) in the current working tree.

## How to run it

1. **MCP (preferred)** — call `mate_review` with `provider`, `target`, optional `focus` (for example "concurrency", "security", "public API compatibility") and optional `context`. It returns a job id immediately; collect the result with `mate_wait`. Pass `waitSeconds` to wait inside the same call.
2. **CLI fallback**:

   ```bash
   npx -y agentmate jobs start <provider> "<review briefing>" --role review
   npx -y agentmate jobs wait <id> --timeout 10m
   ```

   `wait` exits `0` done, `1` failed or canceled, `2` still running (repeat it). Read the output with `jobs result <id>`.

## Write the briefing

The reviewer sees the repository, not your conversation. State:

- the target: a git range (`main...HEAD`), file paths, or a description of the change;
- what the change is meant to do, so intent bugs can be found, not only syntax bugs;
- known constraints and what is out of scope;
- the focus, if any.

## Treat the result

- Findings come back ordered by severity with `file:line`, a failure scenario and a verdict (`approve` or `request-changes`).
- Verify each finding against the code before acting. Discard the ones you can show are wrong, and say why.
- You own the decision. Summarize accepted findings, rejected findings with reasons, and what you changed.

## Rules

- Review is read-only; the reviewer never edits files. To apply a fix, use the `implement` skill separately.
- For a large change, start one review per area (in parallel) instead of one giant prompt.
- A second review of your fixes is a new job; do not reuse an old result for new code.
