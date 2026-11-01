---
name: grok
description: Route a task or question to xAI Grok Build, experimental (quick questions, reviews, research, plans, scoped implementation or a team lead) by picking the matching AgentMate tool. Use when the user says /mate:grok, 'ask grok', 'check with grok', 'hand this to grok', 'pergunte ao grok', or names xAI Grok.
argument-hint: "<task or question>"
---

# Work with Grok Build (experimental)

Experimental; requires the `grok` CLI on PATH (or `AGENTMATE_GROK_BIN`). Needs `grok login` once. Check with `npx -y agentmate doctor`; a job on a missing agent is refused with an install hint. Shortcut for "do this with grok". Read the user's request, pick the role it matches and run the matching `mate_*` tool with `provider: grok`. Do not ask the user which tool to use.

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

The adapter runs `grok -p <prompt> --output-format streaming-json`.

- **Read-only**: `ask`, `review`, `plan` and `research` pass `--disallowed-tools=write,search_replace,run_terminal_command,image_edit`. No shell, so a reviewer gets the diff inline in its briefing. Web search stays on.
- **Write mode**: `implement` runs with `--always-approve`, which approves every edit and shell command. Grok is the least restricted write agent: run one write job at a time and review the diff.
- **Continuation**: a finished job can be continued with `continue: <id>`; the runtime passes `--resume <session>`.
- **Team lead**: needs `mode: write` (delegation needs the shell).
- **Effort**: passes `--reasoning-effort`. **Models**: `grok models` lists them (`grok-4.7` is the default); `mate_models` reports no catalog.
- **allowPush** is not available for grok: push from the coordinator.

## CLI fallback

```bash
npx -y agentmate jobs ask grok "<question>" --wait 120s
npx -y agentmate jobs start grok "<briefing>" --role <review|research|plan|implement|teamlead>
npx -y agentmate jobs wait <id> --timeout 10m   # exit 0 done, 1 failed, 2 still running
```

## Briefing and result

- grok has no memory of this session. Put the goal, the files or diff, constraints and the wanted answer shape in the briefing.
- Run read-only unless the user clearly authorized edits. Never use `mate_implement` or `mode: write` on an ambiguous request.
- Summarize the result in your own words, verify anything you will act on, and own the decision. Do not paste raw output.

## Examples

- `ask grok whether this retry loop is safe` -> `mate_ask` with the code as `context`
- `review my recent changes with grok` -> `mate_review` with `target` "HEAD~1..HEAD"
- `have grok implement timeout handling in src/lib/exec.ts` -> `mate_implement`, after confirming edits are allowed
