---
name: cursor
description: Route a task or question to the Cursor CLI, experimental (quick questions, reviews, research, plans, scoped implementation or a team lead) by picking the matching AgentMate tool. Use when the user says /mate:cursor, 'ask cursor', 'check with cursor', 'hand this to cursor', 'pergunte ao cursor', or names Cursor Agent.
argument-hint: "<task or question>"
---

# Work with the Cursor CLI (experimental)

Experimental; requires the `cursor-agent` CLI on PATH (or `AGENTMATE_CURSOR_BIN`). Needs `cursor-agent login` once. Check with `npx -y agentmate doctor`; a job on a missing agent is refused with an install hint (`curl https://cursor.com/install -fsS | bash`). Shortcut for "do this with cursor". Read the user's request, pick the role it matches and run the matching `mate_*` tool with `provider: cursor`. Do not ask the user which tool to use.

## Route by intent

| The user wants                                   | MCP tool         | Skill with the full rules |
| ------------------------------------------------ | ---------------- | ------------------------- |
| A direct answer or second opinion                | `mate_ask`       | `ask`                     |
| A review of a diff, files or a plan              | `mate_review`    | `review`                  |
| An investigation, comparison or root-cause hunt  | `mate_research`  | `research`                |
| A plan, or a critique of one                     | `mate_plan`      | `plan`                    |
| A code change (explicit permission to edit only) | `mate_implement` | `implement`               |
| A broad objective that needs coordination        | `mate_teamlead`  | `teamlead`                |
| Anything else                                    | `mate_start`     | `delegate`                |

When the request is ambiguous, default to `mate_ask` (read-only, answers in the same turn). Inside Codex, MCP tool calls time out after about 60 seconds by default: pass `waitSeconds: 45` to `mate_ask` and continue with `mate_wait` if the answer has not arrived. For a team lead, crossreview or split, `partner` picks the other agent.

## Limits (experimental)

The adapter runs `cursor-agent -p <prompt> --output-format stream-json`. It was written against the documented format and tested with a fake binary; the flags exist in the real CLI, but a full run was not verified.

- **Read-only**: `ask`, `review`, `plan` and `research` pass `--mode ask` and no `--force`. No shell, so a reviewer gets the diff inline.
- **Write mode**: `implement` passes `--force`, which allows every command unless denied. Run one write job at a time and review the diff.
- **No continuation**: `--resume` is unverified, so `continue` is refused; start a new job.
- **Team lead**: needs `mode: write`. **Effort**: refused; put it in the model id instead. **Models**: `cursor-agent --list-models`.
- **allowPush** is not available for cursor: push from the coordinator.

## CLI fallback

```bash
npx -y agentmate jobs ask cursor "<question>" --wait 120s
npx -y agentmate jobs start cursor "<briefing>" --role <review|research|plan|implement|teamlead>
npx -y agentmate jobs wait <id> --timeout 10m   # exit 0 done, 1 failed, 2 still running
```

## Briefing and result

- cursor has no memory of this session. Put the goal, the files or diff, constraints and the wanted answer shape in the briefing.
- Run read-only unless the user clearly authorized edits. Never use `mate_implement` or `mode: write` on an ambiguous request.
- Summarize the result in your own words, verify anything you will act on, and own the decision. Do not paste raw output.

## Examples

- `ask cursor how this module is wired` -> `mate_ask` with the files as `context`
- `review my recent changes with cursor` -> `mate_review` with `target` "HEAD~1..HEAD"
- `have cursor implement timeout handling in src/lib/exec.ts` -> `mate_implement`, after confirming edits are allowed
