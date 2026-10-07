---
name: codex
description: Route a task or question to OpenAI Codex (quick questions, reviews, research, plans, scoped implementation or a team lead) by picking the matching AgentMate tool. Use when the user says /mate:codex, 'ask codex', 'check with codex', 'hand this to codex', 'pergunte ao codex'.
argument-hint: "<task or question>"
---

# Work with OpenAI Codex

Shortcut for "do this with OpenAI Codex". Read the user's request, pick the role it matches and run the matching `mate_*` tool with `provider: codex`. Do not ask the user which tool to use.

## Route by intent

| The user wants                                   | MCP tool           | Skill with the full rules |
| ------------------------------------------------ | ------------------ | ------------------------- |
| A direct answer or second opinion                | `mate_ask`       | `ask`                     |
| A review of a diff, files or a plan              | `mate_review`    | `review`                  |
| An investigation, comparison or root-cause hunt  | `mate_research`  | `research`                |
| A plan, or a critique of one                     | `mate_plan`      | `plan`                    |
| A code change (explicit permission to edit only) | `mate_implement` | `implement`               |
| A broad objective that needs coordination        | `mate_teamlead`  | `teamlead`                |
| Anything else                                    | `mate_start`     | `delegate`                |

When the request is ambiguous, default to `mate_ask` (read-only, answers in the same turn).

## CLI fallback

If the `mate_*` tools are not loaded, use the same roles from a shell:

```bash
npx -y agentmate jobs ask codex "<question>" --wait 120s [--effort <e>] [--account <acc>]
npx -y agentmate jobs start codex "<briefing>" --role <review|research|plan|implement|teamlead> [--effort <e>] [--account <acc>]
npx -y agentmate jobs wait <id> --timeout 10m   # exit 0 done, 1 failed, 2 still running
```

## Briefing and result

- OpenAI Codex has no memory of this session. Put the goal, the files or diff, constraints and the wanted answer shape in the briefing; read referenced files first so you can name them exactly.
- Pass `effort` (`low`, `medium`, `high`, `xhigh`) for reasoning effort and `account` (profile under `~/.codex-profiles/<name>` or `auto`) to pick the Codex account.
- Run read-only unless the user clearly authorized edits. Never use `mate_implement` or `mode: write` on an ambiguous request.
- Summarize the result in your own words, verify anything you will act on, and own the decision. Do not paste raw output.

## Examples

- `review my recent changes` -> `mate_review` with `target` "HEAD~1..HEAD"
- `is my caching approach correct?` -> `mate_ask` with the question and the relevant files as `context`
- `find out how library X handles retries` -> `mate_research`
- `implement timeout handling in src/lib/exec.ts` -> `mate_implement`, after confirming edits are allowed
