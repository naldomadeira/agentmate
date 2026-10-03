---
name: codex-teamlead
description: Runs OpenAI Codex as a team lead for a broad, multi-part objective. Codex plans it, delegates pieces to Claude as child jobs, reviews them and reports back. Use when the work spans several tasks you want one coordinator to own, not for a single question or review.
---

You start and supervise a Codex team lead through the Agents Bridge `bridge_teamlead` tool. Codex decomposes the objective, delegates subtasks to Claude as child jobs, reviews the results and writes a final report. You brief it, follow it, and verify what it delivers.

## Tool

Use `bridge_teamlead` with `provider: "codex"`, `objective`, and optionally `constraints`, `context` and `mode` (read-only by default). It returns the lead's job id immediately. Follow it with `bridge_observe` (shows the lead's output and its child jobs with status) and collect the report with `bridge_wait` or `bridge_result`. `bridge_list` with `parent` set to the lead's id lists the children. Without the `bridge_*` tools: `npx -y agents-bridge-mcp jobs start codex "<briefing>" --role teamlead`, then `jobs observe <id>`, `jobs wait <id> --timeout 10m` and `jobs result <id>`.

## Before you start

- Confirm the work is broad enough to justify several model runs. For one question or one review, use `codex-teammate` or `codex-reviewer`.
- A Codex team lead runs with the `danger-full-access` sandbox so it can start worker processes and write job state in `~/.agents-bridge`. Tell the user this before starting it.
- Use `mode: "write"` only with the user's explicit permission to edit files. At most one write job runs per working tree at a time.
- Only a top-level session can start a team lead. If you are already a delegated worker, stop and tell the caller.

## How to work

1. **Brief the lead.** Give the objective as an outcome with a definition of done, the constraints (off-limits files, time budget, write or not) and context it cannot discover itself, such as decisions already made. It has no memory of this session.
2. **Follow the tree.** Check `bridge_observe` when the caller asks for progress; routine polling is noise. Do other work while you wait.
3. **Read the report.** It has Objective, Plan, Delegations (id, provider, role, status), Findings, Decisions, Deliverables and Open questions.
4. **Verify.** Open the child results you rely on with `bridge_result`, and check the deliverables against the working tree (`git status`, `git diff`, tests).
5. **Synthesize.** Tell the caller what was achieved, what was decided and why, what you verified, and what is still open. Never forward the raw report.

## Errors and timeouts

- A wait that expires does not stop the lead: call `bridge_wait` again with the same id.
- If the lead stalls or goes off track, `bridge_cancel` it, then use `bridge_list` with `parent` to find and cancel children still running. Report what completed.
- If the lead timed out, read its partial report with `bridge_result` and start a narrower team lead for the remaining work.
- On failure, report the error and suggest `npx -y agents-bridge-mcp doctor`.

## Principles

- You own acceptance. A team lead's claim of completion is not proof.
- Do not edit the working tree while a write job is running in it.
